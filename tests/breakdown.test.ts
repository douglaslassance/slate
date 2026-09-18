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

const MIN_SHOTS = 14;

/**
 * The fixture has four spoken lines and qwen filled all four in 16 of 17 runs.
 * The floor is 3 rather than 4 on purpose: asserting perfection on a model
 * sampled at temperature 0.7 flakes, and the regression this guards against
 * (dialogue landing in "action" instead) showed up as zero, not three. The
 * content check in the test below is the strict half.
 */
const MIN_SHOTS_WITH_DIALOG = 3;

const SPOKEN_LINES = [
	"you said midnight",
	"i said if i could",
	"whose is it",
	"does it matter",
];

const MIN_CAMERA_FORMAT_RATIO = 0.9;

const MIN_DISTINCT_SHOT_SIZES = 2;

const MAX_THIN_DESCRIPTION_RATIO = 0.15;

const SHOT_SIZES = [
	"Extreme Wide Shot", "Wide Shot", "Medium Wide Shot", "Medium Shot",
	"Medium Close-Up", "Close-Up", "Extreme Close-Up", "Insert",
];

const ACRONYMS = ["ECU", "CU", "MCU", "MS", "MWS", "WS", "EWS", "OTS", "POV"];

let skip: string | false = false;
let shots: Shot[] = [];

before(async () => {
	const reason = await liveSkipReason();
	if (reason) {
		skip = reason;
		return;
	}
	shots = await generateShotBreakdown(HOST, MODEL, fixture("scene.fountain"));
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
		ratio >= MIN_CAMERA_FORMAT_RATIO,
		`only ${wellFormed.length}/${shots.length} shots match "{Shot Size} - {Movement}", expected ${MIN_CAMERA_FORMAT_RATIO * 100}%. ` +
			`Offenders: ${shots.filter((s) => !wellFormed.includes(s)).map((s) => s.camera).join(", ")}`
	);
});

test("coverage varies the shot size", (t) => {
	if (skip) return t.skip(skip);
	const sizes = new Set(shots.map((s) => s.camera.split(" - ")[0].trim()));
	assert.ok(
		sizes.size >= MIN_DISTINCT_SHOT_SIZES,
		`only ${sizes.size} distinct shot size(s) used: ${[...sizes].join(", ")}`
	);
});

test("names from the source survive into the breakdown", (t) => {
	// Fountain declares no links, so names must arrive as plain prose for resolution.
	if (skip) return t.skip(skip);
	const text = shots
		.flatMap((s) => [s.scene, s.action, s.description, s.dialog ?? ""])
		.join(" ");
	for (const name of ["Keni", "Mara", "Rialto Diner"]) {
		assert.match(text, new RegExp(name, "i"), `${name} vanished from the breakdown`);
	}
});

test("spoken lines are captured as dialog", (t) => {
	if (skip) return t.skip(skip);
	const withDialog = shots.filter((s) => s.dialog && s.dialog.trim().length > 0);
	const spoken = withDialog.map((s) => s.dialog!).join(" ").toLowerCase();

	const missing = SPOKEN_LINES.filter((line) => !spoken.includes(line));
	assert.deepEqual(
		missing,
		[],
		`${missing.length} spoken line(s) never reached a dialog field: ${missing.join(" / ")}. ` +
			`The model is most likely putting them in the action field instead.`
	);

	assert.ok(
		withDialog.length >= MIN_SHOTS_WITH_DIALOG,
		`only ${withDialog.length} shot(s) carry dialog, expected at least ${MIN_SHOTS_WITH_DIALOG}`
	);
});

test("descriptions are rich enough to drive an image model", (t) => {
	if (skip) return t.skip(skip);
	const short = shots.filter((s) => s.description.trim().split(/\s+/).length < 8);
	assert.ok(
		short.length <= shots.length * MAX_THIN_DESCRIPTION_RATIO,
		`${short.length}/${shots.length} descriptions are under eight words, too thin for image generation`
	);
});
