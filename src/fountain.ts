/**
 * Fountain parser.
 *
 * Slate owns this rather than leaning on a Fountain plugin because the
 * breakdown pipeline needs the parse as data, and an Obsidian plugin cannot
 * import another plugin's internals. The same AST drives both the editor
 * decorations and the shot breakdown, so a scene heading means exactly one
 * thing across the whole plugin.
 *
 * Follows the Fountain 1.1 spec (https://fountain.io/syntax/) and nothing else.
 * The spec is frozen, so this is implemented once and left alone. Where the
 * spec is stricter than what screenwriters type, the spec wins: a line like
 * `FADE OUT.` is action, because it does not end in `TO:`, and the way to make
 * it a transition is the spec's own `>` prefix.
 */

export type ElementKind =
	| "scene-heading"
	| "action"
	| "character"
	| "dialogue"
	| "parenthetical"
	| "lyrics"
	| "transition"
	| "centered"
	| "section"
	| "synopsis"
	| "page-break";

export type EmphasisKind = "bold-italic" | "bold" | "italic" | "underline";

export interface Emphasis {
	kind: EmphasisKind;
	start: number;
	end: number;
}

/** A note, `[[like this]]`. Omitted from formatted output per the spec. */
export interface Note {
	text: string;
	start: number;
	end: number;
}

export interface Element {
	kind: ElementKind;
	text: string;
	start: number;
	end: number;
	line: number;
	depth?: number;
	name?: string;
	dual?: boolean;
	sceneNumber?: string;
	notes?: Note[];
	emphasis?: Emphasis[];
}

export interface Script {
	titlePage: Record<string, string>;
	elements: Element[];
	/**
	 * Every note in the document, in order.
	 *
	 * Notes standing on their own line are removed from `elements` per the
	 * spec, so this is the only complete list. `Element.notes` holds just the
	 * ones inline in that element.
	 */
	notes: Note[];
	titlePageLines: number;
	characters: string[];
	locations: string[];
}

// The spec fixes this prefix list. A leading "." forces a heading instead.
const SCENE_PREFIX_RE = /^(INT\.?\/EXT|INT|EXT|EST|I\/E)[.\s]/i;
const TRANSITION_RE = /^[A-Z0-9\s.'-]*TO:$/;
const SCENE_NUMBER_RE = /\s*#([A-Za-z0-9\-.]+)#\s*$/;
const NOTE_RE = /\[\[([\s\S]*?)\]\]/g;
const EMPHASIS_RE = /\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|_(.+?)_/g;

/**
 * Title page keys the spec names.
 *
 * A title page is only recognised when the document opens with one of these,
 * because plenty of real first lines have the `key: value` shape without being
 * a title page. `FADE IN:` is the obvious one, and swallowing it would hide the
 * first line of every script that has no title page.
 */
const TITLE_PAGE_KEYS = new Set([
	"title",
	"credit",
	"author",
	"authors",
	"source",
	"notes",
	"draft date",
	"date",
	"contact",
	"copyright",
]);

function blank(text: string): string {
	let out = "";
	for (const ch of text) out += ch === "\n" ? "\n" : " ";
	return out;
}

/**
 * Blank every `open ... close` span while preserving character offsets, so
 * ranges computed later still point at the right place in the original source.
 */
function blankPairs(source: string, open: string, close: string): string {
	let out = "";
	let i = 0;
	while (i < source.length) {
		const start = source.indexOf(open, i);
		if (start === -1) {
			out += source.slice(i);
			break;
		}
		out += source.slice(i, start);
		let end = source.indexOf(close, start + open.length);
		end = end === -1 ? source.length : end + close.length;
		out += blank(source.slice(start, end));
		i = end;
	}
	return out;
}

function findNotes(source: string): Note[] {
	const notes: Note[] = [];
	for (const m of source.matchAll(NOTE_RE)) {
		const start = m.index ?? 0;
		notes.push({ text: m[1].trim(), start, end: start + m[0].length });
	}
	return notes;
}

function findEmphasis(text: string, lineStart: number): Emphasis[] {
	const spans: Emphasis[] = [];
	for (const m of text.matchAll(EMPHASIS_RE)) {
		const at = m.index ?? 0;
		// A backslash escapes the marker, per the spec.
		if (at > 0 && text[at - 1] === "\\") continue;
		const kind: EmphasisKind =
			m[1] !== undefined
				? "bold-italic"
				: m[2] !== undefined
					? "bold"
					: m[3] !== undefined
						? "italic"
						: "underline";
		spans.push({ kind, start: lineStart + at, end: lineStart + at + m[0].length });
	}
	return spans;
}

/**
 * Drop note brackets but keep the text inside them.
 *
 * Names taken from the script are what entity resolution looks up in the
 * vault, so `[[Rialto Diner]]` has to reduce to `Rialto Diner` or the lookup
 * misses. Scripts written without brackets pass through untouched.
 */
function unbracket(text: string): string {
	return text.replace(/\[\[([^\]]*)\]\]/g, "$1");
}

