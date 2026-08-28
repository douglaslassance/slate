import { copyFile, rm, mkdtemp } from "fs/promises";
import { tileImages, calculateColumns } from "./tile";
import { tmpdir } from "os";
import { join } from "path";
import { App, type Editor, MarkdownView, Notice, Plugin, TFile, normalizePath } from "obsidian";
import { DEFAULT_SETTINGS, SlateSettings, SlateSettingTab, resolveOllamaHost } from "./settings";
import { generateShotBreakdown, summarizeLinks, convertToFountain, splitScriptIntoChunks, MODEL, Shot } from "./ollama";
import { generateStoryboardImages } from "./mflux";
import { collectLinkContents } from "./vault";
import { fountainEditorExtension, FOUNTAIN_EXTENSION } from "./fountain-editor";
import { formatFountain, minimalEdit } from "./fountain-format";
import { fountainReadingProcessor } from "./fountain-reading";
import { FountainSuggest } from "./fountain-suggest";

const log = (...args: unknown[]) => console.log("[Slate]", ...args);

export default class SlatePlugin extends Plugin {
	settings: SlateSettings;
	/** CodeMirror save binding replaced so the keyboard path reaches the hook. */
	private originalCodeMirrorSave: (() => unknown) | null = null;
	/** Undoes whichever callback shape the save command turned out to use. */
	private restoreSaveCommand: (() => void) | null = null;

