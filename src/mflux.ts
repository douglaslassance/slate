import { execFile } from "child_process";
import { promisify } from "util";
import type { Shot } from "./ollama";
import type { SlateSettings } from "./settings";

const execFileAsync = promisify(execFile);

export interface GeneratedImage {
	shot: Shot;
	/** Absolute path on disk to the generated PNG. */
	filePath: string;
}

/**
 * Build the mflux-generate-flux2 CLI argument string for a single shot.
 * Arguments are shell-escaped so paths/prompts with spaces are safe.
 */
function buildCommand(executable: string, settings: SlateSettings, prompt: string, outputPath: string): string {

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

	const argStr = args
		.map(([flag, value]) => `${flag} ${shellEscape(value)}`)
		.join(" ");

	return `${shellEscape(executable)} ${argStr}`;
}

function shellEscape(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Resolve the full path of mflux-generate-flux2 via a login shell.
 * Logs the resolved path and shell PATH for diagnostics.
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
	} catch (err) {
		console.warn("[Slate] Could not resolve mflux-generate-flux2 via login shell:", err);
		return "mflux-generate-flux2";
	}
}

/**
 * Generate storyboard images for a list of shots using mflux-generate-flux2.
 * Runs through a login shell so the full user PATH is available.
 */
export async function generateStoryboardImages(
	shots: Shot[],
	outputDir: string,
	settings: SlateSettings,
	onProgress?: (message: string, index: number, total: number) => void
): Promise<GeneratedImage[]> {
	const results: GeneratedImage[] = [];
	const executable = await resolveMfluxExecutable(settings.mfluxExecutable);

	for (let i = 0; i < shots.length; i++) {
		const shot = shots[i];
		const filename = `shot_${String(shot.number).padStart(3, "0")}.png`;
		const filePath = `${outputDir}/${filename}`;

		onProgress?.(`Generating image for shot ${shot.number}…`, i, shots.length);

		const prompt = settings.mfluxPromptHeader
			? `${settings.mfluxPromptHeader.trim()} ${shot.visualDescription}`
			: shot.visualDescription;
		const command = buildCommand(executable, settings, prompt, filePath);

		try {
			// Run via zsh login shell so ~/.zshrc / ~/.zprofile PATH entries are available.
			await execFileAsync("/bin/zsh", ["-l", "-c", command], {
				timeout: 10 * 60 * 1000,
			});
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`mflux-generate-flux2 failed for shot ${shot.number}: ${msg}`);
		}

		results.push({ shot, filePath });
	}

	return results;
}
