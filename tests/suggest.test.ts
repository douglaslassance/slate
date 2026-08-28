/**
 * Offline tests for the autocomplete vocabulary. No Ollama needed.
 *
 * The claim being pinned is that the vocabulary comes from the script rather
 * than a built-in list, which is what makes completion work in a script that
 * is not written in English.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFountain } from "../src/fountain.ts";
import { buildVocabulary, rankByQuery } from "../src/fountain-entities.ts";
import { fixture } from "./helpers.ts";

const vocab = (src: string) => buildVocabulary(parseFountain(src));

test("times of day are learned from the script, in any language", () => {
	const src = [
		"INT. TOILETTES ROYALES - JOUR",
		"",
		"Un beat.",
		"",
		"EXT. BALCON - NUIT",
		"",
		"Un beat.",
		"",
		"INT. CUVETTE - CONTINU",
		"",
		"Un beat.",
	].join("\n");
	assert.deepEqual(vocab(src).times, ["JOUR", "NUIT", "CONTINU"]);
});

test("a time of day is listed once however often it is used", () => {
	const src = "INT. A - DAY\n\nBeat.\n\nEXT. B - DAY\n\nBeat.";
	assert.deepEqual(vocab(src).times, ["DAY"]);
});

test("a scene number does not leak into the time of day", () => {
	const src = "INT. DINER - NIGHT #12A#\n\nBeat.";
	assert.deepEqual(vocab(src).times, ["NIGHT"]);
});

test("a heading with no time of day contributes none", () => {
	const src = "INT. DINER\n\nBeat.";
	assert.deepEqual(vocab(src).times, []);
});

test("locations and characters come through for completion", () => {
	const src = "INT. RIALTO DINER - NIGHT\n\nMARA\nYou said midnight.";
	const v = vocab(src);
	assert.deepEqual(v.locations, ["RIALTO DINER"]);
	assert.deepEqual(v.characters, ["MARA"]);
});

test("a character who never speaks is still offered", () => {
	// Same roster the links use, so completion covers a wordless script.
	const src = "INT. PALAIS - JOUR\n\nEntre LE ROI KAGI, quarante ans.";
	assert.deepEqual(vocab(src).characters, ["LE ROI KAGI"]);
});

test("transitions already in the script are offered", () => {
	const src = "A beat.\n\nCUT TO:\n\nA beat.\n\nSMASH CUT TO:\n\nA beat.";
	assert.deepEqual(vocab(src).transitions, ["CUT TO:", "SMASH CUT TO:"]);
});

test("a forced transition is offered without its > marker", () => {
	const src = "A beat.\n\n> FADE OUT.\n";
	assert.deepEqual(vocab(src).transitions, ["FADE OUT."]);
});

test("a transition is listed once however often it is used", () => {
	const src = "A.\n\nCUT TO:\n\nB.\n\nCUT TO:\n\nC.";
	assert.deepEqual(vocab(src).transitions, ["CUT TO:"]);
});

test("the fixture yields its own vocabulary", () => {
	const v = vocab(fixture("scene.md"));
	assert.deepEqual(v.characters, ["MARA", "KENI"]);
	assert.deepEqual(v.locations, ["Rialto Diner"]);
	assert.deepEqual(v.times, ["NIGHT"]);
});

// ── Classement des suggestions ──────────────────────────────────────────────

const rank = (names: string[], query: string) =>
	rankByQuery(names.map((text) => ({ text })), query).map((s) => s.text);

test("a query never matches the middle of a word", () => {
	// "IN" inside "MÉDECIN" was offering the doctor when typing a scene prefix.
	assert.deepEqual(rank(["INT.", "LE MÉDECIN ROYAL"], "IN"), ["INT."]);
});

test("a query does match the start of an inner word", () => {
	// Names here are several words long, so reaching CHAMBELLAN by typing
	// CHAM is the whole point.
	assert.deepEqual(rank(["LE GRAND CHAMBELLAN"], "CHAM"), ["LE GRAND CHAMBELLAN"]);
});

test("whole-name matches come before inner-word matches", () => {
	const out = rank(["LE ROI KAGI", "ROI ARTHUR"], "ROI");
	assert.deepEqual(out, ["ROI ARTHUR", "LE ROI KAGI"]);
});

test("punctuation inside a name is a word boundary", () => {
	assert.deepEqual(rank(["INT./EXT."], "EXT"), ["INT./EXT."]);
	assert.deepEqual(rank(["L'HOMME"], "HOM"), ["L'HOMME"]);
});

test("matching ignores case and accents are kept intact", () => {
	assert.deepEqual(rank(["LE MÉDECIN ROYAL"], "méd"), ["LE MÉDECIN ROYAL"]);
});

test("an empty query returns everything untouched", () => {
	assert.deepEqual(rank(["INT.", "EXT."], "  "), ["INT.", "EXT."]);
});