	/** Ollama host to talk to, defaulting when the setting is blank. */
	private get ollamaHost(): string {
		return resolveOllamaHost(this.settings.ollamaHost);
	}

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new SlateSettingTab(this.app, this));
		this.registerFountainSupport();

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
						this.ollamaHost,
						MODEL,
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
					this.ollamaHost,
					MODEL,
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

	onunload() {
		this.restoreSaveCommand?.();
		const adapter = (window as any).CodeMirrorAdapter;
		if (adapter?.commands && this.originalCodeMirrorSave) {
			adapter.commands.save = this.originalCodeMirrorSave;
		}
	}

	/**
	 * Open .fountain files in Obsidian's own markdown editor and paint them as
	 * screenplays.
	 *
	 * Reusing the markdown editor rather than registering a bespoke view keeps
	 * undo, search, and every other editor plugin working, and keeps the file a
	 * first-class vault citizen so wikilinks and the graph still see it.
	 *
	 * Another plugin may already own the extension. Obsidian throws in that
	 * case, so the editor layer is still registered and only the file
	 * association is skipped, leaving the other plugin in charge of opening.
	 */
	private registerFountainSupport(): void {
		let ownsExtension = true;
		try {
			this.registerExtensions([FOUNTAIN_EXTENSION], "markdown");
		} catch (err) {
			ownsExtension = false;
			log(`Could not claim .${FOUNTAIN_EXTENSION} files, another plugin owns them.`, err);
		}

		// Losing the extension is silent otherwise: the other plugin's view opens,
		// its formatting shows, and Slate's looks broken rather than absent. Say
		// so once at load, where it can actually be acted on.
		//
		// The owner is named because "another plugin" sends people hunting, and
		// the plugin that wins may have no settings tab, which makes it invisible
		// in the place they will look first.
		if (!ownsExtension) {
			const owner = this.fountainExtensionOwner();
			new Notice(
				`Slate: ${owner} already handles .${FOUNTAIN_EXTENSION} files, so Slate's screenplay formatting and character links are off. ` +
					`Turn it off in Settings > Community plugins, then fully quit and reopen Obsidian. Disabling alone does not release the file type.`,
				20000
			);
		}
		this.registerEditorExtension(fountainEditorExtension(this.app));
		// Reading mode does not go through CodeMirror, so it needs its own pass.
		this.registerMarkdownPostProcessor(fountainReadingProcessor(this.app));
		// Completions for cues, locations, times of day, and scene prefixes.
		this.registerEditorSuggest(new FountainSuggest(this.app));
		this.hookSaveCommand();

		this.addCommand({
			id: "format-fountain",
			name: "Format Fountain",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (file?.extension !== FOUNTAIN_EXTENSION) return false;
				if (checking) return true;
				void this.formatFountainFile(file).then((changed) => {
					new Notice(changed ? "Slate: Screenplay formatted." : "Slate: Already formatted.");
				});
				return true;
			},
		});
	}

	/**
	 * Name the plugin that owns the .fountain extension.
	 *
	 * Obsidian maps the extension to a view type, and every plugin declares the
	 * view types it registers, so the owner can be identified by working back
	 * from the registry. Falls back to a generic phrase if the internals move.
	 */
	private fountainExtensionOwner(): string {
		try {
			const app = this.app as any;
			const viewType = app.viewRegistry?.typeByExtension?.[FOUNTAIN_EXTENSION];
			if (!viewType) return "another plugin";

			for (const plugin of Object.values(app.plugins?.plugins ?? {}) as any[]) {
				if (plugin === this) continue;
				const views = plugin?._children ?? [];
				const owns = views.some((c: any) => c?.type === viewType);
				if (owns) return `the "${plugin.manifest?.name ?? plugin.manifest?.id}" plugin`;
			}

			return `another plugin (view type "${viewType}")`;
		} catch {
			return "another plugin";
		}
	}

	/**
	 * Run the formatter over one screenplay. Returns whether anything changed.
	 *
	 * Goes through the editor when the file is open so the cursor and scroll
	 * position survive. Falls back to the vault for a file that is not on screen.
	 */
	private async formatFountainFile(file: TFile): Promise<boolean> {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view?.file?.path === file.path) return formatInEditor(view.editor);

		const source = await this.app.vault.read(file);
		const formatted = formatFountain(source);
		if (formatted === source) return false;
		await this.app.vault.modify(file, formatted);
		return true;
	}

	/**
	 * Format on save, when the setting is on.
	 *
	 * Obsidian has no before-save event, so the save command is wrapped. The
	 * original is kept and restored on unload, so disabling Slate leaves the
	 * command exactly as it found it.
	 */
	private hookSaveCommand(): void {
		const commands = (this.app as any).commands;

		// Cmd/Ctrl+S inside the editor is handled by CodeMirror's own save
		// command, which does not route through app.commands, so wrapping the
		// command alone only ever fires from the palette. This redirect is done
		// first and unconditionally: it must not be skipped just because the
		// command turns out to have a shape we cannot wrap.
		const adapter = (window as any).CodeMirrorAdapter;
		if (adapter?.commands) {
			this.originalCodeMirrorSave = adapter.commands.save ?? null;
			adapter.commands.save = () => commands?.executeCommandById?.("editor:save-file");
		} else {
			log("CodeMirrorAdapter.commands is missing, so Cmd/Ctrl+S may not reach the hook.");
		}

		const saveCommand = commands?.commands?.["editor:save-file"];
		if (!saveCommand) {
			log("editor:save-file not found, so format on save is inactive.");
			return;
		}

		// Which of these Obsidian uses is not documented and has changed before,
		// so the shape is logged rather than assumed.
		log("editor:save-file shape:", {
			callback: typeof saveCommand.callback,
			checkCallback: typeof saveCommand.checkCallback,
			editorCallback: typeof saveCommand.editorCallback,
		});

		if (typeof saveCommand.callback === "function") {
			const original = saveCommand.callback.bind(saveCommand);
			this.restoreSaveCommand = () => {
				saveCommand.callback = original;
			};
			saveCommand.callback = async () => {
				this.formatActiveFountainEditor();
				await original();
			};
			return;
		}

		if (typeof saveCommand.checkCallback === "function") {
			const original = saveCommand.checkCallback.bind(saveCommand);
			this.restoreSaveCommand = () => {
				saveCommand.checkCallback = original;
			};
			saveCommand.checkCallback = (checking: boolean) => {
				if (checking) return original(true);
				this.formatActiveFountainEditor();
				return original(false);
			};
			return;
		}

		log("editor:save-file has no callback we can wrap, so format on save is inactive.");
	}

	/**
	 * Format the .fountain file in the active editor, for the save hook.
	 *
	 * Synchronous on purpose. It runs from inside the save command, so the
	 * formatting has to be finished before the save writes, and awaiting
	 * anything here would let the write win the race.
	 */
	private formatActiveFountainEditor(): boolean {
		if (!this.settings.formatFountainOnSave) return false;
		try {
			const file = this.app.workspace.getActiveFile();
			if (file?.extension !== FOUNTAIN_EXTENSION) return false;

			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (view?.file?.path !== file.path) return false;

			return formatInEditor(view.editor);
		} catch (err) {
			// A formatter failure must never block the save itself.
			log("Format on save failed.", err);
			return false;
		}
	}

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
			log(`Chunk ${c + 1}/${chunks.length}: ${chunkWords} words, sending to Ollama (${MODEL})…`);
			const chunkShots = await generateShotBreakdown(
				this.ollamaHost,
				MODEL,
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
				this.ollamaHost,
				MODEL,
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

/**
 * Format an open editor in place.
 *
 * The formatted text is applied as the smallest edit that produces it, rather
 * than by replacing the whole document. Replacing everything rebuilds the
 * editor, which drops the scroll position and the undo history and makes the
 * view jump to somewhere unrelated. A narrow edit is mapped through by the
 * editor itself, so the cursor and viewport need no restoring at all.
 *
 * Shared by the command and the save hook, which differ only in how they find
 * the file, not in what they do to it.
 */
function formatInEditor(editor: Editor): boolean {
	const source = editor.getValue();
	const edit = minimalEdit(source, formatFountain(source));
	if (!edit) return false;

	editor.replaceRange(edit.text, editor.offsetToPos(edit.from), editor.offsetToPos(edit.to));
	return true;
}

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
