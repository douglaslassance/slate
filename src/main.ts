import { copyFile, rm, mkdtemp } from "fs/promises";
import { tileImages, calculateColumns } from "./tile";
import { tmpdir } from "os";
import { join } from "path";
import { App, Notice, Plugin, TFile, normalizePath } from "obsidian";
import { DEFAULT_SETTINGS, SlateSettings, SlateSettingTab } from "./settings";
import { generateShotBreakdown, summarizeLinks, convertToFountain, splitScriptIntoChunks, Shot } from "./ollama";
import { generateStoryboardImages } from "./mflux";
import { collectLinkContents } from "./vault";

const log = (...args: unknown[]) => console.log("[Slate]", ...args);

export default class SlatePlugin extends Plugin {
	settings: SlateSettings;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new SlateSettingTab(this.app, this));

		// ── Command: Generate shot breakdown ─────────────────────────
		this.addCommand({
			id: "generate-shot-breakdown",
			name: "Generate shot breakdown",
			callback: async () => {
				const activeFile = this.app.workspace.getActiveFile();
				if (!activeFile) {
					new Notice("Slate: No active file.");
					return;
				}

				const notice = new Notice("Slate: Generating shot breakdown…", 0);
				try {
					const { shots, breakdownFile } = await this.runShotBreakdown(activeFile, notice);
					notice.hide();
					await this.app.workspace.getLeaf(false).openFile(breakdownFile);
					new Notice(`Slate: Shot breakdown complete: ${shots.length} shots.`);
				} catch (err) {
					notice.hide();
					reportError(err);
				}
			},
		});

		// ── Command: Convert to Fountain ─────────────────────────────
		this.addCommand({
			id: "convert-to-fountain",
			name: "Convert to Fountain",
			callback: async () => {
				const activeFile = this.app.workspace.getActiveFile();
				if (!activeFile) {
					new Notice("Slate: No active file.");
					return;
				}

				const scriptText = (await this.app.vault.read(activeFile)).trim();
				if (!scriptText) {
					new Notice("Slate: The current note is empty.");
					return;
				}

				const notice = new Notice("Slate: Converting to Fountain…", 0);

				let fountain: string;
				try {
					fountain = await convertToFountain(
						this.settings.ollamaHost,
						this.settings.ollamaModel,
						scriptText,
						(msg) => notice.setMessage(`Slate: ${msg}`)
					);
				} catch (err) {
					notice.hide();
					new Notice(`Slate error: ${err instanceof Error ? err.message : String(err)}`, 8000);
					console.error("[Slate]", err);
					return;
				}

				notice.hide();

				const folder = activeFile.parent?.path ?? "";
				const fountainPath = normalizePath(`${folder}/${activeFile.basename}.fountain`);

				const existing = this.app.vault.getAbstractFileByPath(fountainPath);
				if (existing instanceof TFile) {
					await this.app.vault.modify(existing, fountain);
				} else {
					await this.app.vault.create(fountainPath, fountain);
				}

				new Notice(`Slate: Fountain file ready: ${fountainPath}`);
			},
		});

		// ── Command: Generate storyboard prompts ─────────────────────
		// Run from Breakdown.md — its parent is the scene root.
		this.addCommand({
			id: "generate-storyboard-prompts",
			name: "Generate storyboard prompts",
			callback: async () => {
				const activeFile = this.app.workspace.getActiveFile();
				if (!activeFile) {
					new Notice("Slate: No active file.");
					return;
				}

				const content = await this.app.vault.read(activeFile);
				const shots = parseShotsFromTable(content);

				if (shots.length === 0) {
					new Notice(
						'Slate: No shot breakdown table found. Run "Generate shot breakdown" first.',
						6000
					);
					return;
				}

				const notice = new Notice("Slate: Collecting links…", 0);
				const linkContents = await collectLinkContents(shots, this.app);
				notice.setMessage("Slate: Summarizing links…");
				const linkSummaries = await summarizeLinks(
					this.settings.ollamaHost,
					this.settings.ollamaModel,
					linkContents
				);
				notice.hide();

				const sceneVaultPath = activeFile.parent?.path ?? "";
				const storyboardFolderVaultPath = normalizePath(`${sceneVaultPath}/Storyboard`);
				const rendersVaultPath = normalizePath(`${storyboardFolderVaultPath}/Renders`);
				const promptsVaultPath = normalizePath(`${storyboardFolderVaultPath}/Prompts`);
				await ensureVaultFolder(storyboardFolderVaultPath, this.app);
				await ensureVaultFolder(rendersVaultPath, this.app);
				await ensureVaultFolder(promptsVaultPath, this.app);

				let firstFile: TFile | null = null;

				for (let i = 0; i < shots.length; i++) {
					const shot = shots[i];
					const shotName = (this.settings.storyboardImageName || "Shot #").replace("#", String(shot.number));
					const promptVaultPath = normalizePath(`${promptsVaultPath}/${shotName}.md`);

					const promptContent = buildShotPrompt(shot, linkSummaries, this.settings, shotName, rendersVaultPath, sceneVaultPath);
					const existing = this.app.vault.getAbstractFileByPath(promptVaultPath);
					let promptFile: TFile;
					if (existing instanceof TFile) {
						await this.app.vault.modify(existing, promptContent);
						promptFile = existing;
					} else {
						promptFile = await this.app.vault.create(promptVaultPath, promptContent);
					}
					if (!firstFile) firstFile = promptFile;
				}

				if (firstFile) {
					await this.app.workspace.getLeaf(false).openFile(firstFile);
				}
				new Notice(`Slate: Prompts ready: ${shots.length} shots.`);
			},
		});

		// ── Command: Generate storyboard ─────────────────────────────
		// Run from Breakdown.md, whose parent folder is the scene root.
		this.addCommand({
			id: "generate-storyboard-images",
			name: "Generate storyboard",
			callback: async () => {
				const activeFile = this.app.workspace.getActiveFile();
				if (!activeFile) {
					new Notice("Slate: No active file.");
					return;
				}

				const shots = parseShotsFromTable(await this.app.vault.read(activeFile));
				if (shots.length === 0) {
					new Notice(
						'Slate: No shot breakdown table found. Run "Generate shot breakdown" first.',
						6000
					);
					return;
				}

				const notice = new Notice("Slate: Generating storyboard…", 0);
				try {
					await this.runStoryboard(
						shots,
						activeFile.parent?.path ?? "",
						activeFile.parent?.name ?? activeFile.basename,
						notice
					);
					notice.hide();
					new Notice(`Slate: Storyboard ready: ${shots.length} shots.`);
				} catch (err) {
					notice.hide();
					reportError(err);
				}
			},
		});

		// ── Command: Generate storyboard from script ─────────────────
		// Both steps in one go: break the active script note down into shots, then
		// render the storyboard from those shots without a detour through
		// Breakdown.md. The breakdown note is still written and opened on the way.
		this.addCommand({
			id: "generate-storyboard-from-script",
			name: "Generate storyboard from script",
			callback: async () => {
				const activeFile = this.app.workspace.getActiveFile();
				if (!activeFile) {
					new Notice("Slate: No active file.");
					return;
				}

				const notice = new Notice("Slate: Generating shot breakdown…", 0);
				try {
					const { shots, breakdownFile, sceneVaultPath } =
						await this.runShotBreakdown(activeFile, notice);
					await this.app.workspace.getLeaf(false).openFile(breakdownFile);

					notice.setMessage("Slate: Generating storyboard…");
					await this.runStoryboard(shots, sceneVaultPath, activeFile.basename, notice);

					notice.hide();
					new Notice(`Slate: Storyboard ready: ${shots.length} shots.`);
				} catch (err) {
					notice.hide();
					reportError(err);
				}
			},
		});
	}

	onunload() {}

	/**
	 * Break a script note into shots and write Breakdown.md into its scene folder.
	 *
	 * Returns the shots alongside the scene folder they belong to, so a caller can
	 * carry straight on to the storyboard instead of re-parsing the markdown table.
	 */
	private async runShotBreakdown(
		scriptFile: TFile,
		notice: Notice
	): Promise<{ shots: Shot[]; breakdownFile: TFile; sceneVaultPath: string }> {
		const scriptText = (await this.app.vault.read(scriptFile)).trim();
		if (!scriptText) {
			throw new Error("The current note is empty.");
		}

		const chunks = splitScriptIntoChunks(scriptText, this.settings.breakdownChunkSize);
		const wordCount = scriptText.split(/\s+/).length;
		log(`${wordCount} words -> ${chunks.length} chunk(s) -> ${chunks.length} Ollama request(s).`);

		let shots: Shot[] = [];
		for (let c = 0; c < chunks.length; c++) {
			const chunk = chunks[c];
			const chunkWords = chunk.trim().split(/\s+/).length;
			const chunkLabel = chunks.length > 1 ? ` (part ${c + 1}/${chunks.length})` : "";
			log(`Chunk ${c + 1}/${chunks.length}: ${chunkWords} words, sending to Ollama (${this.settings.ollamaModel})…`);
			const chunkShots = await generateShotBreakdown(
				this.settings.ollamaHost,
				this.settings.ollamaModel,
				chunk,
				this.settings.breakdownLanguage,
				this.settings.breakdownCustomInstructions,
				(msg) => notice.setMessage(`Slate: ${msg}${chunkLabel}`)
			);
			log(`Chunk ${c + 1}/${chunks.length}: ${chunkShots.length} shots returned.`);
			shots.push(...chunkShots);
		}

		// Renumber shots sequentially across all chunks.
		shots = shots.map((s, i) => ({ ...s, number: i + 1 }));
		log(`Breakdown complete: ${shots.length} total shots.`);

		// Output: {output folder}/{basename}/Breakdown.md
		const baseName = scriptFile.basename;
		const folder = resolveOutputFolder(scriptFile, this.settings.breakdownOutputFolder);
		const sceneVaultPath = normalizePath(`${folder}/${baseName}`);
		const breakdownVaultPath = normalizePath(`${sceneVaultPath}/Breakdown.md`);

		await ensureVaultFolder(sceneVaultPath, this.app);

		const table = buildMarkdownTable(shots);
		const content = inlineTitle(this.app)
			? table
			: `# ${baseName} - Shot breakdown\n\n${table}`;

		const existing = this.app.vault.getAbstractFileByPath(breakdownVaultPath);
		let breakdownFile: TFile;
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
			breakdownFile = existing;
		} else {
			breakdownFile = await this.app.vault.create(breakdownVaultPath, content);
		}

		return { shots, breakdownFile, sceneVaultPath };
	}

	/**
	 * Write the prompt files and render an image for every shot into the scene
	 * folder, then either open the gallery note or composite the tiled PNG.
	 */
	private async runStoryboard(
		shots: Shot[],
		sceneVaultPath: string,
		sceneName: string,
		notice: Notice
	): Promise<void> {
		const storyboardFolderVaultPath = normalizePath(`${sceneVaultPath}/Storyboard`);
		const rendersVaultPath = normalizePath(`${storyboardFolderVaultPath}/Renders`);
		const promptsVaultPath = normalizePath(`${storyboardFolderVaultPath}/Prompts`);
		const storyboardNotePath = normalizePath(`${sceneVaultPath}/Storyboard.md`);
		const vaultBasePath = (this.app.vault.adapter as any).basePath as string;
		const sceneDiskPath = join(vaultBasePath, sceneVaultPath);
		const rendersDiskPath = join(vaultBasePath, rendersVaultPath);

		await ensureVaultFolder(storyboardFolderVaultPath, this.app);
		await ensureVaultFolder(rendersVaultPath, this.app);
		await ensureVaultFolder(promptsVaultPath, this.app);

		const tempDir = await mkdtemp(join(tmpdir(), "slate-"));

		try {
			// 1. Resolve wikilinks
			notice.setMessage("Slate: Collecting links…");
			const linkContents = await collectLinkContents(shots, this.app);
			log(`Found ${linkContents.length} wikilink(s) to summarize.`);
			notice.setMessage("Slate: Summarizing links…");
			if (linkContents.length > 0) {
				log(`Sending ${linkContents.length} link(s) to Ollama for summarization…`);
			}
			const linkSummaries = await summarizeLinks(
				this.settings.ollamaHost,
				this.settings.ollamaModel,
				linkContents
			);
			log(`Link summarization done: ${Object.keys(linkSummaries).length} summary/summaries.`);

			// 2. Build per-shot names and prompts
			const shotNames = shots.map((s) =>
				(this.settings.storyboardImageName || "Shot #").replace("#", String(s.number))
			);

			// Build natural-language prompts for FLUX's T5 encoder.
			// Order: character appearances, subject+action, framing, dialog.
			// FLUX weights earlier tokens more heavily, so subject comes first.
			// Wikilinks are stripped - mflux has no knowledge of them.

			const resolvedDescriptions = shots.map((s) => {
				const shotText = `${s.scene} ${s.action} ${s.description} ${s.dialog ?? ""}`;
				const featured = Object.entries(linkSummaries).filter(([name]) =>
					shotText.includes(`[[${name}]]`)
				);

				const sentences: string[] = [];

				// 1. Character visual descriptions - who is in the frame.
				if (featured.length > 0) {
					sentences.push(featured.map(([, summary]) => summary).join(" "));
				}

				// 2. Action + visual description as natural prose (subject front-loaded).
				sentences.push(`${stripLinks(s.action)} ${stripLinks(s.description)}`.trim());

				// 3. Camera framing - after subject so FLUX weights subject first.
				sentences.push(`Framing: ${normalizeDashes(stripLinks(s.camera))}.`);

				// 4. Dialog display instruction.
				if (s.dialog) {
					sentences.push(`Display this spoken line as legible on-screen text: "${stripLinks(s.dialog)}"`);
				}

				return sentences.join(" ");
			});

			// 3. Always write prompt files into Prompts/
			for (let i = 0; i < shots.length; i++) {
				const promptVaultPath = normalizePath(`${promptsVaultPath}/${shotNames[i]}.md`);
				const promptContent = buildShotPrompt(shots[i], linkSummaries, this.settings, shotNames[i], rendersVaultPath, sceneVaultPath);
				const existing = this.app.vault.getAbstractFileByPath(promptVaultPath);
				if (existing instanceof TFile) {
					await this.app.vault.modify(existing, promptContent);
				} else {
					await this.app.vault.create(promptVaultPath, promptContent);
				}
			}

			const outputAsImage = this.settings.storyboardOutputType === "image";

			// 4. Note mode: write the gallery note up front
			if (!outputAsImage) {
				const noteContent = inlineTitle(this.app)
					? buildGalleryNote(rendersVaultPath)
					: `# ${sceneName} - Storyboard\n\n${buildGalleryNote(rendersVaultPath)}`;
				const existingNote = this.app.vault.getAbstractFileByPath(storyboardNotePath);
				let storyboardFile: TFile;
				if (existingNote instanceof TFile) {
					await this.app.vault.modify(existingNote, noteContent);
					storyboardFile = existingNote;
				} else {
					storyboardFile = await this.app.vault.create(storyboardNotePath, noteContent);
				}
				await this.app.workspace.getLeaf(false).openFile(storyboardFile);
			}

			// 5. Generate images into temp dir, copy each to the Storyboard folder
			log(`Starting image generation: ${shots.length} shot(s) via mflux (${this.settings.mfluxModel}).`);
			const generatedImages = await generateStoryboardImages(
				shots,
				tempDir,
				this.settings,
				vaultBasePath,
				(msg, i, total) => notice.setMessage(`Slate: ${msg} (${i + 1}/${total})`),
				async ({ filePath, shot }) => {
					const idx = shots.findIndex((s) => s.number === shot.number);
					await copyFile(filePath, join(rendersDiskPath, `${shotNames[idx]}.png`));
				},
				resolvedDescriptions
			);

			// 6. Image mode: composite all shots into a single tiled PNG
			if (outputAsImage) {
				notice.setMessage("Slate: Compositing storyboard image…");
				const imagePaths = generatedImages.map((_, i) =>
					join(rendersDiskPath, `${shotNames[i]}.png`)
				);
				const columns = calculateColumns(
					imagePaths.length,
					this.settings.mfluxWidth,
					this.settings.mfluxHeight,
					this.settings.storyboardTilePadding,
					this.settings.storyboardTileOrientation ?? "portrait"
				);
				const tileDiskPath = join(sceneDiskPath, "Storyboard.png");
				await tileImages(
					imagePaths,
					tileDiskPath,
					columns,
					this.settings.storyboardTilePadding,
					this.settings.storyboardTileBackground
				);
			}
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Surface a failure to the user and log the full error to the console. */
function reportError(err: unknown): void {
	new Notice(`Slate error: ${err instanceof Error ? err.message : String(err)}`, 8000);
	console.error("[Slate]", err);
}

/**
 * Resolve the vault-relative parent folder for a new scene folder.
 *
 * Rules (matches the setting description):
 *  - Empty string  → same folder as the source file.
 *  - Starts with / → vault-root-relative (the leading slash is stripped).
 *  - Anything else → relative to the source file's folder.
 */
function resolveOutputFolder(sourceFile: TFile, outputFolderSetting: string): string {
	const raw = outputFolderSetting.trim();
	if (!raw) {
		return sourceFile.parent?.path ?? "";
	}
	if (raw.startsWith("/")) {
		// Vault-root path — strip the leading slash so normalizePath works correctly.
		return normalizePath(raw.slice(1));
	}
	// Relative to the source file's folder.
	const sourceFolder = sourceFile.parent?.path ?? "";
	return normalizePath(sourceFolder ? `${sourceFolder}/${raw}` : raw);
}

async function ensureVaultFolder(vaultPath: string, app: App): Promise<void> {
	if (!app.vault.getAbstractFileByPath(vaultPath)) {
		await app.vault.createFolder(vaultPath);
	}
}

const STRIP_LINKS_RE = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
const stripLinks = (text: string) => text.replace(STRIP_LINKS_RE, "$1");
const normalizeDashes = (text: string) => text.replace(/\s*[—–]\s*/g, " - ");

/** Build the markdown content for a single shot's prompt file. */
function buildShotPrompt(
	shot: Shot,
	linkSummaries: Record<string, string>,
	settings: SlateSettings,
	shotName: string,
	storyboardFolderVaultPath: string,
	sceneVaultPath: string
): string {
	const body: string[] = [];

	const shotText = `${shot.scene} ${shot.action} ${shot.description} ${shot.dialog ?? ""}`;
	const featured = Object.entries(linkSummaries).filter(([name]) =>
		shotText.includes(`[[${name}]]`)
	);

	if (settings.mfluxPromptHeader) {
		body.push(settings.mfluxPromptHeader.trim());
	}
	body.push(stripLinks(shot.scene));
	body.push(normalizeDashes(stripLinks(shot.camera)));
	body.push(stripLinks(shot.action));
	body.push(stripLinks(shot.description));
	if (shot.dialog) {
		body.push(stripLinks(shot.dialog));
	}
	if (featured.length > 0) {
		body.push(featured.map(([name, summary]) => `${name}: ${summary}`).join("\n\n"));
	}

	const imageEmbed = `![[${storyboardFolderVaultPath}/${shotName}.png]]`;
	const breakdownLink = `[[${sceneVaultPath}/Breakdown|← Breakdown]]`;

	return `\`\`\`\n${body.join("\n\n")}\n\`\`\`\n\n${imageEmbed}\n\n${breakdownLink}`;
}

function buildMarkdownTable(shots: Shot[]): string {
	const header =
		"| # | Scene | Camera | Action | Description | Dialog |\n" +
		"|---|-------|--------|--------|-------------|--------|";

	const rows = shots.map((s) =>
		`| ${s.number} | ${esc(s.scene)} | ${esc(s.camera)} | ${esc(s.action)} | ${esc(s.description)} | ${esc(s.dialog ?? "")} |`
	);

	return [header, ...rows].join("\n");
}

function esc(value: string | undefined | null): string {
	return (value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Returns true when Obsidian is configured to show the filename as an inline title. */
function inlineTitle(app: App): boolean {
	return (app.vault as any).config?.showInlineTitle !== false;
}

/** Build an img-gallery note pointing at the flat Storyboard folder. */
function buildGalleryNote(storyboardFolderVaultPath: string): string {
	return `\`\`\`img-gallery\ntype: vertical\nsort: asc\ncolumns: 1\npath: "${storyboardFolderVaultPath}"\n\`\`\``;
}

function parseShotsFromTable(content: string): Shot[] {
	const lines = content.split("\n");
	const shots: Shot[] = [];

	let colScene = 2, colCamera = 3, colAction = 4, colDesc = 5, colDialog = 6;
	for (const line of lines) {
		if (!line.startsWith("|")) continue;
		const cells = line.split("|").map((c) => c.trim().toLowerCase());
		if (cells.includes("scene") && cells.includes("action")) {
			colScene  = cells.indexOf("scene");
			colCamera = cells.indexOf("camera");
			colAction = cells.indexOf("action");
			colDesc   = cells.indexOf("description");
			colDialog = cells.indexOf("dialog");
			break;
		}
	}

	for (const line of lines) {
		if (!line.startsWith("|")) continue;
		const cells = line.split("|").map((c) => c.trim());
		const num = parseInt(cells[1]);
		if (isNaN(num)) continue;

		shots.push({
			number: num,
			scene:       cells[colScene]  ?? "",
			camera:      cells[colCamera] ?? "",
			action:      cells[colAction] ?? "",
			description: cells[colDesc]   ?? "",
			dialog:      cells[colDialog] || undefined,
		});
	}

	return shots;
}
