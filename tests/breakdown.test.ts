/**
 * Live regression tests for the shot breakdown prompt.
 *
 * These call the real model, so they measure the prompt and the model together.
 * They exist so that swapping the model (or upgrading it) surfaces a regression
 * instead of quietly producing thinner breakdowns. They skip when Ollama is not
 * running or the model is not pulled, so an offline checkout still passes.
 *
 *   npm run test:live
 *   SLATE_TEST_MODEL=mistral:latest npm run test:live
 *
 * The whole suite shares one generation, because a 32b model takes a while.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { generateShotBreakdown, type Shot } from "../src/ollama.ts";
import { HOST, MODEL, fixture, liveSkipReason } from "./helpers.ts";

/**
 * The scene fixture holds roughly 22 distinct beats (entrances, reactions,
 * inserts, and four spoken lines). A model following the prompt splits
 * aggressively and lands well above this floor. A model that summarises instead
 * lands under it, which is exactly the regression worth catching.
 */
const MIN_SHOTS = 12;

const SHOT_SIZES = [
	"Extreme Wide Shot", "Wide Shot", "Medium Wide Shot", "Medium Shot",
	"Medium Close-Up", "Close-Up", "Extreme Close-Up", "Insert",
];

/** Abbreviations the prompt forbids in the camera field. */
const ACRONYMS = ["ECU", "CU", "MCU", "MS", "MWS", "WS", "EWS", "OTS", "POV"];

let skip: string | false = false;
let shots: Shot[] = [];

before(async () => {
	const reason = await liveSkipReason();
	if (reason) {
		skip = reason;
		return;
	}
	shots = await generateShotBreakdown(HOST, MODEL, fixture("scene.md"));
	console.log(`\n${MODEL}: ${shots.length} shots from the scene fixture\n`);
});

test("the breakdown is exhaustive rather than a summary", (t) => {
	if (skip) return t.skip(skip);
	assert.ok(
		shots.length >= MIN_SHOTS,
		`${MODEL} returned ${shots.length} shots, expected at least ${MIN_SHOTS}. ` +
			`The model is summarising instead of splitting one action per shot.`
	);
});

test("every shot carries the full schema", (t) => {
	if (skip) return t.skip(skip);
	for (const shot of shots) {
		assert.equal(typeof shot.number, "number", `bad number in ${JSON.stringify(shot)}`);
		for (const field of ["scene", "camera", "action", "description"] as const) {
			assert.equal(typeof shot[field], "string", `${field} missing on shot ${shot.number}`);
			assert.ok(shot[field].trim().length > 0, `${field} empty on shot ${shot.number}`);
		}
	}
});

test("shot numbers are sequential from one", (t) => {
	if (skip) return t.skip(skip);
	assert.deepEqual(
		shots.map((s) => s.number),
		shots.map((_, i) => i + 1)
	);
});

test("the camera field uses full words, never acronyms", (t) => {
	if (skip) return t.skip(skip);
	for (const shot of shots) {
		const size = shot.camera.split(" - ")[0].trim();
		assert.ok(
			!ACRONYMS.includes(size.toUpperCase()),
			`shot ${shot.number} uses the acronym ${JSON.stringify(size)} in the camera field`
		);
	}
});

test("most shots follow the size and movement format", (t) => {
	if (skip) return t.skip(skip);
	const wellFormed = shots.filter((s) => {
		const [size, movement] = s.camera.split(" - ").map((p) => p?.trim());
		return SHOT_SIZES.includes(size) && Boolean(movement);
	});
	const ratio = wellFormed.length / shots.length;
	assert.ok(
		ratio >= 0.8,
		`only ${wellFormed.length}/${shots.length} shots match "{Shot Size} - {Movement}". ` +
			`Offenders: ${shots.filter((s) => !wellFormed.includes(s)).map((s) => s.camera).join(", ")}`
	);
});

test("coverage varies the shot size", (t) => {
	if (skip) return t.skip(skip);
	const sizes = new Set(shots.map((s) => s.camera.split(" - ")[0].trim()));
	assert.ok(
		sizes.size >= 3,
		`only ${sizes.size} distinct shot size(s) used: ${[...sizes].join(", ")}`
	);
});

test("wikilinks from the source survive into the breakdown", (t) => {
	if (skip) return t.skip(skip);
	// restoreWikilinks in ollama.ts re-brackets names the model dropped, so this
	// asserts the pipeline result. It still catches a model that renames or
	// invents entities, because a renamed entity never gets re-bracketed.
	const all = shots
		.map((s) => `${s.scene} ${s.action} ${s.description} ${s.dialog ?? ""}`)
		.join(" ");
	for (const link of ["[[Keni]]", "[[Mara]]", "[[Rialto Diner]]"]) {
		assert.ok(all.includes(link), `${link} never appears in the breakdown`);
	}
});

test("spoken lines are captured as dialog", (t) => {
	if (skip) return t.skip(skip);
	const withDialog = shots.filter((s) => s.dialog && s.dialog.trim().length > 0);
	assert.ok(
		withDialog.length >= 3,
		`only ${withDialog.length} shot(s) carry dialog, the scene has four spoken lines`
	);
	const spoken = withDialog.map((s) => s.dialog!).join(" ").toLowerCase();
	for (const line of ["midnight", "does it matter"]) {
		assert.ok(spoken.includes(line), `the line ${JSON.stringify(line)} was dropped`);
	}
});

test("descriptions are rich enough to drive an image model", (t) => {
	if (skip) return t.skip(skip);
	const short = shots.filter((s) => s.description.trim().split(/\s+/).length < 8);
	assert.ok(
		short.length <= shots.length * 0.2,
		`${short.length}/${shots.length} descriptions are under eight words, too thin for image generation`
	);
});
