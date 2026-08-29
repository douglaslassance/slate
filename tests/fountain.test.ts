/**
 * Offline tests for the Fountain parser. No Ollama needed.
 *
 * These pin the two things the rest of the plugin leans on. Every element
 * carries a source range that points at the right characters, and the
 * character roster comes out of the cues rather than out of a guess, because
 * entity linking resolves prose names against that roster.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFountain, toPlainScript } from "../src/fountain.ts";
import { fixture } from "./helpers.ts";

const find = (src: string, kind: string) =>
	parseFountain(src).elements.filter((e) => e.kind === kind);

test("scene headings are recognised by prefix", () => {
	const src = "INT. DINER - NIGHT\n\nRain falls.\n\nEXT. STREET - DAY\n\nHe walks.";
	const headings = find(src, "scene-heading");
	assert.equal(headings.length, 2);
	assert.equal(headings[0].text, "INT. DINER - NIGHT");
	assert.equal(headings[1].text, "EXT. STREET - DAY");
});

test("a leading period forces a scene heading", () => {
	const headings = find(".BLACK\n\nSilence.", "scene-heading");
	assert.equal(headings.length, 1);
	assert.equal(headings[0].text, ".BLACK");
});

test("a double period is an escape, not a heading", () => {
	const src = "..a literal period line\n";
	assert.equal(find(src, "scene-heading").length, 0);
	assert.equal(find(src, "action").length, 1);
});

test("character cues start a dialogue block", () => {
	const src = "INT. DINER - NIGHT\n\nMARA\nYou said midnight.\n\nHe shrugs.";
	const script = parseFountain(src);
	const kinds = script.elements.map((e) => e.kind);
	assert.deepEqual(kinds, ["scene-heading", "character", "dialogue", "action"]);
});

test("an uppercase line with no dialogue under it stays action", () => {
	// A blank line after the cue means there is nothing to speak, so it is action.
	const src = "INT. DINER - NIGHT\n\nMARA WALKS IN\n\nShe sits.";
	assert.equal(find(src, "character").length, 0);
});

test("cue extensions and dual dialogue markers are stripped from the name", () => {
	const src = "MARA (V.O.)\nHello.\n\nKENI ^\nHi.";
	const cues = find(src, "character");
	assert.equal(cues[0].name, "MARA");
	assert.equal(cues[1].name, "KENI");
	assert.equal(cues[1].dual, true);
});

test("parentheticals only count inside a dialogue block", () => {
	const src = "MARA\n(quietly)\nYou said midnight.\n\n(this is action)";
	assert.equal(find(src, "parenthetical").length, 1);
	assert.equal(find(src, "action").length, 1);
});

test("transitions need uppercase, a TO: ending, and blank lines around them", () => {
	const src = "He leaves.\n\nCUT TO:\n\nINT. STREET - DAY";
	assert.equal(find(src, "transition").length, 1);
	// The same words inside a paragraph are just action.
	assert.equal(find("He said CUT TO: and left.", "transition").length, 0);
});

test("sections carry their depth and synopses are distinct from page breaks", () => {
	const src = "# Act One\n\n## Sequence A\n\n= A quiet opening.\n\n===\n\nAction.";
	const script = parseFountain(src);
	const sections = script.elements.filter((e) => e.kind === "section");
	assert.deepEqual(sections.map((s) => s.depth), [1, 2]);
	assert.equal(find(src, "synopsis").length, 1);
	assert.equal(find(src, "page-break").length, 1);
});

test("boneyard content is excluded from the parse", () => {
	const src = "INT. DINER - NIGHT\n\n/*\nEXT. CUT SCENE - DAY\n\nDeleted.\n*/\n\nRain falls.";
	const script = parseFountain(src);
	assert.equal(script.elements.filter((e) => e.kind === "scene-heading").length, 1);
	assert.ok(!script.elements.some((e) => e.text.includes("CUT SCENE")));
});

test("element ranges point at the real source characters", () => {
	const src = "INT. DINER - NIGHT\n\nRain falls.\n\nMARA\nYou said midnight.";
	for (const el of parseFountain(src).elements) {
		assert.equal(src.slice(el.start, el.end), el.text, `bad range for ${el.kind}`);
	}
});

