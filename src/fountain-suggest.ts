/**
 * Autocomplete for screenplays.
 *
 * Four things are worth completing while writing, and three of the four come
 * out of the script itself rather than a built-in list. A screenplay reuses its
 * own vocabulary constantly: the same dozen characters, the same handful of
 * locations, the same two or three times of day. Deriving them from the script
 * means this works in any language, which a hardcoded DAY/NIGHT list would not.
 * The French script that drove this uses JOUR, NUIT, and CONTINU.
 *
 * Only the scene heading prefixes are fixed, because the spec fixes them.
 *
 * `onTrigger` runs on every keypress, so it only ever looks at the current line
 * and the one above it. Parsing is deferred to `getSuggestions`, which runs
 * only when the popover is actually open, and is cached on the source text.
 */

import {
	type App,
	type Editor,
	type EditorPosition,
	EditorSuggest,
	type EditorSuggestContext,
	type EditorSuggestTriggerInfo,
	type TFile,
} from "obsidian";
import { parseFountain } from "./fountain.ts";
import { buildVocabulary, rankByQuery, SCENE_PREFIXES, type Vocabulary } from "./fountain-entities.ts";

const FOUNTAIN_EXTENSION = "fountain";

/** Matches a line that has already committed to being a scene heading. */
const HEADING_START_RE = /^\s*(?:\.|(?:INT|EXT|EST|I\/E|INT\.?\/EXT)[.\s])/i;

type SuggestionKind = "prefix" | "character" | "location" | "time" | "transition";

interface Suggestion {
	kind: SuggestionKind;
	text: string;
}

const KIND_LABEL: Record<SuggestionKind, string> = {
	prefix: "scene",
	character: "character",
	location: "location",
	time: "time",
	transition: "transition",
};

export class FountainSuggest extends EditorSuggest<Suggestion> {
	private cache: { source: string; vocab: Vocabulary } | null = null;
	private kinds: SuggestionKind[] = [];
	/**
	 * The editor state produced by the last completion.
	 *
	 * Accepting a suggestion leaves the line holding exactly the completed
	 * word, which is still a valid trigger, so the popover reopens on the one
	 * match that was just inserted. Declining that single state breaks the
	 * loop without suppressing anything the writer actually types next.
	 */
	private justCompleted: { line: number; ch: number; text: string } | null = null;

	constructor(app: App) {
		super(app);

		// Enter and click accept a suggestion by default, but Tab does not, and
		// Tab is what a writer reaches for. The scope is only live while the
		// popover is open, so this never interferes with Tab anywhere else.
		//
		// The suggestion container is internal, so the handler declines rather
		// than throwing if the shape ever changes, leaving Tab to do whatever
		// it would normally have done.
		this.scope.register([], "Tab", (event) => {
			if (event.isComposing) return true;
			const container = (this as unknown as { suggestions?: { useSelectedItem?: (e: KeyboardEvent) => void } })
				.suggestions;
			if (typeof container?.useSelectedItem !== "function") return true;
			container.useSelectedItem(event);
			return false;
		});
	}

	onTrigger(
		cursor: EditorPosition,
		editor: Editor,
		file: TFile | null
	): EditorSuggestTriggerInfo | null {
		if (file?.extension !== FOUNTAIN_EXTENSION) return null;

		const line = editor.getLine(cursor.line);

		if (
			this.justCompleted &&
			this.justCompleted.line === cursor.line &&
			this.justCompleted.ch === cursor.ch &&
			this.justCompleted.text === line
		) {
			return null;
		}
		this.justCompleted = null;

		const before = line.slice(0, cursor.ch);

		const at = (ch: number): EditorSuggestTriggerInfo => ({
			start: { line: cursor.line, ch },
			end: cursor,
			query: before.slice(ch),
		});

		// A scene heading is filled in three stages, and each stage leaves the
		// line ending in a separator, so trailing space here is expected rather
		// than a reason to stop suggesting.
		if (HEADING_START_RE.test(before)) {
			// Stage three: time of day, after the last " - ".
			const dash = before.lastIndexOf(" - ");
			if (dash !== -1) {
				this.kinds = ["time"];
				return at(dash + 3);
			}

			// Stage two: location, everything after the prefix. The query may be
			// empty, which is the moment right after the prefix was completed.
			const prefix = before.match(/^\s*(?:\.|(?:INT|EXT|EST|I\/E|INT\.?\/EXT)[.\s]\s*)/i);
			if (prefix && before.length >= prefix[0].length) {
				this.kinds = ["location"];
				return at(prefix[0].length);
			}
			return null;
		}

		// Anywhere else, a trailing space means the writer has moved past the
		// word and is not asking for a completion.
		if (before.trimEnd().length !== before.length) return null;

		// Stage one, and the head of any other element: a scene prefix, a
		// character, or a transition are all plausible, so the query decides.
		const indent = before.length - before.trimStart().length;
		const typed = before.slice(indent);
		if (typed.length < 1) return null;
		const prevBlank = cursor.line === 0 || editor.getLine(cursor.line - 1).trim() === "";
		if (!prevBlank) return null;

		this.kinds = ["prefix", "character", "transition"];
		return at(indent);
	}

	getSuggestions(context: EditorSuggestContext): Suggestion[] {
		const source = context.editor.getValue();
		if (!this.cache || this.cache.source !== source) {
			this.cache = { source, vocab: buildVocabulary(parseFountain(source)) };
		}
		const vocab = this.cache.vocab;

		const pool: Suggestion[] = [];
		for (const kind of this.kinds) {
			const items =
				kind === "prefix"
					? SCENE_PREFIXES
					: kind === "character"
						? vocab.characters
						: kind === "location"
							? vocab.locations
							: kind === "transition"
								? vocab.transitions
								: vocab.times;
			for (const text of items) pool.push({ kind, text });
		}

		return rankByQuery(pool, context.query);
	}

	renderSuggestion(value: Suggestion, el: HTMLElement): void {
		el.addClass("slate-fountain-suggestion");
		el.createSpan({ text: value.text });
		el.createSpan({ cls: "slate-fountain-suggestion-kind", text: KIND_LABEL[value.kind] });
	}

	selectSuggestion(value: Suggestion): void {
		const context = this.context;
		if (!context) return;

		// A prefix and a location are both mid-way through a scene heading, so
		// each one appends the separator the next stage needs and deliberately
		// leaves the popover free to reopen on that stage. Everything else
		// finishes the line.
		const chains = value.kind === "prefix" || value.kind === "location";
		const rest = context.editor.getLine(context.start.line).slice(context.end.ch);
		const suffix =
			value.kind === "prefix"
				? " "
				: value.kind === "location" && !rest.startsWith(" - ")
					? " - "
					: "";
		const insert = `${value.text}${suffix}`;

		context.editor.replaceRange(insert, context.start, context.end);
		const ch = context.start.ch + insert.length;
		const line = context.start.line;
		context.editor.setCursor({ line, ch });

		if (chains) {
			// The edit above already re-ran onTrigger, which opened the next
			// stage. Closing here would hide it until the next keystroke.
			return;
		}

		this.justCompleted = { line, ch, text: context.editor.getLine(line) };
		this.close();
	}
}
