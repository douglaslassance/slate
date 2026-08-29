import type { App } from "obsidian";
import type { Shot } from "./ollama.ts";
import { namesIn } from "./fountain-entities.ts";

export interface ResolvedLink {
	name: string;
	content: string;
}

/**
 * Look up the script's own names in the vault.
 *
 * A Fountain script carries no wikilinks: `[[...]]` is a note there, and notes
 * are stripped before the model ever sees the text. So the names are not
 * declared in the prose, they are recognised in it, from the roster the parse
 * produced. A name with no note behind it is simply skipped.
 */
export async function collectLinkContents(
	shots: Shot[],
	roster: string[],
	app: App
): Promise<ResolvedLink[]> {
	const allText = shots
		.flatMap((s) => [s.scene, s.action, s.description, s.dialog ?? ""])
		.join(" ");

	const results: ResolvedLink[] = [];
	for (const name of namesIn(allText, roster)) {
		const file = app.metadataCache.getFirstLinkpathDest(name, "");
		if (!file) continue;

		const raw = stripFrontmatter(await app.vault.cachedRead(file));
		if (raw) results.push({ name, content: raw });
	}

	return results;
}

/** Drop a note's YAML frontmatter, which is metadata rather than description. */
function stripFrontmatter(raw: string): string {
	return raw.replace(/^---[\s\S]*?---\n?/, "").trim();
}