function looksLikeCharacter(line: string): boolean {
	const bare = line
		.trim()
		.replace(/\^\s*$/, "")
		.replace(/\([^)]*\)\s*$/, "")
		.trim();
	if (!bare) return false;
	if (!/[A-Za-z]/.test(bare)) return false;
	return bare === bare.toUpperCase();
}

function characterName(line: string): string {
	return unbracket(line)
		.trim()
		.replace(/\^\s*$/, "")
		.replace(/\([^)]*\)\s*$/, "")
		.trim();
}

function headingLocation(text: string): string {
	let s = unbracket(text).trim().replace(/^\./, "");
	s = s.replace(SCENE_NUMBER_RE, "");
	s = s.replace(SCENE_PREFIX_RE, "");
	const dash = s.lastIndexOf(" - ");
	if (dash !== -1) s = s.slice(0, dash);
	return s.trim();
}

/**
 * Parse a Fountain document.
 *
 * The parse is line based with one line of lookahead, which is all the spec
 * needs: every ambiguous element (scene heading, character, transition) is
 * disambiguated by the blank lines around it.
 */
export function parseFountain(source: string): Script {
	const normalized = source.replace(/\r\n?/g, "\n");

	let scan = blankPairs(normalized, "/*", "*/");

	const notes = findNotes(scan);
	scan = blankPairs(scan, "[[", "]]");

	const lines = scan.split("\n");
	const rawLines = normalized.split("\n");

	const offsets: number[] = [];
	let running = 0;
	for (const line of lines) {
		offsets.push(running);
		running += line.length + 1;
	}

	const titlePage: Record<string, string> = {};
	let cursor = 0;

	// Only a title page when the very first line is a key, per the spec.
	const firstKey = (lines[0] ?? "").match(/^([A-Za-z ]+):/)?.[1].trim().toLowerCase();
	if (firstKey && TITLE_PAGE_KEYS.has(firstKey)) {
		let lastKey = "";
		while (cursor < lines.length && lines[cursor].trim() !== "") {
			const line = lines[cursor];
			const match = line.match(/^([A-Za-z ]+):\s*(.*)$/);
			if (match) {
				lastKey = match[1].trim().toLowerCase();
				titlePage[lastKey] = match[2].trim();
			} else if (lastKey && /^(\t| {3,})/.test(line)) {
				// Indented continuation, which the spec puts at 3+ spaces or a tab.
				titlePage[lastKey] = `${titlePage[lastKey]}\n${line.trim()}`.trim();
			}
			cursor++;
		}
		cursor++; // consume the blank line
	}

	const elements: Element[] = [];
	const characters: string[] = [];
	const locations: string[] = [];

	let inDialogue = false;

	const push = (kind: ElementKind, index: number, extra: Partial<Element> = {}) => {
		const raw = rawLines[index];
		const start = offsets[index];
		const el: Element = {
			kind,
			text: raw,
			start,
			end: start + raw.length,
			line: index,
			...extra,
		};
		const own = notes.filter((n) => n.start >= start && n.start < start + raw.length + 1);
		if (own.length > 0) el.notes = own;
		const spans = findEmphasis(raw, start);
		if (spans.length > 0) el.emphasis = spans;
		elements.push(el);
		return el;
	};

	const addHeading = (index: number) => {
		const raw = rawLines[index];
		const number = raw.trim().match(SCENE_NUMBER_RE)?.[1];
		const el = push("scene-heading", index, number ? { sceneNumber: number } : {});
		const loc = headingLocation(el.text);
		if (loc && !locations.includes(loc)) locations.push(loc);
	};

	for (let i = cursor; i < lines.length; i++) {
		const scanned = lines[i];
		const line = scanned.trim();
		const prevBlank = i === cursor || lines[i - 1].trim() === "";
		const nextBlank = i + 1 >= lines.length || lines[i + 1].trim() === "";

		if (line === "") {
			// A note-only line is removed in parsing, per the spec, so it must not break dialogue.
			if (rawLines[i].trim() !== "") continue;
			// Two spaces on a blank line keep a dialogue block open, per the spec.
			if (inDialogue && scanned.length >= 2) {
				push("dialogue", i);
				continue;
			}
			inDialogue = false;
			continue;
		}

		// Page break: three or more equals signs, nothing else.
		if (/^={3,}$/.test(line)) {
			inDialogue = false;
			push("page-break", i);
			continue;
		}

		const section = line.match(/^(#{1,6})\s*(.*)$/);
		if (section) {
			inDialogue = false;
			push("section", i, { depth: section[1].length });
			continue;
		}

		if (/^=[^=]/.test(line) || line === "=") {
			inDialogue = false;
			push("synopsis", i);
			continue;
		}

		if (line.startsWith("!")) {
			inDialogue = false;
			push("action", i);
			continue;
		}

		if (line.startsWith("@")) {
			const name = characterName(line.slice(1));
			push("character", i, { name, dual: /\^\s*$/.test(line) });
			if (name && !characters.includes(name)) characters.push(name);
			inDialogue = true;
			continue;
		}

		if (line.startsWith(".") && !line.startsWith("..")) {
			inDialogue = false;
			addHeading(i);
			continue;
		}

		if (line.startsWith(">") && line.endsWith("<")) {
			inDialogue = false;
			push("centered", i);
			continue;
		}

		if (line.startsWith(">")) {
			inDialogue = false;
			push("transition", i);
			continue;
		}

		// Lyrics are always forced with a tilde.
		if (line.startsWith("~")) {
			push("lyrics", i);
			continue;
		}

		// Scene heading by prefix. The spec wants a blank line on both sides.
		if (prevBlank && nextBlank && SCENE_PREFIX_RE.test(line)) {
			inDialogue = false;
			addHeading(i);
			continue;
		}

		if (prevBlank && nextBlank && TRANSITION_RE.test(line)) {
			inDialogue = false;
			push("transition", i);
			continue;
		}

		if (inDialogue && line.startsWith("(") && line.endsWith(")")) {
			push("parenthetical", i);
			continue;
		}

		if (inDialogue) {
			push("dialogue", i);
			continue;
		}

		if (prevBlank && !nextBlank && looksLikeCharacter(line)) {
			const name = characterName(line);
			push("character", i, { name, dual: /\^\s*$/.test(line) });
			if (name && !characters.includes(name)) characters.push(name);
			inDialogue = true;
			continue;
		}

		push("action", i);
	}

	return { titlePage, titlePageLines: cursor, elements, notes, characters, locations };
}

/**
 * Remove notes and boneyard, leaving what the spec says actually prints. Used
 * when handing a script to the model, so annotations never reach it.
 */
export function toPlainScript(source: string): string {
	let out = source.replace(/\r\n?/g, "\n");
	out = blankPairs(out, "/*", "*/");
	return out
		.replace(NOTE_RE, "")
		.split("\n")
		.map((l) => l.replace(/[ \t]+$/, ""))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
