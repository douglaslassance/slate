/**
 * Live Fountain formatting for the editor.
 *
 * `.fountain` files open in Obsidian's own markdown editor (see the extension
 * registration in main.ts), so undo, search, and every editor plugin keep
 * working. This adds a CodeMirror layer on top that classifies each line
 * through the shared parser and hands the styling to CSS.
 *
 * The whole document is reparsed on every change. A feature screenplay is
 * around 20k words, which parses in well under a frame, and reparsing keeps
 * the decorations honest when an edit high up changes what a line below means
 * (adding a blank line above an uppercase line turns it into a cue).
 */

import { type App, editorInfoField, editorLivePreviewField } from "obsidian";
import { RangeSetBuilder } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	EditorView,
	ViewPlugin,
	type ViewUpdate,
} from "@codemirror/view";
import { type Element, parseFountain } from "./fountain";
import { extractRoster, findMentions } from "./fountain-entities";

/** Files with this extension get screenplay formatting. */
export const FOUNTAIN_EXTENSION = "fountain";

const lineDeco = (kind: string) =>
	Decoration.line({ class: `slate-fountain-${kind}` });

const NOTE_DECO = Decoration.mark({ class: "slate-fountain-note" });

/** Hides a marker without removing it from the document. */
const HIDE_DECO = Decoration.replace({});

/**
 * Ranges of Fountain-only syntax on a line, which live preview should hide.
 *
 * Obsidian renders these files as markdown, so it already hides the ones that
 * happen to look like markdown: a leading `>` reads as a blockquote and `**`
 * reads as bold. It has no idea what the closing `<` of centered text means, so
 * it leaves it behind and the line renders as "FIN <". Hiding both ends here
 * makes the result consistent instead of half applied.
 */
function markerRanges(el: Element): { from: number; to: number }[] {
	const text = el.text;
	const trimmed = text.trim();
	const ranges: { from: number; to: number }[] = [];

	if (el.kind === "centered" && trimmed.startsWith(">") && trimmed.endsWith("<")) {
		const open = text.indexOf(">");
		let afterOpen = open + 1;
		while (afterOpen < text.length && text[afterOpen] === " ") afterOpen++;
		const close = text.lastIndexOf("<");
		let beforeClose = close;
		while (beforeClose > 0 && text[beforeClose - 1] === " ") beforeClose--;
		ranges.push({ from: el.start + open, to: el.start + afterOpen });
		ranges.push({ from: el.start + beforeClose, to: el.start + close + 1 });
	} else if (el.kind === "transition" && trimmed.startsWith(">")) {
		const open = text.indexOf(">");
		let after = open + 1;
		while (after < text.length && text[after] === " ") after++;
		ranges.push({ from: el.start + open, to: el.start + after });
	}

	return ranges.filter((r) => r.to > r.from);
}

const EMPHASIS_DECOS: Record<string, Decoration> = {
	"bold-italic": Decoration.mark({ class: "slate-fountain-bold-italic" }),
	bold: Decoration.mark({ class: "slate-fountain-bold" }),
	italic: Decoration.mark({ class: "slate-fountain-italic" }),
	underline: Decoration.mark({ class: "slate-fountain-underline" }),
};

/** True when the editor is showing a `.fountain` file. */
function isFountainFile(view: EditorView): boolean {
	const info = view.state.field(editorInfoField, false);
	return info?.file?.extension === FOUNTAIN_EXTENSION;
}

/**
 * Mark a resolved name so it reads as a link and the click handler can find
 * its target. The script on disk stays clean Fountain, with no brackets.
 */
const entityDeco = (name: string) =>
	Decoration.mark({
		class: "slate-fountain-entity",
		attributes: { "data-slate-entity": name },
	});

