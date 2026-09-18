/**
 * Offline tests for the Fountain formatter. No Ollama needed.
 *
 * The formatter rewrites the user's script in place, so these lean hard on the
 * things it must never do. The load-bearing one is trailing whitespace: two
 * spaces on a blank line keep a speech open, and stripping them turns dialogue
 * into action several lines later without any visible sign.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatFountain, minimalEdit } from "../src/fountain-format.ts";
import { parseFountain } from "../src/fountain.ts";
import { fixture } from "./helpers.ts";

test("scene headings are uppercased", () => {
	const out = formatFountain("int. diner - night\n\nRain falls.\n");
	assert.match(out, /^INT\. DINER - NIGHT$/m);
	assert.match(out, /^Rain falls\.$/m);
});

test("a forced cue is uppercased without touching its dialogue", () => {
	const out = formatFountain("INT. DINER - NIGHT\n\n@mara\nYou said midnight.\n");
	assert.match(out, /^@MARA$/m);
	assert.match(out, /^You said midnight\.$/m);
});

test("a bare lowercase cue is left alone, because it is ambiguous", () => {
	const src = "INT. DINER - NIGHT\n\nMara\nYou said midnight.\n";
	const out = formatFountain(src);
	assert.match(out, /^Mara$/m);
	assert.equal(parseFountain(out).characters.length, 0);
});

test("doubled and long dashes in headings become single hyphens", () => {
	assert.match(formatFountain("INT. DINER -- NIGHT\n\nA beat.\n"), /INT\. DINER - NIGHT/);
	assert.match(formatFountain("INT. DINER – NIGHT\n\nA beat.\n"), /INT\. DINER - NIGHT/);
	assert.match(formatFountain("INT. SAINT-DENIS - NIGHT\n\nA beat.\n"), /SAINT-DENIS/);
});

test("two spaces on a blank line survive, because they hold a speech open", () => {
	const src = "MARA\nFirst part.\n  \nStill speaking.\n";
	const out = formatFountain(src);
	assert.ok(out.includes("\n  \n"), "the two-space line was stripped");
	const kinds = parseFountain(out).elements.map((e) => e.kind);
	assert.deepEqual(kinds, ["character", "dialogue", "dialogue", "dialogue"]);
});

test("ordinary trailing whitespace is removed", () => {
	const out = formatFountain("Rain falls.   \n\nHe waits.\t\n");
	assert.ok(!/[ \t]+$/m.test(out));
});

test("runs of blank lines collapse to one", () => {
	const out = formatFountain("INT. DINER - NIGHT\n\n\n\nRain falls.\n");
	assert.ok(!out.includes("\n\n\n"));
	assert.match(out, /INT\. DINER - NIGHT\n\nRain falls\./);
});

test("consecutive action lines stay one paragraph", () => {
	const src = "INT. DINER - NIGHT\n\nRain falls.\nHe waits.\n";
	assert.match(formatFountain(src), /Rain falls\.\nHe waits\./);
});

test("a speech is never broken up", () => {
	const src = "MARA\n(quietly)\nYou said midnight.\nI waited.\n";
	const out = formatFountain(src);
	assert.ok(!out.includes("\n\n"), "a blank line was inserted inside the speech");
});

test("elements that were separated get exactly one blank line", () => {
	const src = "INT. DINER - NIGHT\n\n\n\nRain falls.\n\n\nHe waits.\n";
	const out = formatFountain(src);
	assert.equal(out, "INT. DINER - NIGHT\n\nRain falls.\n\nHe waits.\n");
});

test("boneyard content is left exactly as written", () => {
	const src = "INT. DINER - NIGHT\n\n/*\nint. cut scene - day\n\n\nkept verbatim\n*/\n\nRain falls.\n";
	const out = formatFountain(src);
	assert.ok(out.includes("int. cut scene - day"), "boneyard was uppercased");
	assert.ok(out.includes("\n\n\nkept verbatim"), "boneyard spacing was collapsed");
});

