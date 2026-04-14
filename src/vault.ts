import type { App } from "obsidian";
import type { Shot } from "./ollama";

const WIKILINK_RE = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;

export interface ResolvedLink {
	name: string;
	content: string;
}

/** Structured result of wikilink resolution for a single shot. */
export interface ResolvedPromptData {
	action: string;
	description: string;
	links: ResolvedLink[];
}

/**
 * Scan all shots for [[wikilinks]], read each linked vault note, and return
 * an array of unique {name, content} pairs — ready to be sent to Ollama for summarization.
 */
export async function collectLinkContents(shots: Shot[], app: App): Promise<ResolvedLink[]> {
	const visited = new Set<string>();
	const results: ResolvedLink[] = [];

	const allText = shots.flatMap((s) => [s.action, s.description, s.dialog ?? ""]).join(" ");

	for (const match of allText.matchAll(WIKILINK_RE)) {
		const linkpath = match[1].trim();
		if (visited.has(linkpath)) continue;
		visited.add(linkpath);

		const file = app.metadataCache.getFirstLinkpathDest(linkpath, "");
		if (!file) continue;

		let raw = await app.vault.cachedRead(file);
		raw = raw.replace(/^---[\s\S]*?---\n?/, "").trim();
		if (raw) results.push({ name: linkpath, content: raw });
	}

	return results;
}

/**
 * Recursively resolve [[wikilinks]] from vault notes.
 * Used internally — returns flat resolved text suitable for nesting into a parent note.
 */
async function resolveLinksRecursive(
	text: string,
	app: App,
	maxDepth: number,
	visited: Set<string>
): Promise<string> {
	if (maxDepth === 0) return text;

	const entries: ResolvedLink[] = [];
	const targets = new Set<string>();

	for (const match of text.matchAll(WIKILINK_RE)) {
		targets.add(match[1].trim());
	}

	for (const linkpath of targets) {
		if (visited.has(linkpath)) continue;

		const file = app.metadataCache.getFirstLinkpathDest(linkpath, "");
		if (!file) continue;

		visited.add(linkpath);

		let raw = await app.vault.cachedRead(file);
		raw = raw.replace(/^---[\s\S]*?---\n?/, "").trim();

		const resolved = await resolveLinksRecursive(raw, app, maxDepth - 1, visited);
		entries.push({ name: linkpath, content: resolved });
	}

	if (entries.length === 0) return text;

	const contextBlock = entries.map(({ name, content }) => `[${name}]\n${content}`).join("\n\n");
	return `${text}\n\n${contextBlock}`;
}

/**
 * Resolve all [[wikilinks]] found in a shot's action, description, and dialog fields.
 * Returns structured data — callers decide how to format it (plain text or markdown).
 *
 * @param action      Shot action text.
 * @param description Shot description text.
 * @param dialog      Shot dialog text (scanned for links but not included in output).
 * @param app         Obsidian App instance.
 * @param maxDepth    How many levels deep to recurse (default 2).
 */
export async function resolvePromptData(
	action: string,
	description: string,
	dialog: string,
	app: App,
	maxDepth = 2
): Promise<ResolvedPromptData> {
	const visited = new Set<string>();
	const targets = new Set<string>();
	const scanText = `${action} ${description} ${dialog}`;

	for (const match of scanText.matchAll(WIKILINK_RE)) {
		targets.add(match[1].trim());
	}

	const links: ResolvedLink[] = [];
	for (const linkpath of targets) {
		if (visited.has(linkpath)) continue;

		const file = app.metadataCache.getFirstLinkpathDest(linkpath, "");
		if (!file) continue;

		visited.add(linkpath);

		let raw = await app.vault.cachedRead(file);
		raw = raw.replace(/^---[\s\S]*?---\n?/, "").trim();

		const resolved = await resolveLinksRecursive(raw, app, maxDepth - 1, visited);
		links.push({ name: linkpath, content: resolved });
	}

	return { action, description, links };
}