test("notes are captured with ranges that cover the brackets", () => {
	const src = "Rain falls on [[Keni]] as he waits.";
	const [action] = parseFountain(src).elements;
	assert.equal(action.notes?.length, 1);
	assert.equal(action.notes?.[0].text, "Keni");
	assert.equal(src.slice(action.notes![0].start, action.notes![0].end), "[[Keni]]");
});

test("the character roster comes from the cues, in first-appearance order", () => {
	const src = "MARA\nFirst.\n\nKENI\nSecond.\n\nMARA\nAgain.";
	assert.deepEqual(parseFountain(src).characters, ["MARA", "KENI"]);
});

test("locations come from scene headings with the time of day dropped", () => {
	const src = "INT. RIALTO DINER - NIGHT\n\nA beat.\n\nEXT. BACK ALLEY - DAY\n\nA beat.";
	assert.deepEqual(parseFountain(src).locations, ["RIALTO DINER", "BACK ALLEY"]);
});

test("names drop note brackets so they can be looked up in the vault", () => {
	// Entity resolution matches these against note titles, so [[...]] has to go.
	const src = "INT. [[Rialto Diner]] - NIGHT\n\nA beat.\n\nMARA [[beat]]\nHello.";
	const script = parseFountain(src);
	assert.deepEqual(script.locations, ["Rialto Diner"]);
	assert.deepEqual(script.characters, ["MARA"]);
});

test("a line holding only a note is removed and does not break dialogue", () => {
	// The spec removes such a line in parsing, along with the blank lines
	// around it, so the dialogue block either side stays one block.
	const src = "MARA\nYou said midnight.\n\n[[check this beat]]\n\nHe shrugs.";
	const script = parseFountain(src);
	assert.ok(!script.elements.some((e) => e.text.includes("check this beat")));
	assert.equal(script.elements.filter((e) => e.kind === "character").length, 1);
});

test("the title page reports how many lines it covers", () => {
	// It is deliberately absent from elements, so this is the only handle a
	// renderer has on it.
	const src = "Title: The Rialto\nAuthor: D. Lassance\n\nINT. DINER - NIGHT\n\nRain.";
	assert.equal(parseFountain(src).titlePageLines, 3);
	// No title page means no lines to style.
	assert.equal(parseFountain("INT. DINER - NIGHT\n\nRain.").titlePageLines, 0);
});

test("a file that is only a title page does not overrun the document", () => {
	// The count steps past a blank separator that is not there, which would
	// send a renderer one line past the end.
	const script = parseFountain("Title: The Rialto\nAuthor: D. Lassance");
	assert.ok(script.titlePageLines >= 2);
	assert.equal(script.elements.length, 0);
});

test("the title page is parsed and kept out of the elements", () => {
	const src = "Title: The Rialto\nAuthor: D. Lassance\n\nINT. DINER - NIGHT\n\nRain.";
	const script = parseFountain(src);
	assert.equal(script.titlePage.title, "The Rialto");
	assert.equal(script.titlePage.author, "D. Lassance");
	assert.equal(script.elements[0].kind, "scene-heading");
});

test("toPlainScript removes notes and boneyard but keeps the prose", () => {
	const src = "Rain falls on [[Keni]].\n\n/* cut this */\n\nHe waits.";
	const plain = toPlainScript(src);
	assert.ok(!plain.includes("[["));
	assert.ok(!plain.includes("cut this"));
	assert.ok(plain.includes("Rain falls on"));
	assert.ok(plain.includes("He waits."));
});

test("a scene heading needs a blank line on both sides", () => {
	// The spec requires one either side, which is what separates a heading
	// from an action line that merely opens with INT.
	assert.equal(find("INT. DINER - NIGHT\nRain falls.", "scene-heading").length, 0);
	assert.equal(find("INT. DINER - NIGHT\n\nRain falls.", "scene-heading").length, 1);
});

test("forcing a heading skips the blank line requirement", () => {
	// Forcing is an explicit instruction, so it is honoured on its own.
	assert.equal(find(".BLACK\nSilence falls.", "scene-heading").length, 1);
});

test("scene numbers are read off the end of a heading", () => {
	const src = "INT. DINER - NIGHT #1A#\n\nRain falls.";
	const [heading] = parseFountain(src).elements;
	assert.equal(heading.sceneNumber, "1A");
	// The number is not part of the location.
	assert.deepEqual(parseFountain(src).locations, ["DINER"]);
});

