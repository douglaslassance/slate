import { execFile } from "child_process";
import { promisify } from "util";
import type { Shot } from "./ollama";
import type { PompeiSettings } from "./settings";

const execFileAsync = promisify(execFile);

export interface GeneratedImage {
	shot: Shot;
	/** Absolute path on disk to the generated PNG. */
	filePath: string;
}

/**
 * Build the mflux-generate CLI argument list for a single shot.
 */
function buildArgs(
	settings: PompeiSettings,
	prompt: string,
	outputPath: string,
	seed?: number
): string[] {
	const args: string[] = [
		"--model", settings.mfluxModel,
		"--prompt", prompt,
		"--output", outputPath,
		"--steps", String(settings.mfluxSteps),
		"--width", String(settings.mfluxWidth),
		"--height", String(settings.mfluxHeight),
	];

	if (settings.mfluxQuantize !== null) {
		args.push("--quantize", String(settings.mfluxQuantize));
	}

	if (seed !== undefined) {
		args.push("--seed", String(seed));
	}

	return args;
}

/**
 * Generate storyboard images for a list of shots using mflux-generate.
 *
 * @param shots       Array of shots from the Ollama breakdown.
 * @param outputDir   Absolute directory path where images will be written.
 * @param settings    Plugin settings (model, steps, resolution, …).
 * @param onProgress  Optional callback receiving a status message per shot.
 */
export async function generateStoryboardImages(
	shots: Shot[],
	outputDir: string,
	settings: PompeiSettings,
	onProgress?: (message: string, index: number, total: number) => void
): Promise<GeneratedImage[]> {
	const results: GeneratedImage[] = [];

	for (let i = 0; i < shots.length; i++) {
		const shot = shots[i];
		const filename = `shot_${String(shot.number).padStart(3, "0")}.png`;
		const filePath = `${outputDir}/${filename}`;

		onProgress?.(`Generating image for shot ${shot.number}…`, i, shots.length);

		const args = buildArgs(settings, shot.visualDescription, filePath);

		try {
			await execFileAsync("mflux-generate", args, {
				// Allow up to 10 minutes per image on slow hardware.
				timeout: 10 * 60 * 1000,
			});
		} catch (err: unknown) {
			const msg =
				err instanceof Error ? err.message : String(err);
			throw new Error(`mflux-generate failed for shot ${shot.number}: ${msg}`);
		}

		results.push({ shot, filePath });
	}

	return results;
}
