import { stat, readdir } from "fs/promises";
import { join, extname } from "path";
import type { Shot } from "./ollama";
import type { SlateSettings } from "./settings";
import { createImageProvider } from "./providers";

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
async function resolveStyleImages(stylePath: string, vaultBasePath: string): Promise<string[]> {
	if (!stylePath) return [];

	// Resolve relative paths against the vault root.
	// A path starting with "/" is treated as absolute; anything else is relative.
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

/**
 * Resolve LoRA paths against the vault root and return parallel paths/scales arrays
 * ready to pass to the mflux CLI.
 */
function resolveLoraArgs(settings: SlateSettings, vaultBasePath: string): { paths: string[]; scales: number[] } {
	const entries = settings.mfluxLoras.filter((l) => l.path.trim());
	const paths = entries.map((l) => {
		// Absolute path: pass through as-is.
		if (l.path.startsWith("/")) return l.path;
		// Hugging Face repo ID (e.g. "username/my-lora"): pass through as-is.
		if (/^[^/]+\/[^/]+$/.test(l.path) && !l.path.includes(".")) return l.path;
		// Relative local path: resolve against vault root.
		return join(vaultBasePath, l.path);
	});
	const scales = entries.map((l) => l.scale);
	return { paths, scales };
}

/**
 * Generate storyboard images for a list of shots.
 *
 * The active backend (local mflux or cloud fal.ai) is selected in settings and
 * resolved via createImageProvider; this function only prepares each shot's
 * prompt and inputs and writes the resulting PNGs.
 */
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
	const provider = await createImageProvider(settings);
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

		await provider.generate({
			prompt,
			outputPath: filePath,
			width: settings.mfluxWidth,
			height: settings.mfluxHeight,
			steps: settings.mfluxSteps,
			model: settings.mfluxModel,
			quantize: settings.mfluxQuantize,
			styleImages,
			loras,
			shotNumber: shot.number,
		});

		const generated = { shot, filePath };
		await onImageGenerated?.(generated);
		results.push(generated);
	}

	return results;
}
