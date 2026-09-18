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
	private justCompleted: { line: number; ch: number; text: string } | null = null;

	constructor(app: App) {
		super(app);

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

		if (HEADING_START_RE.test(before)) {
			const dash = before.lastIndexOf(" - ");
			if (dash !== -1) {
				this.kinds = ["time"];
				return at(dash + 3);
			}

			const prefix = before.match(/^\s*(?:\.|(?:INT|EXT|EST|I\/E|INT\.?\/EXT)[.\s]\s*)/i);
			if (prefix && before.length >= prefix[0].length) {
				this.kinds = ["location"];
				return at(prefix[0].length);
			}
			return null;
		}

		if (before.trimEnd().length !== before.length) return null;

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
			return;
		}

		this.justCompleted = { line, ch, text: context.editor.getLine(line) };
		this.close();
	}
}
