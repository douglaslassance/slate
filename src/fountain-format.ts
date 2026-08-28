/**
 * Fountain formatter.
 *
 * Normalises the things that have one correct form and leaves everything else
 * exactly as written. The formatter is driven by the parse, so it only touches
 * lines it has positively identified, and it never changes what a line means.
 *
 * Two rules are load bearing and worth stating plainly.
 *
 * Trailing whitespace is not free to strip. Two spaces on an otherwise blank
 * line are how the spec keeps a speech open, and how a note holds a blank
 * line. Trimming them turns dialogue into action, silently, several lines
 * later. Those lines are normalised to exactly two spaces rather than removed.
 *
 * Anything that changes an element's kind is out of scope. Turning a mini
 * slug like `CONTRE CHAMP` into a forced heading is a rewrite of meaning, not
 * of layout, so it belongs behind its own explicit command.
 */

// Extension included so Node's test runner can load this module directly.
// esbuild resolves it the same either way.
import { parseFountain } from "./fountain.ts";

/** Uppercase text while leaving `[[note]]` contents alone. */
function upperOutsideNotes(text: string): string {
	return text
		.split(/(\[\[[\s\S]*?\]\])/)
		.map((part, i) => (i % 2 === 1 ? part : part.toUpperCase()))
		.join("");
}

/**
 * Normalise the dashes in a scene heading.
 *
 * Doubled dashes and en or em dashes all become the single hyphen the format
 * expects. Single hyphens are left alone, because they appear inside real
 * location names.
 */
function normalizeHeadingDashes(text: string): string {
	return text.replace(/\s*[–—]\s*/g, " - ").replace(/\s*--+\s*/g, " - ");
}

/**
 * Line indices that must pass through untouched.
 *
 * Boneyard, curly blocks, and multi-line notes are verbatim regions, and the
 * title page has its own layout rules.
 */
function protectedLines(source: string, lines: string[]): Set<number> {
	const offsets: number[] = [];
	let running = 0;
	for (const line of lines) {
		offsets.push(running);
		running += line.length + 1;
	}
	const lineAt = (pos: number) => {
		let lo = 0;
		let hi = offsets.length - 1;
		while (lo < hi) {
			const mid = Math.ceil((lo + hi) / 2);
			if (offsets[mid] <= pos) lo = mid;
			else hi = mid - 1;
		}
		return lo;
	};

	const out = new Set<number>();
	const spans = [/\/\*[\s\S]*?\*\//g, /\{\{[\s\S]*?\}\}/g, /\[\[[\s\S]*?\]\]/g];
	for (const re of spans) {
		for (const m of source.matchAll(re)) {
			const from = lineAt(m.index ?? 0);
			const to = lineAt((m.index ?? 0) + m[0].length - 1);
			// A span inside one line does not protect that whole line.
			if (to > from) for (let i = from; i <= to; i++) out.add(i);
		}
	}

	// Title page: the leading key/value block, up to the first blank line.
	if (/^[A-Za-z ]+:/.test(lines[0] ?? "")) {
		for (let i = 0; i < lines.length && lines[i].trim() !== ""; i++) out.add(i);
	}

	return out;
}

/**
 * Format a Fountain document.
 *
 * Idempotent: formatting an already formatted script returns it unchanged.
 */
export function formatFountain(source: string): string {
	const normalized = source.replace(/\r\n?/g, "\n");
	const lines = normalized.split("\n");
	const script = parseFountain(normalized);
	const skip = protectedLines(normalized, lines);

	// Element kind by line, so each line is only touched when the parser has
	// positively identified it.
	const kindByLine = new Map<number, string>();
	for (const el of script.elements) kindByLine.set(el.line, el.kind);

	const formatted = lines.map((line, i) => {
		if (skip.has(i)) return line;

		// A whitespace-only line either carries meaning at two spaces, or is
		// just blank. Anything else loses its trailing run.
		if (line.trim() === "") return line.length >= 2 ? "  " : "";

		let out = line.replace(/[ \t]+$/, "");
		const kind = kindByLine.get(i);

		if (kind === "scene-heading") {
			out = normalizeHeadingDashes(upperOutsideNotes(out));
		} else if (kind === "character") {
			out = upperOutsideNotes(out);
		}

		return out;
	});

	// Rebuild the spacing rather than merely collapsing it. Fountain's own
	// layout is exactly one blank line between elements and none inside a
	// speech, and the parser knows which is which, so the formatter can be
	// opinionated here instead of preserving whatever was typed.
	//
	// This is safe only because it is driven by the parse and guarded by a test
	// asserting the sequence of element kinds is identical afterwards. Blank
	// lines are semantic in Fountain: one in the wrong place turns a cue into
	// action.
	// Lines that were already adjacent stay adjacent. Adjacency is meaningful:
	// consecutive action lines are one paragraph, and consecutive dialogue
	// lines are one speech. Inserting a blank between them would change how the
	// script prints even though the element kinds stay the same, which is the
	// one failure the safety test cannot see.
	const out: string[] = [];
	let prevLine: number | null = null;

	const separate = (line: number | null) => {
		if (out.length === 0) return;
		if (prevLine !== null && line !== null && line === prevLine + 1) return;
		if (out[out.length - 1] !== "") out.push("");
	};

	for (let i = 0; i < formatted.length; i++) {
		// Verbatim regions keep their own shape, including internal spacing.
		if (skip.has(i)) {
			const start = i;
			while (i < formatted.length && skip.has(i)) i++;
			separate(start);
			for (let j = start; j < i; j++) out.push(formatted[j]);
			prevLine = i - 1;
			i--;
			continue;
		}

		// A line the parser kept nothing for is spacing, and spacing is
		// regenerated rather than carried over.
		if (!kindByLine.has(i)) continue;

		separate(i);
		out.push(formatted[i]);
		prevLine = i;
	}

	// Exactly one trailing newline.
	return `${out.join("\n").replace(/\n+$/, "")}\n`;
}

/** A single replacement, as character offsets into the original text. */
export interface Edit {
	from: number;
	to: number;
	text: string;
}

/**
 * The smallest single replacement that turns `before` into `after`.
 *
 * Formatting a whole document and writing it back with setValue tears the
 * editor down and rebuilds it, which loses the scroll position, the selection,
 * and the undo history, and makes the view jump. Narrowing the change to the
 * span that actually differs lets the editor apply it as an ordinary edit and
 * map the cursor through it, so nothing moves that did not have to.
 *
 * The common prefix and suffix are trimmed at character level, which is enough
 * because the formatter's edits cluster: a save after typing in one scene
 * touches that scene and nothing else.
 *
 * Returns null when the two texts are identical.
 */
export function minimalEdit(before: string, after: string): Edit | null {
	if (before === after) return null;

	let start = 0;
	const shortest = Math.min(before.length, after.length);
	while (start < shortest && before[start] === after[start]) start++;

	// Walk the tails back, never crossing the prefix already matched.
	let endBefore = before.length;
	let endAfter = after.length;
	while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
		endBefore--;
		endAfter--;
	}

	return { from: start, to: endBefore, text: after.slice(start, endAfter) };
}
