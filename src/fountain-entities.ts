/**
 * Entity extraction for screenplays.
 *
 * Slate keeps the script itself clean Fountain, with no wikilink brackets, so
 * links are resolved at render time instead of being written into the file.
 * That needs a roster of names worth looking up, and the script supplies one
 * structurally rather than by guesswork.
 *
 * Two sources, because either alone misses real characters.
 *
 * Character cues name everyone who speaks. That is the obvious source and it
 * is exact, but it finds nobody in a wordless script.
 *
 * ALL CAPS inside an action line is how a screenplay introduces a character on
 * first appearance. That catches the ones who never speak. It only counts
 * inside a line that also has lower case text, because a line that is entirely
 * uppercase is a mini slug (`CONTRE CHAMP`), not an introduction.
 */

import type { Element, Script } from "./fountain.ts";

/**
 * Uppercase words that are screenplay vocabulary rather than names.
 *
 * These appear in action lines exactly where an introduction would, so without
 * this list `INSERT` reads as a recurring character.
 */
const SCREEN_DIRECTION = new Set([
	"ANGLE",
	"BACK TO SCENE",
	"BEAT",
	"BLACK",
	"CLOSE",
	"CLOSE ON",
	"CLOSER",
	"CONTINUOUS",
	"CUT",
	"CUT TO",
	"DISSOLVE",
	"ECU",
	"END",
	"EST",
	"EXT",
	"FADE",
	"FLASHBACK",
	"FLASH CUT",
	"FREEZE FRAME",
	"INSERT",
	"INT",
	"INTERCUT",
	"LATER",
	"MATCH CUT",
	"MOMENTS LATER",
	"MONTAGE",
	"OFF SCREEN",
	"ON SCREEN",
	"POV",
	"PAN",
	"PRELAP",
	"REVERSE ANGLE",
	"SERIES OF SHOTS",
	"SMASH CUT",
	"SUPER",
	"SUPERIMPOSE",
	"TITLE",
	"TIME CUT",
	"THE END",
	"TRACKING SHOT",
	"WIDE",
	"WIDER",
	"ZOOM",
]);

/** A name found in the script, with the range it occupies. */
export interface Mention {
	/** The roster name this mention belongs to. */
	name: string;
	start: number;
	end: number;
}

/**
 * Runs of capitals inside a line. Accented capitals count, so French and
 * Spanish scripts work, and internal apostrophes and hyphens stay attached.
 */
const CAPS_RUN_RE = /\p{Lu}[\p{Lu}\d'’-]*(?:\s+\p{Lu}[\p{Lu}\d'’-]*)*/gu;

/** True when a line is entirely uppercase, which makes it a slug not a name. */
function isAllCaps(line: string): boolean {
	return line === line.toUpperCase();
}

/**
 * Drop single letter words from the ends of a caps run.
 *
 * A capitalised article glues itself to whatever follows, so "A MONTAGE of the
 * city" yields the run "A MONTAGE", which slips past a filter looking for
 * "MONTAGE". Real names do not start or end on a single letter, so trimming
 * them costs nothing.
 */
function trimStrayInitials(run: string): string {
	const words = run.split(/\s+/).filter(Boolean);
	while (words.length > 0 && words[0].length === 1) words.shift();
	while (words.length > 0 && words[words.length - 1].length === 1) words.pop();
	return words.join(" ");
}

/**
 * Names worth resolving against the vault, in order of first appearance.
 *
 * Whether a note actually exists is the caller's business. This only decides
 * what counts as a name.
 */
export function extractRoster(script: Script): string[] {
	const roster: string[] = [];
	const seen = new Set<string>();

	const add = (name: string) => {
		const trimmed = trimStrayInitials(name.trim());
		// One and two letter runs are initials and noise, not introductions.
		if (trimmed.length < 3) return;
		if (SCREEN_DIRECTION.has(trimmed.toUpperCase())) return;
		const key = trimmed.toUpperCase();
		if (seen.has(key)) return;
		seen.add(key);
		roster.push(trimmed);
	};

	// Speakers first, so a character who both speaks and is introduced keeps
	// the spelling used in the cue.
	for (const name of script.characters) add(name);

	for (const el of script.elements) {
		if (el.kind !== "action") continue;
		const line = el.text.trim();
		if (!line || isAllCaps(line)) continue;
		for (const m of line.matchAll(CAPS_RUN_RE)) add(m[0]);
	}

	return roster;
}

