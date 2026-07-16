import { execFile } from "child_process";
import { promisify } from "util";
import { readFile, writeFile } from "fs/promises";
import { extname } from "path";
import { requestUrl } from "obsidian";
import type { SlateSettings } from "./settings";

const execFileAsync = promisify(execFile);

/** Everything a backend needs to render one image to disk. */
export interface GenerateParams {
	prompt: string;
	/** Absolute path the PNG should be written to. */
	outputPath: string;
	width: number;
	height: number;
	steps: number;
	model: string;
	quantize: number | null;
	/** Absolute paths of style/reference images (may be empty). */
	styleImages: string[];
	loras: { paths: string[]; scales: number[] };
	/** For error messages. */
	shotNumber: number;
}

/** A storyboard image backend. `generate` must leave a PNG at `params.outputPath`. */
export interface ImageProvider {
	generate(params: GenerateParams): Promise<void>;
}

export const PROVIDER_LOCAL = "local";
export const PROVIDER_FAL = "fal";
export type ProviderId = typeof PROVIDER_LOCAL | typeof PROVIDER_FAL;

// ── Local (mflux CLI) ────────────────────────────────────────────────────────

function shellEscape(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Build the mflux CLI command string for one shot. */
function buildMfluxCommand(executable: string, params: GenerateParams): string {
	const hasStyleImages = params.styleImages.length > 0;
	// The edit binary is used whenever reference images are supplied.
	const activeExecutable = hasStyleImages
		? executable.replace("mflux-generate-flux2", "mflux-generate-flux2-edit")
		: executable;

	const args: [string, string][] = [
		["--model", params.model],
		["--prompt", params.prompt],
		["--output", params.outputPath],
		["--steps", String(params.steps)],
		["--width", String(params.width)],
		["--height", String(params.height)],
	];

	if (params.quantize !== null) {
		args.push(["--quantize", String(params.quantize)]);
	}
	if (hasStyleImages) {
		args.push(["--image-paths", params.styleImages.map(shellEscape).join(" ")]);
	}
	if (params.loras.paths.length > 0) {
		args.push(["--lora-paths", params.loras.paths.map(shellEscape).join(" ")]);
		args.push(["--lora-scales", params.loras.scales.map((s) => shellEscape(String(s))).join(" ")]);
	}

	const multiValueFlags = new Set(["--image-paths", "--lora-paths", "--lora-scales"]);
	const argStr = args
		.map(([flag, value]) => `${flag} ${multiValueFlags.has(flag) ? value : shellEscape(value)}`)
		.join(" ");

	return `${shellEscape(activeExecutable)} ${argStr}`;
}

/** Resolve the full path of mflux-generate-flux2 via a login shell. */
async function resolveMfluxExecutable(override: string): Promise<string> {
	if (override) return override;
	try {
		const { stdout: which } = await execFileAsync(
			"/bin/zsh",
			["-l", "-c", "which mflux-generate-flux2"],
			{ timeout: 5000 }
		);
		const resolved = which.trim();
		console.log("[Slate] Resolved mflux-generate-flux2:", resolved);
		return resolved || "mflux-generate-flux2";
	} catch (err) {
		console.warn("[Slate] Could not resolve mflux-generate-flux2 via login shell:", err);
		return "mflux-generate-flux2";
	}
}

/** Turn raw mflux stderr into a human-readable error where possible. */
function friendlyMfluxError(raw: string, shotNumber: number, model: string): string {
	if (raw.includes("matmul") && raw.includes("must match")) {
		const is4b = model.includes("4b");
		const is9b = model.includes("9b");
		const suggestion = is4b
			? "The LoRA was likely trained for the 9b model. Switch to flux2-klein-9b in settings, or use a 4b-compatible LoRA."
			: is9b
			? "The LoRA was likely trained for the 4b model. Switch to flux2-klein-4b in settings, or use a 9b-compatible LoRA."
			: "The LoRA may be incompatible with the selected model variant.";
		return `Shot ${shotNumber}: LoRA is incompatible with model "${model}". ${suggestion}`;
	}
	return `mflux failed for shot ${shotNumber}: ${raw}`;
}

class LocalMfluxProvider implements ImageProvider {
	constructor(private readonly executable: string) {}

	async generate(params: GenerateParams): Promise<void> {
		const command = buildMfluxCommand(this.executable, params);
		console.log(`[Slate] Shot ${params.shotNumber} command:`, command);
		try {
			await execFileAsync("/bin/zsh", ["-l", "-c", command], {
				timeout: 10 * 60 * 1000,
			});
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(friendlyMfluxError(msg, params.shotNumber, params.model));
		}
	}
}

// ── Cloud (fal.ai) ─────────────────────────────────────────────────────────

const FAL_QUEUE_HOST = "https://queue.fal.run";

// Text-to-image endpoints per klein variant. "base" models take a guidance
// scale; the plain klein models are distilled. The 9b endpoint ids are inferred
// from fal's 4b naming and may need adjusting once fal publishes them.
const FAL_TXT2IMG_ENDPOINTS: Record<string, string> = {
	"flux2-klein-4b": "fal-ai/flux-2/klein/4b/distilled",
	"flux2-klein-9b": "fal-ai/flux-2/klein/9b/distilled",
	"flux2-klein-base-4b": "fal-ai/flux-2/klein/4b",
	"flux2-klein-base-9b": "fal-ai/flux-2/klein/9b",
};

// Reference/edit endpoint (takes image_urls[]). Used when style images are set.
const FAL_EDIT_ENDPOINT = "fal-ai/flux-2/klein/4b/edit";

const MIME_BY_EXT: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".bmp": "image/bmp",
};