test("curly blocks are left exactly as written", () => {
	const src = "Rain falls.\n\n{{Slugline Document Settings\nPrint Font: Courier Prime}}\n";
	assert.ok(formatFountain(src).includes("Print Font: Courier Prime"));
});

test("note contents keep their case inside an uppercased heading", () => {
	const out = formatFountain("int. [[Rialto Diner]] - night\n\nA beat.\n");
	assert.match(out, /INT\. \[\[Rialto Diner\]\] - NIGHT/);
});

test("the title page keeps its own layout", () => {
	const src = "Title: King's Block\n   and its diner\nAuthor: Douglas\n\nINT. DINER - NIGHT\n\nA beat.\n";
	const out = formatFountain(src);
	assert.ok(out.includes("   and its diner"), "the indent was stripped");
	assert.ok(out.includes("Title: King's Block"));
});

test("formatting is idempotent", () => {
	const src = "int. diner -- night\n\n\nMara\nYou said midnight.\n  \nStill here.   \n";
	const once = formatFountain(src);
	assert.equal(formatFountain(once), once);
});

test("formatting never changes what the elements are", () => {
	const src = fixture("scene.fountain");
	const before = parseFountain(src).elements.map((e) => e.kind);
	const after = parseFountain(formatFountain(src)).elements.map((e) => e.kind);
	assert.deepEqual(after, before);
});

test("the file ends with exactly one newline", () => {
	assert.ok(formatFountain("Rain falls.").endsWith(".\n"));
	assert.ok(formatFountain("Rain falls.\n\n\n").endsWith(".\n"));
});

const apply = (before: string, edit: { from: number; to: number; text: string }) =>
	before.slice(0, edit.from) + edit.text + before.slice(edit.to);

test("identical texts produce no edit at all", () => {
	assert.equal(minimalEdit("INT. DINER - NIGHT\n", "INT. DINER - NIGHT\n"), null);
});

test("an edit reconstructs the formatted text exactly", () => {
	const before = "int. diner -- night\n\n\nMara waits.   \n";
	const after = formatFountain(before);
	const edit = minimalEdit(before, after);
	assert.ok(edit);
	assert.equal(apply(before, edit), after);
});

test("the edit spans only what actually differs", () => {
	const before = "INT. DINER - NIGHT\n\nRain falls.\n\n\n\nHe waits.\n";
	const edit = minimalEdit(before, formatFountain(before));
	assert.ok(edit);
	assert.ok(before.slice(0, edit.from).startsWith("INT. DINER - NIGHT"));
	assert.ok(edit.to < before.length, "the edit reached the end of the document");
});

test("a pure insertion has an empty range", () => {
	const edit = minimalEdit("ab", "axb");
	assert.deepEqual(edit, { from: 1, to: 1, text: "x" });
});

test("a pure deletion has empty text", () => {
	const edit = minimalEdit("axb", "ab");
	assert.deepEqual(edit, { from: 1, to: 2, text: "" });
});

test("the prefix and suffix scans never cross each other", () => {
	const edit = minimalEdit("aa", "a");
	assert.ok(edit);
	assert.ok(edit.to >= edit.from, "range runs backwards");
	assert.equal(apply("aa", edit), "a");
});

test("an edit inside an already formatted script stays local", () => {
	const formatted = formatFountain(fixture("scene.fountain"));
	const edited = formatted.replace("You said midnight.", "You said midnight.\n\n\nBeat.");
	const edit = minimalEdit(edited, formatFountain(edited));
	assert.ok(edit);
	assert.ok(edit.from > 0, "the untouched head was replaced");
	assert.ok(edit.to < edited.length, "the untouched tail was replaced");
});

test("a change at both ends widens the span, which is the known limit", () => {
	const before = "int. a - day\n\nBeat.\n\nint. b - day\n\nBeat.";
	const after = formatFountain(before);
	const edit = minimalEdit(before, after);
	assert.ok(edit);
	assert.equal(apply(before, edit), after);
});