/** Escape a name for use inside a regular expression. */
function escapeRe(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every mention of the given names in the script's prose.
 *
 * Matching is case insensitive on whole words, so an introduction in caps and
 * a later mention in mixed case both resolve. It is never fuzzy: only the full
 * roster name matches, so `LE ROI KAGI` does not turn every `le roi` in the
 * script into a link.
 */
/**
 * A pattern matching any of `names` as a whole word, case insensitively.
 *
 * Longer names first, so `LE ROI KAGI` wins over `LE ROI` where both are on
 * the roster. The lookarounds are what keep `le roi` from matching inside
 * `LE ROI KAGI`, and what keep this from being a substring search.
 */
function namePattern(names: string[]): RegExp {
	const ordered = [...names].sort((a, b) => b.length - a.length);
	return new RegExp(
		`(?<![\\p{L}\\d])(${ordered.map(escapeRe).join("|")})(?![\\p{L}\\d])`,
		"giu"
	);
}

/**
 * Which of `names` appear in a block of prose, in roster order.
 *
 * Used to work out which characters and locations a shot features, now that
 * the script carries no brackets to declare it. The shot text comes back from
 * the model as plain prose, so the names have to be recognised rather than
 * read off.
 */
export function namesIn(text: string, names: string[]): string[] {
	if (names.length === 0 || !text) return [];

	const byUpper = new Map(names.map((n) => [n.toUpperCase(), n]));
	const found = new Set<string>();
	for (const m of text.matchAll(namePattern(names))) {
		const name = byUpper.get(m[1].toUpperCase());
		if (name) found.add(name);
	}
	return names.filter((n) => found.has(n));
}

export function findMentions(script: Script, names: string[]): Mention[] {
	if (names.length === 0) return [];

	const pattern = namePattern(names);

	const mentions: Mention[] = [];
	const byUpper = new Map(names.map((n) => [n.toUpperCase(), n]));

	for (const el of script.elements) {
		// Structure lines are not prose, and a cue is already a name.
		if (el.kind === "section" || el.kind === "synopsis" || el.kind === "page-break") continue;

		for (const m of el.text.matchAll(pattern)) {
			const name = byUpper.get(m[1].toUpperCase());
			if (!name) continue;
			const at = el.start + (m.index ?? 0);
			mentions.push({ name, start: at, end: at + m[1].length });
		}
	}

	mentions.sort((a, b) => a.start - b.start);
	return mentions;
}

/** The spec's scene heading prefixes. */
export const SCENE_PREFIXES = ["INT.", "EXT.", "EST.", "INT./EXT.", "I/E."];

/**
 * Times of day offered before a script has established its own.
 *
 * Taken from what Slugline suggests, so the two agree. The spec says nothing
 * about the time slot, so this is convention rather than syntax, and it is
 * necessarily in English: a script written in another language builds its own
 * vocabulary as it goes, which is why these are appended after whatever the
 * script already uses rather than offered instead of it.
 */
export const DEFAULT_TIMES = [
	"DAY",
	"NIGHT",
	"MORNING",
	"AFTERNOON",
	"EVENING",
	"LATER",
	"MOMENTS LATER",
	"CONTINUOUS",
];

/** The time of day in a scene heading, which follows the last " - ". */
function headingTime(text: string): string | null {
	const dash = text.lastIndexOf(" - ");
	if (dash === -1) return null;
	const time = text.slice(dash + 3).replace(/\s*#[A-Za-z0-9\-.]+#\s*$/, "").trim();
	return time || null;
}

/**
 * What a script knows about its own vocabulary.
 *
 * A screenplay reuses the same dozen characters, handful of locations, and two
 * or three times of day throughout. Deriving all three from the script is what
 * lets completion work in a script that is not written in English: the French
 * script this was built against uses JOUR, NUIT, and CONTINU.
 */
export interface Vocabulary {
	characters: string[];
	locations: string[];
	times: string[];
	transitions: string[];
}

export function buildVocabulary(script: Script): Vocabulary {
	const times: string[] = [];
	const transitions: string[] = [];

	const remember = (list: string[], value: string) => {
		if (!list.some((v) => v.toUpperCase() === value.toUpperCase())) list.push(value);
	};

	for (const el of script.elements) {
		if (el.kind === "scene-heading") {
			const time = headingTime(el.text);
			if (time) remember(times, time);
			continue;
		}
		// Transitions already in the script, so the suggestion list matches the
		// spec's own shape (a line ending in TO:) rather than a guessed list of
		// which transitions exist.
		if (el.kind === "transition") {
			const text = el.text.trim().replace(/^>\s*/, "");
			if (text) remember(transitions, text);
		}
	}

	// The script's own words come first, then the defaults it has not used.
	// A French script therefore leads with JOUR and CONTINU, and still offers
	// something useful on a page that has no scene headings yet.
	for (const time of DEFAULT_TIMES) remember(times, time);

	return {
		characters: extractRoster(script),
		locations: script.locations,
		times,
		transitions,
	};
}

/**
 * Rank suggestions against what has been typed.
 *
 * Two tiers, and nothing looser. A name whose start matches comes first, then
 * a name where some word inside it starts with the query. Matching anywhere in
 * the string is too lax for a cast list: typing "IN" for a scene prefix
 * otherwise offers LE MÉDEC-IN ROYAL, which is noise at exactly the moment the
 * writer is going fast.
 *
 * Word starts still matter, because names here are mostly several words long
 * and reaching CHAMBELLAN by typing "CHAM" is the whole point.
 */
export function rankByQuery<T extends { text: string }>(items: T[], query: string): T[] {
	const needle = query.trim().toUpperCase();
	if (!needle) return items;

	const starts: T[] = [];
	const wordStarts: T[] = [];

	for (const item of items) {
		const text = item.text.toUpperCase();
		if (text.startsWith(needle)) {
			starts.push(item);
			continue;
		}
		// Split on anything that is not a letter or digit, so "INT./EXT."
		// yields INT and EXT, and "L'HOMME" yields L and HOMME.
		const words = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
		if (words.some((w) => w.startsWith(needle))) wordStarts.push(item);
	}

	return [...starts, ...wordStarts];
}

/**
 * Wrap every occurrence of `names` in Obsidian wikilinks.
 *
 * The script itself never carries brackets, because `[[...]]` is a Fountain
 * note there and would be dropped from the printed page. A breakdown is an
 * ordinary markdown note, where brackets cost nothing and buy the graph,
 * backlinks, hover preview, and a click that creates the note when it does not
 * exist yet. So the linking happens on the way out, not in the source.
 *
 * The original casing in the prose is kept, so `Mara` links as `[[Mara]]` and
 * `MARA` as `[[MARA]]`, both of which Obsidian resolves to the same note.
 */
export function linkNames(text: string, names: string[]): string {
	if (names.length === 0 || !text) return text;

	const known = new Set(names.map((n) => n.toUpperCase()));
	return text.replace(namePattern(names), (match) =>
		known.has(match.toUpperCase()) ? `[[${match}]]` : match
	);
}