async function toDataUri(path: string): Promise<string> {
	const mime = MIME_BY_EXT[extname(path).toLowerCase()] ?? "image/png";
	const buffer = await readFile(path);
	return `data:${mime};base64,${buffer.toString("base64")}`;
}

class FalProvider implements ImageProvider {
	constructor(
		private readonly apiKey: string,
		private readonly pollIntervalMs = 1500,
		private readonly timeoutMs = 10 * 60 * 1000
	) {}

	async generate(params: GenerateParams): Promise<void> {
		if (!this.apiKey) {
			throw new Error("No fal.ai API key set. Add one in Slate settings.");
		}

		const { endpoint, payload } = await this.buildRequest(params);
		console.log(`[Slate] fal.ai submitting shot ${params.shotNumber} to ${endpoint}`);

		const submit = await this.request("POST", `${FAL_QUEUE_HOST}/${endpoint}`, payload);
		const statusUrl = submit.status_url as string | undefined;
		const responseUrl = submit.response_url as string | undefined;
		if (!statusUrl || !responseUrl) {
			throw new Error(`Unexpected fal.ai response: ${JSON.stringify(submit).slice(0, 300)}`);
		}

		await this.waitForCompletion(statusUrl, params.shotNumber);

		const result = await this.request("GET", responseUrl);
		const imageUrl = this.extractImageUrl(result);
		if (!imageUrl) {
			throw new Error(`fal.ai returned no image: ${JSON.stringify(result).slice(0, 300)}`);
		}
		await this.download(imageUrl, params.outputPath);
	}

	private async buildRequest(params: GenerateParams): Promise<{ endpoint: string; payload: Record<string, unknown> }> {
		if (params.styleImages.length > 0) {
			const imageUrls = await Promise.all(params.styleImages.map((p) => toDataUri(p)));
			return {
				endpoint: FAL_EDIT_ENDPOINT,
				payload: {
					prompt: params.prompt,
					image_urls: imageUrls,
					num_inference_steps: params.steps,
					image_size: { width: params.width, height: params.height },
				},
			};
		}

		const endpoint = FAL_TXT2IMG_ENDPOINTS[params.model];
		if (!endpoint) {
			throw new Error(`No fal.ai endpoint mapped for model "${params.model}"`);
		}
		const payload: Record<string, unknown> = {
			prompt: params.prompt,
			image_size: { width: params.width, height: params.height },
			num_inference_steps: params.steps,
		};

		// LoRAs on fal must be hosted (URL); local paths can't be uploaded here.
		const loraSpecs = params.loras.paths
			.map((path, i) => ({ path, scale: params.loras.scales[i] }))
			.filter((l) => /^https?:\/\//.test(l.path));
		if (loraSpecs.length > 0) {
			payload.loras = loraSpecs;
		}
		const skipped = params.loras.paths.filter((p) => !/^https?:\/\//.test(p));
		if (skipped.length > 0) {
			console.warn("[Slate] fal.ai: skipping local LoRA(s) (cloud needs a URL):", skipped);
		}

		return { endpoint, payload };
	}

	private async waitForCompletion(statusUrl: string, shotNumber: number): Promise<void> {
		const deadline = Date.now() + this.timeoutMs;
		let last: string | undefined;
		for (;;) {
			const status = await this.request("GET", statusUrl);
			const state = status.status as string | undefined;
			if (state !== last) {
				console.log(`[Slate] fal.ai shot ${shotNumber}: ${state}`);
				last = state;
			}
			if (state === "COMPLETED") return;
			if (state === "FAILED" || state === "ERROR") {
				throw new Error(`fal.ai request failed: ${JSON.stringify(status).slice(0, 300)}`);
			}
			if (Date.now() > deadline) {
				throw new Error(`fal.ai request timed out for shot ${shotNumber}`);
			}
			await new Promise((r) => setTimeout(r, this.pollIntervalMs));
		}
	}

	private async request(method: string, url: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
		const resp = await requestUrl({
			url,
			method,
			headers: {
				Authorization: `Key ${this.apiKey}`,
				"Content-Type": "application/json",
			},
			body: body ? JSON.stringify(body) : undefined,
			throw: false,
		});
		if (resp.status < 200 || resp.status >= 300) {
			throw new Error(`fal.ai HTTP ${resp.status}: ${resp.text?.slice(0, 300) ?? ""}`);
		}
		return resp.json ?? {};
	}

	private async download(url: string, outputPath: string): Promise<void> {
		const resp = await requestUrl({ url, method: "GET", throw: false });
		if (resp.status < 200 || resp.status >= 300) {
			throw new Error(`fal.ai download failed: HTTP ${resp.status}`);
		}
		await writeFile(outputPath, Buffer.from(resp.arrayBuffer));
	}

	private extractImageUrl(result: Record<string, unknown>): string | undefined {
		const images = result.images;
		if (Array.isArray(images) && images.length > 0) {
			const first = images[0];
			if (typeof first === "string") return first;
			if (first && typeof first === "object" && "url" in first) return (first as { url: string }).url;
		}
		const image = result.image;
		if (image && typeof image === "object" && "url" in image) return (image as { url: string }).url;
		return undefined;
	}
}

// ── Factory ──────────────────────────────────────────────────────────────────

/** Build the provider selected in settings, doing any async setup it needs. */
export async function createImageProvider(settings: SlateSettings): Promise<ImageProvider> {
	if (settings.imageProvider === PROVIDER_FAL) {
		return new FalProvider(settings.falApiKey);
	}
	const executable = await resolveMfluxExecutable(settings.mfluxExecutable);
	return new LocalMfluxProvider(executable);
}
