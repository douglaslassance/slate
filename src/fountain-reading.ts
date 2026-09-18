/**
 * Fountain rendering for reading mode.
 *
 * The editor layer is CodeMirror, which covers source and live preview but
 * stops at reading mode. Reading mode goes through Obsidian's markdown
 * renderer instead, and a Fountain script run through a markdown renderer is
 * wrong in every way that matters. So the rendered output is discarded and the
 * block is rebuilt from the source text.
 *
 * Post processors run per block rather than per document, so each call rebuilds
 * only the lines it owns. `getSectionInfo` hands back the whole file plus the
 * line range for this block, which is what makes that possible.
 */

import { type App, type MarkdownPostProcessorContext, TFile } from "obsidian";
import { type Element, type Note, parseFountain, type Script } from "./fountain.ts";
import { extractRoster, findMentions, type Mention } from "./fountain-entities.ts";

export const FOUNTAIN_EXTENSION = "fountain";

let cached: { source: string; script: Script; mentions: Mention[] } | null = null;

function analyse(source: string, app: App, sourcePath: string) {
	if (cached && cached.source === source) return cached;

	const script = parseFountain(source);
	const resolved = extractRoster(script).filter((name) =>
		Boolean(app.metadataCache.getFirstLinkpathDest(name, sourcePath))
	);
	cached = { source, script, mentions: findMentions(script, resolved) };
	return cached;
}

interface Span {
	start: number;
	end: number;
	render: (parent: HTMLElement, text: string) => void;
}

const EMPHASIS_MARKER: Record<string, number> = {
	"bold-italic": 3,
	bold: 2,
	italic: 1,
	underline: 1,
};

function visibleRange(el: Element): { start: number; end: number } {
	const text = el.text;
	let start = 0;
	let end = text.length;

	// Leading whitespace is only meaningful in action, which keeps it.
	const lead = text.length - text.trimStart().length;
	if (el.kind !== "action") start = lead;

	const trimmed = text.trim();

	if (el.kind === "centered" && trimmed.startsWith(">") && trimmed.endsWith("<")) {
		start = text.indexOf(">") + 1;
		end = text.lastIndexOf("<");
	} else if (el.kind === "transition" && trimmed.startsWith(">")) {
		start = text.indexOf(">") + 1;
	} else if (el.kind === "scene-heading" && trimmed.startsWith(".") && !trimmed.startsWith("..")) {
		start = text.indexOf(".") + 1;
	} else if (el.kind === "character" && trimmed.startsWith("@")) {
		start = text.indexOf("@") + 1;
	} else if (el.kind === "action" && trimmed.startsWith("!")) {
		start = text.indexOf("!") + 1;
	} else if (el.kind === "lyrics" && trimmed.startsWith("~")) {
		start = text.indexOf("~") + 1;
	} else if (el.kind === "section") {
		start = text.indexOf("#") + (trimmed.match(/^#+/)?.[0].length ?? 1);
	} else if (el.kind === "synopsis" && trimmed.startsWith("=")) {
		start = text.indexOf("=") + 1;
	}

	while (start < end && text[start] === " ") start++;

	return { start: el.start + start, end: el.start + end };
}

function spansFor(
	el: Element,
	notes: Note[],
	mentions: Mention[],
	visible: { start: number; end: number }
): Span[] {
	const spans: Span[] = [];

	// Notes do not print, per the spec, so they are dropped rather than dimmed.
	for (const note of notes) {
		if (note.end <= visible.start || note.start >= visible.end) continue;
		spans.push({
			start: Math.max(note.start, visible.start),
			end: Math.min(note.end, visible.end),
			render: () => {},
		});
	}

	for (const span of el.emphasis ?? []) {
		if (span.start < visible.start || span.end > visible.end) continue;
		const marker = EMPHASIS_MARKER[span.kind] ?? 0;
		const tag = span.kind === "underline" ? "u" : span.kind === "italic" ? "em" : "strong";
		spans.push({
			start: span.start,
			end: span.end,
			render: (parent, text) => {
				const inner = text.slice(marker, text.length - marker);
				const node = parent.createEl(tag, { text: inner });
				if (span.kind === "bold-italic") node.addClass("slate-fountain-bold-italic");
			},
		});
	}

	for (const mention of mentions) {
		if (mention.start < visible.start || mention.end > visible.end) continue;
		spans.push({
			start: mention.start,
			end: mention.end,
			render: (parent, text) => {
				const a = parent.createEl("a", { cls: "internal-link slate-fountain-entity", text });
				a.setAttribute("href", mention.name);
				a.setAttribute("data-href", mention.name);
			},
		});
	}

	spans.sort((a, b) => a.start - b.start || b.end - a.end);

	const kept: Span[] = [];
	let cursor = -1;
	for (const span of spans) {
		if (span.start < cursor) continue;
		kept.push(span);
		cursor = span.end;
	}
	return kept;
}

function renderText(
	parent: HTMLElement,
	el: Element,
	spans: Span[],
	visible: { start: number; end: number }
): void {
	const slice = (from: number, to: number) => el.text.slice(from - el.start, to - el.start);

	let at = visible.start;
	for (const span of spans) {
		if (span.start > at) parent.appendText(slice(at, span.start));
		span.render(parent, slice(span.start, span.end));
		at = span.end;
	}
	if (at < visible.end) parent.appendText(slice(at, visible.end));
}

/**
 * The reading mode post processor, wired up from main.ts.
 *
 * Non-Fountain notes are left completely alone, including ones that merely
 * link to a screenplay.
 */
export function fountainReadingProcessor(app: App) {
	return (el: HTMLElement, ctx: MarkdownPostProcessorContext): void => {
		const file = app.vault.getAbstractFileByPath(ctx.sourcePath);
		if (!(file instanceof TFile) || file.extension !== FOUNTAIN_EXTENSION) return;

		const section = ctx.getSectionInfo(el);
		if (!section) return;

		const { script, mentions } = analyse(section.text, app, ctx.sourcePath);

		const mine = script.elements.filter(
			(e) => e.line >= section.lineStart && e.line <= section.lineEnd
		);
		if (mine.length === 0) {
			el.empty();
			return;
		}

		el.empty();
		el.addClass("slate-fountain-render");

		for (const element of mine) {
			const cls =
				element.kind === "character" && element.dual ? "character-dual" : element.kind;
			const line = el.createDiv({ cls: `slate-fountain-${cls}` });
			const visible = visibleRange(element);
			renderText(line, element, spansFor(element, script.notes, mentions, visible), visible);
		}
	};
}
