/**
 * Does the shot breakdown still need to be piece-mealed?
 *
 * Slate splits a script into word-capped chunks before sending it to Ollama, on
 * the theory that a smaller excerpt makes the model split more aggressively.
 * Chunking costs extra round trips and loses cross-scene context, so it is worth
 * knowing whether the current model still needs it.
 *
 * Measured 2026-08-22 over the 889 word fixture, three chunks of 250 words:
 *
 *   qwen2.5:32b       87 shots in one call, 112 chunked. Chunking wins by 29%.
 *   codestral:latest  73 shots in one call,  43 chunked. Chunking loses by 41%.
 *
 * So the theory holds for qwen and inverts for codestral, which is why this is a
 * measurement rather than an assumption. Neither model truncated its whole-script
 * response. Single sample per configuration at temperature 0.7, so treat small
 * differences as noise.
 *
 * This test measures shot density (shots per 100 words) two ways over the same
 * fixture. It holds the current answer in place: the chunked path has to keep
 * hitting its density, and chunking has to keep being worth the round trips. If
 * a future model closes the gap, the second assertion goes red to say so. It is
 * slow (several model calls over a full script), so it is opt-in:
 *
 *   SLATE_TEST_DENSITY=1 npm run test:density
 *
 * Point it at another model to compare candidates on equal footing:
 *
 *   SLATE_TEST_DENSITY=1 SLATE_TEST_MODEL=mistral:latest npm run test:density
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { generateShotBreakdown, splitScriptIntoChunks } from "../src/ollama.ts";
import { HOST, MODEL, fixture, wordCount, density, liveSkipReason } from "./helpers.ts";

/** Chunk size used for the piece-mealed run, in words. */
const CHUNK_SIZE = Number(process.env.SLATE_TEST_CHUNK_SIZE ?? 250);

/**
 * How close a whole-script call has to get to the chunked result before the
 * extra round trips stop paying for themselves. At 0.9, a single call that
 * recovers 90% of the chunked shot density makes chunking not worth keeping.
 *
 * Measured 2026-08-22 on qwen2.5:32b: 0.78. Chunking still earns its keep, so
 * the assertion below is written to go red when that stops being true.
 */
const CHUNKING_UNNECESSARY_AT = 0.9;

/**
 * Shots per 100 words the chunked path must still reach. Measured 12.60 on
 * qwen2.5:32b, so this floor catches a model that starts summarising without
 * tripping on ordinary run-to-run variance.
 */
const MIN_CHUNKED_DENSITY = 9;

const enabled = process.env.SLATE_TEST_DENSITY === "1";

let skip: string | false = false;

/** Everything the assertions need, measured once because each run is minutes long. */
let measured: {
	wholeShots: number;
	wholeDensity: number;
	wholeWarnings: string[];
	chunkedShots: number;
	chunkedDensity: number;
} | null = null;

/** Run the callback while collecting anything generateShotBreakdown warns about. */
async function withWarnings<T>(fn: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
	const warnings: string[] = [];
	const original = console.warn;
	console.warn = (...args: unknown[]) => {
		warnings.push(args.map(String).join(" "));
	};
	try {
		return { result: await fn(), warnings };
	} finally {
		console.warn = original;
	}
}

before(async () => {
	if (!enabled) {
		skip = "Set SLATE_TEST_DENSITY=1 to run the density benchmark (slow)";
		return;
	}
	const reason = await liveSkipReason();
	if (reason) {
		skip = reason;
		return;
	}

	const script = fixture("script.fountain");
	const words = wordCount(script);

	// Single call: the entire script in one request.
	const wholeStart = Date.now();
	const whole = await withWarnings(() => generateShotBreakdown(HOST, MODEL, script));
	const wholeSeconds = (Date.now() - wholeStart) / 1000;
	const wholeDensity = density(whole.result.length, script);

	// Piece-mealed: the same script split at scene boundaries.
	const chunks = splitScriptIntoChunks(script, CHUNK_SIZE);
	const chunkedStart = Date.now();
	let chunkedShots = 0;
	const chunkedWarnings: string[] = [];
	for (const chunk of chunks) {
		const run = await withWarnings(() => generateShotBreakdown(HOST, MODEL, chunk));
		chunkedShots += run.result.length;
		chunkedWarnings.push(...run.warnings);
	}
	const chunkedSeconds = (Date.now() - chunkedStart) / 1000;
	const chunkedDensity = density(chunkedShots, script);

	console.log(
		[
			"",
			`model         ${MODEL}`,
			`script        ${words} words, ${chunks.length} chunks at ${CHUNK_SIZE} words`,
			`single call   ${whole.result.length} shots, ${wholeDensity.toFixed(2)} per 100 words, ` +
				`${wholeSeconds.toFixed(0)}s, ${whole.warnings.length} recovery warning(s)`,
			`piece-mealed  ${chunkedShots} shots, ${chunkedDensity.toFixed(2)} per 100 words, ` +
				`${chunkedSeconds.toFixed(0)}s, ${chunkedWarnings.length} recovery warning(s)`,
			`ratio         ${(wholeDensity / chunkedDensity).toFixed(2)} density, ` +
				`${(wholeSeconds / chunkedSeconds).toFixed(2)} time`,
			"",
		].join("\n")
	);

	measured = {
		wholeShots: whole.result.length,
		wholeDensity,
		wholeWarnings: whole.warnings,
		chunkedShots,
		chunkedDensity,
	};
});

test("the chunked path still reaches its shot density", (t) => {
	if (skip) return t.skip(skip);
	const m = measured!;

	assert.ok(m.chunkedShots > 0, "the piece-mealed run produced no shots at all");
	assert.ok(
		m.chunkedDensity >= MIN_CHUNKED_DENSITY,
		`${MODEL} produced ${m.chunkedDensity.toFixed(2)} shots per 100 words, expected at least ` +
			`${MIN_CHUNKED_DENSITY}. The model is summarising instead of splitting one action per shot.`
	);
});

test("chunking still earns its extra round trips", (t) => {
	if (skip) return t.skip(skip);
	const m = measured!;
	const ratio = m.wholeDensity / m.chunkedDensity;

	// This is the one that should go red on good news. When a future model
	// closes the gap, the split in splitScriptIntoChunks stops buying anything
	// and the breakdown can go back to a single call per script.
	assert.ok(
		ratio < CHUNKING_UNNECESSARY_AT,
		`${MODEL} now recovers ${(ratio * 100).toFixed(0)}% of the chunked shot density in a single ` +
			`call (${m.wholeDensity.toFixed(2)} vs ${m.chunkedDensity.toFixed(2)} per 100 words). ` +
			`Chunking no longer pays for itself, so splitScriptIntoChunks can probably go.`
	);
});

test("a whole-script call returns a complete JSON array", (t) => {
	if (skip) return t.skip(skip);
	const m = measured!;

	assert.ok(m.wholeShots > 0, "no shots returned");
	assert.deepEqual(
		m.wholeWarnings.filter((w) => w.includes("truncated")),
		[],
		`${MODEL} truncated its response on a whole script, so the array had to be repaired`
	);
});