function buildDecorations(view: EditorView, app: App): DecorationSet {
	if (!isFountainFile(view)) return Decoration.none;

	const script = parseFountain(view.state.doc.toString());

	// Line decorations, inline marks, and notes come from three separate
	// passes, so they are collected and sorted rather than appended blind.
	// RangeSetBuilder requires ranges in start order, and a line decoration
	// has to precede any mark that begins at the same position.
	const pending: { from: number; to: number; isLine: boolean; deco: Decoration }[] = [];

	// The title page is not an element, so it would otherwise be the one part
	// of a screenplay left in the theme's proportional font.
	// The count steps past the blank separator, so it can land one beyond the
	// end in a file that is nothing but a title page. doc.line throws on that.
	const titleLines = Math.min(script.titlePageLines, view.state.doc.lines);
	for (let line = 0; line < titleLines; line++) {
		const at = view.state.doc.line(line + 1);
		pending.push({
			from: at.from,
			to: at.from,
			isLine: true,
			deco: lineDeco("title-page"),
		});
	}

	for (const el of script.elements) {
		// The one variant that needs its own styling.
		const cls = el.kind === "character" && el.dual ? "character-dual" : el.kind;
		pending.push({ from: el.start, to: el.start, isLine: true, deco: lineDeco(cls) });
		for (const span of el.emphasis ?? []) {
			const deco = EMPHASIS_DECOS[span.kind];
			if (deco) pending.push({ from: span.start, to: span.end, isLine: false, deco });
		}
	}

	// Taken from the document rather than per element, because a note on its
	// own line is removed from the parse but still needs dimming.
	for (const note of script.notes) {
		pending.push({ from: note.start, to: note.end, isLine: false, deco: NOTE_DECO });
	}

	// Live preview hides syntax; source mode shows it. And as everywhere in
	// Obsidian, the line under the cursor reveals its markers so it stays
	// editable.
	if (view.state.field(editorLivePreviewField, false)) {
		const selection = view.state.selection.main;
		for (const el of script.elements) {
			const lineFrom = el.start;
			const lineTo = el.end;
			if (selection.from <= lineTo && selection.to >= lineFrom) continue;
			for (const range of markerRanges(el)) {
				pending.push({ from: range.from, to: range.to, isLine: false, deco: HIDE_DECO });
			}
		}
	}

	// Only names that actually have a note are marked. A character with no
	// note stays plain text rather than becoming a dead link, which matters
	// because most proper nouns in a script will never get one.
	const sourcePath = view.state.field(editorInfoField, false)?.file?.path ?? "";
	const resolved = extractRoster(script).filter((name) =>
		Boolean(app.metadataCache.getFirstLinkpathDest(name, sourcePath))
	);
	for (const mention of findMentions(script, resolved)) {
		pending.push({
			from: mention.start,
			to: mention.end,
			isLine: false,
			deco: entityDeco(mention.name),
		});
	}

	pending.sort((a, b) => a.from - b.from || Number(b.isLine) - Number(a.isLine));

	const builder = new RangeSetBuilder<Decoration>();
	for (const p of pending) builder.add(p.from, p.to, p.deco);
	return builder.finish();
}

/** Path of the file this editor is showing, or null when there is none. */
function filePath(view: EditorView): string | null {
	return view.state.field(editorInfoField, false)?.file?.path ?? null;
}

/**
 * CodeMirror extensions that paint Fountain elements and make resolved names
 * clickable.
 *
 * A plain click follows the name, as it does for any other link in Obsidian,
 * and the platform modifier opens it in a new tab. Placing the caret inside a
 * resolved name therefore needs the keyboard or a click just beside it, which
 * is the same trade Obsidian makes for wikilinks in live preview.
 */
export function fountainEditorExtension(app: App): Extension {
	const plugin = ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			private path: string | null;

			constructor(view: EditorView) {
				this.decorations = buildDecorations(view, app);
				this.path = filePath(view);
			}

			update(update: ViewUpdate) {
				// Decorations already span the whole document, so scrolling
				// needs no work. Only an edit, or the same editor being handed
				// a different file, can invalidate them.
				const path = filePath(update.view);
				if (update.docChanged || update.selectionSet || path !== this.path) {
					this.path = path;
					this.decorations = buildDecorations(update.view, app);
				}
			}
		},
		{ decorations: (v) => v.decorations }
	);

	const clicks = EditorView.domEventHandlers({
		// mousedown rather than click: CodeMirror places the caret on mousedown,
		// so a handler on click arrives too late to stop it and leaves a stray
		// cursor behind before navigating.
		mousedown(event, view) {
			if (event.button !== 0) return false;

			const target = (event.target as HTMLElement | null)?.closest?.(
				"[data-slate-entity]"
			) as HTMLElement | null;
			const name = target?.dataset.slateEntity;
			if (!name) return false;

			const sourcePath = view.state.field(editorInfoField, false)?.file?.path ?? "";
			event.preventDefault();
			// Plain click follows the name, and the platform modifier opens it in a
			// new tab, which is what every other link in Obsidian does.
			void app.workspace.openLinkText(name, sourcePath, event.metaKey || event.ctrlKey);
			return true;
		},
	});

	return [plugin, clicks];
}
