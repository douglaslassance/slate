import { execFile } from "child_process";
import { promisify } from "util";
import { stat, readdir } from "fs/promises";
import { join, extname } from "path";
import type { Shot } from "./ollama";
import type { SlateSettings } from "./settings";

const execFileAsync = promisify(execFile);

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp"]);

/** Maximum number of reference images the model can accept. */
const MAX_STYLE_IMAGES = 4;

export interface GeneratedImage {
	shot: Shot;
	/** Absolute path on disk to the generated PNG. */
	filePath: string;
}

/**
 * Resolve style image paths from a file or folder.
 * Returns an empty array if the path is empty or doesn't exist.
 * Caps at MAX_STYLE_IMAGES.
 */
async function resolveStyleImages(stylePath: string): Promise<string[]> {
	if (!stylePath) return [];

	let info;
	try {
		info = await stat(stylePath);
	} catch {
		console.warn("[Slate] Style image path not found:", stylePath);
		return [];
	}

	if (info.isFile()) {
		return [stylePath];
	}

	if (info.isDirectory()) {
		const entries = await readdir(stylePath);
		const images = entries
			.filter((f) => IMAGE_EXTENSIONS.has(extname(f).toLowerCase()))
			.sort()
			.slice(0, MAX_STYLE_IMAGES)
			.map((f) => join(stylePath, f));
		console.log(`[Slate] Found ${images.length} style image(s) in folder:`, images);
		return images;
	}

	return [];
}

/**
 * Build the mflux CLI argument string for a single shot.
 * When style images are provided, uses mflux-generate-flux2-edit with --image-paths.
 * Otherwise uses mflux-generate-flux2 for plain text-to-image generation.
 */
function buildCommand(
	executable: string,
	settings: SlateSettings,
	prompt: string,
	outputPath: string,
	styleImages: string[]
): string {
	const hasStyleImages = styleImages.length > 0;
	const activeExecutable = hasStyleImages
		? executable.replace("mflux-generate-flux2", "mflux-generate-flux2-edit")
		: executable;

	const args: [string, string][] = [
		["--model", settings.mfluxModel],
		["--prompt", prompt],
		["--output", outputPath],
		["--steps", String(settings.mfluxSteps)],
		["--width", String(settings.mfluxWidth)],
		["--height", String(settings.mfluxHeight)],
	];

	if (settings.mfluxQuantize !== null) {
		args.push(["--quantize", String(settings.mfluxQuantize)]);
	}

	if (hasStyleImages) {
		// --image-paths accepts multiple space-separated paths
		args.push(["--image-paths", styleImages.map(shellEscape).join(" ")]);
	}

	const argStr = args
		.map(([flag, value]) => `${flag} ${flag === "--image-paths" ? value : shellEscape(value)}`)
		.join(" ");

	return `${shellEscape(activeExecutable)} ${argStr}`;
}

function shellEscape(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Resolve the full path of mflux-generate-flux2 via a login shell.
 */
async function resolveMfluxExecutable(override: string): Promise<string> {
	if (override) return override;

	try {
		const { stdout: pathOut } = await execFileAsync("/bin/zsh", ["-l", "-c", "echo $PATH"], { timeout: 5000 });
		console.log("[Slate] Shell PATH:", pathOut.trim());

		const { stdout: which } = await execFileAsync("/bin/zsh", ["-l", "-c", "which mflux-generate-flux2"], { timeout: 5000 });
		const resolved = which.trim();
		console.log("[Slate] Resolved mflux-generate-flux2:", resolved);
		return resolved || "mflux-generate-flux2";
		// mflux-generate-flux2-edit is resolved by replacing the binary name at command build time.
	} catch (err) {
		console.warn("[Slate] Could not resolve mflux-generate-flux2 via login shell:", err);
		return "mflux-generate-flux2";
	}
}

/**
 * Generate storyboard images for a list of shots using mflux.
 * Runs through a login shell so the full user PATH is available.
 */
export async function generateStoryboardImages(
	shots: Shot[],
	outputDir: string,
	settings: SlateSettings,
	onProgress?: (message: string, index: number, total: number) => void,
	onImageGenerated?: (image: GeneratedImage) => Promise<void>,
	resolvedDescriptions?: string[]
): Promise<GeneratedImage[]> {
	const results: GeneratedImage[] = [];
	const executable = await resolveMfluxExecutable(settings.mfluxExecutable);
	const styleImages = await resolveStyleImages(settings.mfluxStyleImagePath);

	if (styleImages.length > 0) {
		console.log(`[Slate] Using ${styleImages.length} style image(s):`, styleImages);
	}

	for (let i = 0; i < shots.length; i++) {
		const shot = shots[i];
		const filename = `${settings.storyboardImageName.replace("#", String(shot.number))}.png`;
		const filePath = `${outputDir}/${filename}`;

		onProgress?.(`Generating image for shot ${shot.number}…`, i, shots.length);

		const description = resolvedDescriptions?.[i] ?? `${shot.action} ${shot.description}`;
		const prompt = settings.mfluxPromptHeader
			? `${settings.mfluxPromptHeader.trim()} ${description}`
			: description;
		const command = buildCommand(executable, settings, prompt, filePath, styleImages);

		try {
			await execFileAsync("/bin/zsh", ["-l", "-c", command], {
				timeout: 10 * 60 * 1000,
			});
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`mflux failed for shot ${shot.number}: ${msg}`);
		}

		const generated = { shot, filePath };
		await onImageGenerated?.(generated);
		results.push(generated);
	}

	return results;
}
