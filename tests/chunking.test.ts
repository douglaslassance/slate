/**
 * Offline tests for the script splitter. No Ollama needed.
 *
 * These pin the guarantee the chunking feature rests on: a chunk boundary only
 * ever lands on a scene heading, so no scene is ever cut in half.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { splitScriptIntoChunks, estimatePageCount } from "../src/ollama.ts";
import { fixture, wordCount } from "./helpers.ts";

const SCENE_HEADING_RE = /^(#{1,3}\s*)?\**(INT\.|EXT\.|INT\/EXT\.|I\/E\.)\s/i;

test("a script shorter than the cap stays in one chunk", () => {
	const scene = fixture("scene.fountain");
	const chunks = splitScriptIntoChunks(scene, 750);
	assert.equal(chunks.length, 1);
	assert.equal(chunks[0], scene);
});

test("a long script splits into several chunks", () => {
	const script = fixture("script.fountain");
	const chunks = splitScriptIntoChunks(script, 250);
	assert.ok(chunks.length > 1, `expected multiple chunks, got ${chunks.length}`);
});

test("every chunk after the first starts on a scene heading", () => {
	const script = fixture("script.fountain");
	const chunks = splitScriptIntoChunks(script, 250);
	for (const chunk of chunks.slice(1)) {
		const firstLine = chunk.split("\n")[0].trim();
		assert.match(
			firstLine,
			SCENE_HEADING_RE,
			`chunk starts mid-scene on ${JSON.stringify(firstLine)}`
		);
	}
});

test("chunking loses no words", () => {
	const script = fixture("script.fountain");
	const chunks = splitScriptIntoChunks(script, 250);
	const rejoined = chunks.join("\n").split(/\s+/).filter(Boolean).join(" ");
	const original = script.split(/\s+/).filter(Boolean).join(" ");
	assert.equal(rejoined, original);
});

test("a forced sub-slug is a boundary too", () => {
	// Boundaries come from the parse, so ".DERRIÈRE LE RIDEAU" counts as a
	// scene heading the same way an INT. line does.
	const script = [
		"INT. KITCHEN - DAY",
		"A kettle boils. ".repeat(40),
		".BEHIND THE CURTAIN",
		"Rain falls on the beds.",
	].join("\n\n");
	const chunks = splitScriptIntoChunks(script, 50);
	assert.equal(chunks.length, 2);
	assert.equal(chunks[1].split("\n")[0].trim(), ".BEHIND THE CURTAIN");
});

test("markdown headings are no longer boundaries", () => {
	// A script is always Fountain now, and "## INT." is a section there, not a
	// scene heading. Prose goes through "Convert to Fountain" first.
	const script = [
		"## INT. KITCHEN - DAY",
		"A kettle boils. ".repeat(40),
		"## EXT. GARDEN - DAY",
		"Rain falls on the beds.",
	].join("\n\n");
	assert.equal(splitScriptIntoChunks(script, 50).length, 1);
});

test("a single scene longer than the cap is never split", () => {
	// There is no second heading to break on, so the whole scene must stay whole.
	const script = ["INT. VAULT - NIGHT", "A long beat. ".repeat(200)].join("\n\n");
	const chunks = splitScriptIntoChunks(script, 50);
	assert.equal(chunks.length, 1);
});

test("page count follows the 250 words per page convention", () => {
	assert.equal(estimatePageCount("word ".repeat(250)), 1);
	assert.equal(estimatePageCount("word ".repeat(500)), 2);
	// Anything shorter than half a page still counts as half a page.
	assert.equal(estimatePageCount("word"), 0.5);
});

test("the fixtures are the sizes the live tests assume", () => {
	assert.ok(wordCount(fixture("scene.fountain")) < 200);
	assert.ok(wordCount(fixture("script.fountain")) > 800);
});
