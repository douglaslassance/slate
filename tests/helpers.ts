import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Agent, setGlobalDispatcher } from "undici";
import { MODEL as SHIPPED_MODEL } from "../src/ollama.ts";

/**
 * Ollama answers /api/chat with stream:false, so it sends no headers at all
 * until the whole shot list is generated. Node's fetch gives up after 300
 * seconds by default, which a whole-script breakdown on a 32b model exceeds.
 * Lift both timeouts so the benchmark measures the model rather than undici.
 *
 * This affects the global fetch that src/ollama.ts calls, so the code under
 * test stays exactly as it ships.
 */
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));

const HERE = dirname(fileURLToPath(import.meta.url));

/** Ollama server the live tests talk to. */
export const HOST = process.env.SLATE_TEST_HOST ?? "http://localhost:11434";

export const MODEL = process.env.SLATE_TEST_MODEL ?? SHIPPED_MODEL;

export function fixture(name: string): string {
	return readFileSync(join(HERE, "fixtures", name), "utf8").trim();
}

export function wordCount(text: string): number {
	return text.trim().split(/\s+/).length;
}

export function density(shotCount: number, text: string): number {
	return (shotCount / wordCount(text)) * 100;
}

/** True when an Ollama server answers at HOST. Live tests skip when it does not. */
export async function ollamaReachable(): Promise<boolean> {
	try {
		const res = await fetch(`${HOST}/api/tags`, {
			signal: AbortSignal.timeout(2000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

export async function modelAvailable(): Promise<boolean> {
	try {
		const res = await fetch(`${HOST}/api/tags`, {
			signal: AbortSignal.timeout(2000),
		});
		if (!res.ok) return false;
		const data = await res.json();
		return (data.models ?? []).some((m: { name: string }) => m.name === MODEL);
	} catch {
		return false;
	}
}

export async function liveSkipReason(): Promise<string | null> {
	if (!(await ollamaReachable())) return `Ollama not reachable at ${HOST}`;
	if (!(await modelAvailable())) return `Model ${MODEL} not pulled locally`;
	return null;
}
