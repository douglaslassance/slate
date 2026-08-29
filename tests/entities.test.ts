/**
 * Offline tests for entity extraction. No Ollama needed.
 *
 * The roster decides what becomes a link, so the tests here are mostly about
 * what must NOT be on it. A false positive turns a piece of screen direction
 * into a character and litters the script with links to notes that will never
 * exist.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFountain } from "../src/fountain.ts";
import { extractRoster, findMentions, linkNames, namesIn } from "../src/fountain-entities.ts";
import { fixture } from "./helpers.ts";

const roster = (src: string) => extractRoster(parseFountain(src));

test("speakers come off the character cues", () => {
	const src = "MARA\nYou said midnight.\n\nKENI\nI said if I could.";
	assert.deepEqual(roster(src), ["MARA", "KENI"]);
});

test("a character introduced in caps but never speaking is still found", () => {
	// The case that breaks a cue-only roster: a wordless script.
	const src = "INT. TOILETTES - JOUR\n\nEntre le modele du tableau. LE ROI KAGI, quarante ans.";
	assert.deepEqual(roster(src), ["LE ROI KAGI"]);
});

test("screen direction is not mistaken for a character", () => {
	const src = "INT. DINER - NIGHT\n\nINSERT the brass key on the table.\n\nA MONTAGE of the city follows.";
	assert.deepEqual(roster(src), []);
});

test("a fully uppercase line is a mini slug, not an introduction", () => {
	// "CONTRE CHAMP" on its own line is a secondary slugline.
	const src = "INT. DINER - NIGHT\n\nCONTRE CHAMP\n\nLe roi plonge la main.";
	assert.deepEqual(roster(src), []);
});

test("accented capitals are recognised", () => {
	const src = "INT. PALAIS - JOUR\n\nIl consulte LE MEDECIN ROYAL, puis LE GRAND CHAMBELLAN.";
	assert.deepEqual(roster(src), ["LE MEDECIN ROYAL", "LE GRAND CHAMBELLAN"]);
});

test("runs shorter than three characters are ignored", () => {
	const src = "INT. DINER - NIGHT\n\nHe checks the TV and leaves.";
	assert.deepEqual(roster(src), []);
});

test("a name is listed once however often it appears", () => {
	const src = "INT. A - DAY\n\nBISCOTTE barks.\n\nAgain BISCOTTE barks.";
	assert.deepEqual(roster(src), ["BISCOTTE"]);
});

test("only capitalised mentions link, because that is what caps mean", () => {
	// A screenplay capitalises a name when it means the character. Matching
	// case insensitively turned "un homme qui va couper un ruban" into a link
	// to the man in the spacesuit, which is the whole reason for this rule.
	const src = "INT. PALAIS - JOUR\n\nUn HOMME entre.\n\nLe roi monte avec la gravité d'un homme.";
	const script = parseFountain(src);
	const mentions = findMentions(script, ["HOMME"]);
	assert.equal(mentions.length, 1);
	assert.equal(src.slice(mentions[0].start, mentions[0].end), "HOMME");
});

test("derived text still matches without regard to case", () => {
	// Shot text comes back from the model as ordinary prose, where the caps
	// convention does not hold, so the breakdown falls back to loose matching.
	assert.deepEqual(namesIn("Mara stares at keni.", ["Mara", "Keni"]), ["Mara", "Keni"]);
	assert.deepEqual(namesIn("Mara stares at keni.", ["Mara", "Keni"], true), ["Mara"]);
});

test("a partial word never matches", () => {
	// "le roi" alone must not become a link just because "LE ROI KAGI" is known.
	const src = "INT. PALAIS - JOUR\n\nLE ROI KAGI entre.\n\nLe roi fait des allers retours.";
	const script = parseFountain(src);
	const mentions = findMentions(script, extractRoster(script));
	assert.equal(mentions.length, 1);
});

test("the longer name wins when two roster names overlap", () => {
	const src = "INT. A - DAY\n\nLE ROI KAGI and LE ROI arrive.";
	const script = parseFountain(src);
	const mentions = findMentions(script, ["LE ROI", "LE ROI KAGI"]);
	assert.deepEqual(mentions.map((m) => m.name), ["LE ROI KAGI", "LE ROI"]);
});

test("mentions come back in document order", () => {
	const src = "INT. A - DAY\n\nBISCOTTE barks.\n\nMARA\nQuiet.\n\nBISCOTTE stops.";
	const script = parseFountain(src);
	const mentions = findMentions(script, ["BISCOTTE", "MARA"]);
	const starts = mentions.map((m) => m.start);
	assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
});

test("the real fixture yields its speaking cast", () => {
	assert.deepEqual(roster(fixture("scene.fountain")), ["MARA", "KENI"]);
});

// ── Liens dans le découpage ─────────────────────────────────────────────────

test("names are wrapped in wikilinks on the way into the breakdown", () => {
	// The script carries no brackets, but a breakdown is markdown and gains
	// the graph, backlinks and hover preview from them.
	assert.equal(
		linkNames("Mara stares at Keni.", ["Mara", "Keni"]),
		"[[Mara]] stares at [[Keni]]."
	);
});

test("the casing written in the prose is kept inside the link", () => {
	// Obsidian resolves both to the same note, and rewriting the prose to match
	// the roster would change the sentence.
	assert.equal(linkNames("MARA slams the door.", ["Mara"]), "[[MARA]] slams the door.");
});

test("only whole words are linked", () => {
	// The same rule the editor uses: "le roi" must not link inside "LE ROI KAGI",
	// and a name must not be found in the middle of another word.
	assert.equal(linkNames("Il maraude un peu.", ["Mara"]), "Il maraude un peu.");
});

test("the longer name wins where two overlap", () => {
	assert.equal(
		linkNames("LE ROI KAGI entre.", ["LE ROI", "LE ROI KAGI"]),
		"[[LE ROI KAGI]] entre."
	);
});

test("text with no known name is returned untouched", () => {
	assert.equal(linkNames("Rain falls.", ["Mara"]), "Rain falls.");
	assert.equal(linkNames("Rain falls.", []), "Rain falls.");
});