test("all the spec scene heading prefixes are recognised", () => {
	for (const prefix of ["INT.", "EXT.", "EST.", "I/E.", "INT/EXT.", "INT./EXT."]) {
		const src = `${prefix} SOMEWHERE - DAY\n\nA beat.`;
		assert.equal(find(src, "scene-heading").length, 1, `${prefix} not recognised`);
	}
});

test("only lines ending in TO: are transitions", () => {
	// The spec's whole rule. "FADE OUT." ends in a period, so it is action,
	// and the way to make it a transition is the spec's own ">" prefix.
	for (const t of ["CUT TO:", "DISSOLVE TO:", "SMASH CUT TO:"]) {
		const src = `A beat.\n\n${t}\n\nAnother beat.`;
		assert.equal(find(src, "transition").length, 1, `${t} not a transition`);
	}
	for (const t of ["FADE IN:", "FADE OUT.", "CUT TO BLACK."]) {
		const src = `A beat.\n\n${t}\n\nAnother beat.`;
		assert.equal(find(src, "transition").length, 0, `${t} wrongly a transition`);
	}
});

test("the > prefix is how a non-TO: line becomes a transition", () => {
	const src = "A beat.\n\n> FADE OUT.\n";
	assert.equal(find(src, "transition").length, 1);
});

test("inline emphasis is found with its markers", () => {
	const src = "> **PREMIERE PARTIE** <";
	const [centered] = parseFountain(src).elements;
	assert.equal(centered.kind, "centered");
	assert.equal(centered.emphasis?.length, 1);
	assert.equal(centered.emphasis?.[0].kind, "bold");
	assert.equal(src.slice(centered.emphasis![0].start, centered.emphasis![0].end), "**PREMIERE PARTIE**");
});

test("the four emphasis kinds are told apart", () => {
	const src = "***all*** **bold** *italic* _under_";
	const kinds = parseFountain(src).elements[0].emphasis?.map((e) => e.kind);
	assert.deepEqual(kinds, ["bold-italic", "bold", "italic", "underline"]);
});

test("a backslash escapes an emphasis marker", () => {
	const src = "A 5 \\*inch* blade.";
	assert.equal(parseFountain(src).elements[0].emphasis, undefined);
});

test("notes can span several lines", () => {
	const src = "Rain falls.\n\n[[a note\nacross two lines]]\n\nHe waits.";
	const { notes } = parseFountain(src);
	assert.equal(notes.length, 1);
	assert.equal(src.slice(notes[0].start, notes[0].end), "[[a note\nacross two lines]]");
});

test("two spaces on a blank line keep a dialogue block open", () => {
	// The spec's way of putting white space inside a speech.
	const src = "MARA\nFirst part.\n  \nStill speaking.";
	const kinds = parseFountain(src).elements.map((e) => e.kind);
	assert.deepEqual(kinds, ["character", "dialogue", "dialogue", "dialogue"]);
});

test("a genuinely blank line still ends dialogue", () => {
	const src = "MARA\nFirst part.\n\nShe leaves.";
	const kinds = parseFountain(src).elements.map((e) => e.kind);
	assert.deepEqual(kinds, ["character", "dialogue", "action"]);
});

test("a curly brace block is action, because the spec has no such syntax", () => {
	// Slugline appends one of these to every file it saves. The spec's way to
	// exclude content is the boneyard, so that is what has to be used.
	const src = "Rain falls.\n\n{{Slugline Document Settings}}";
	assert.equal(parseFountain(src).elements.filter((e) => e.kind === "action").length, 2);
	const boneyarded = "Rain falls.\n\n/*{{Slugline Document Settings}}*/";
	assert.equal(parseFountain(boneyarded).elements.length, 1);
});

test("title page continuations need three spaces or a tab", () => {
	const src = "Title: The Rialto\n   and its diner\nAuthor: D. Lassance\n\nAction.";
	const { titlePage } = parseFountain(src);
	assert.equal(titlePage.title, "The Rialto\nand its diner");
	assert.equal(titlePage.author, "D. Lassance");
});

test("the scene fixture parses into the elements the breakdown assumes", () => {
	const script = parseFountain(fixture("scene.fountain"));
	assert.deepEqual(script.characters, ["MARA", "KENI"]);
	assert.deepEqual(script.locations, ["Rialto Diner"]);
	assert.ok(script.elements.some((e) => e.kind === "dialogue"));
	// The fixture carries no brackets: a script declares no links, and the
	// names are recognised in the prose afterwards instead.
	assert.equal(script.notes.length, 0);
});
