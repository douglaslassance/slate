import { execFile } from "child_process";
import { promisify } from "util";
import { stat, readdir } from "fs/promises";
import { join, extname } from "path";
import type { Shot } from "./ollama";
import type { SlateSettings } from "./settings";

const execFileAsync = promisify(execFile);

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp"]);

const MAX_STYLE_IMAGES = 4;

export interface GeneratedImage {
	shot: Shot;
	filePath: string;
}

async function resolveStyleImages(stylePath: string, vaultBasePath: string): Promise<string[]> {
	if (!stylePath) return [];

	const resolvedPath = stylePath.startsWith("/") ? stylePath : join(vaultBasePath, stylePath);

	let info;
	try {
		info = await stat(resolvedPath);
	} catch {
		console.warn("[Slate] Style image path not found:", resolvedPath);
		return [];
	}

	if (info.isFile()) {
		console.log("[Slate] Using single style image:", resolvedPath);
		return [resolvedPath];
	}

	if (info.isDirectory()) {
		const entries = await readdir(resolvedPath);
		const images = entries
			.filter((f) => IMAGE_EXTENSIONS.has(extname(f).toLowerCase()))
			.sort()
			.slice(0, MAX_STYLE_IMAGES)
			.map((f) => join(resolvedPath, f));
		console.log(`[Slate] Found ${images.length} style image(s) in folder:`, images);
		return images;
	}

	return [];
}

const WEIGHT_EXTENSIONS = [".safetensors", ".bin", ".pt", ".ckpt"];

export function resolveLoraReference(reference: string, vaultBasePath: string): string {
	const ref = reference.trim();

	if (ref.startsWith("/")) return ref;

	if (/^https?:\/\//.test(ref)) return ref;

	if (ref.includes(":")) return ref;

	if (WEIGHT_EXTENSIONS.some((ext) => ref.toLowerCase().endsWith(ext))) {
		return join(vaultBasePath, ref);
	}

	if (/^[^/\s]+\/[^/\s]+$/.test(ref)) return ref;

	return join(vaultBasePath, ref);
}

function resolveLoraArgs(settings: SlateSettings, vaultBasePath: string): { paths: string[]; scales: number[] } {
	const entries = settings.mfluxLoras.filter((l) => l.path.trim());
	return {
		paths: entries.map((l) => resolveLoraReference(l.path, vaultBasePath)),
		scales: entries.map((l) => l.scale),
	};
}

function buildCommand(
	executable: string,
	settings: SlateSettings,
	prompt: string,
	outputPath: string,
	styleImages: string[],
	loras: { paths: string[]; scales: number[] }
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
		args.push(["--image-paths", styleImages.map(shellEscape).join(" ")]);
	}

	if (loras.paths.length > 0) {
		args.push(["--lora-paths", loras.paths.map(shellEscape).join(" ")]);
		args.push(["--lora-scales", loras.scales.join(" ")]);
	}

	const multiValueFlags = new Set(["--image-paths", "--lora-paths", "--lora-scales"]);
	const argStr = args
		.map(([flag, value]) => `${flag} ${multiValueFlags.has(flag) ? value : shellEscape(value)}`)
		.join(" ");

	return `${shellEscape(activeExecutable)} ${argStr}`;
}

function shellEscape(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

async function resolveMfluxExecutable(override: string): Promise<string> {
	if (override) return override;

	try {
		const { stdout: pathOut } = await execFileAsync("/bin/zsh", ["-l", "-c", "echo $PATH"], { timeout: 5000 });
		console.log("[Slate] Shell PATH:", pathOut.trim());

		const { stdout: which } = await execFileAsync("/bin/zsh", ["-l", "-c", "which mflux-generate-flux2"], { timeout: 5000 });
		const resolved = which.trim();
		console.log("[Slate] Resolved mflux-generate-flux2:", resolved);
		return resolved || "mflux-generate-flux2";
	} catch (err) {
		console.warn("[Slate] Could not resolve mflux-generate-flux2 via login shell:", err);
		return "mflux-generate-flux2";
	}
}

export async function generateStoryboardImages(
	shots: Shot[],
	outputDir: string,
	settings: SlateSettings,
	vaultBasePath: string,
	onProgress?: (message: string, index: number, total: number) => void,
	onImageGenerated?: (image: GeneratedImage) => Promise<void>,
	resolvedDescriptions?: string[]
): Promise<GeneratedImage[]> {
	const results: GeneratedImage[] = [];
	const executable = await resolveMfluxExecutable(settings.mfluxExecutable);
	const styleImages = await resolveStyleImages(settings.mfluxStyleImagePath, vaultBasePath);
	const loras = resolveLoraArgs(settings, vaultBasePath);

	if (styleImages.length > 0) {
		console.log(`[Slate] Using ${styleImages.length} style image(s):`, styleImages);
	}
	if (loras.paths.length > 0) {
		console.log(`[Slate] Using ${loras.paths.length} LoRA(s):`, loras.paths, "scales:", loras.scales);
	}

	for (let i = 0; i < shots.length; i++) {
		const shot = shots[i];
		const filename = `${(settings.storyboardImageName || "Shot #").replace("#", String(shot.number))}.png`;
		const filePath = `${outputDir}/${filename}`;

		onProgress?.(`Generating image for shot ${shot.number}…`, i, shots.length);

		const description = resolvedDescriptions?.[i] ?? `${shot.action} ${shot.description}`;
		const prompt = settings.mfluxPromptHeader
			? `${settings.mfluxPromptHeader.trim()} ${description}`
			: description;
		const command = buildCommand(executable, settings, prompt, filePath, styleImages, loras);

		console.log(`[Slate] Shot ${shot.number} command:`, command);
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
