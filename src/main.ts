import { copyFile, rm, mkdtemp } from "fs/promises";
import { tileImages } from "./tile";
import { tmpdir } from "os";
import { join } from "path";
import { App, Notice, Plugin, TFile, normalizePath } from "obsidian";
import { DEFAULT_SETTINGS, SlateSettings, SlateSettingTab } from "./settings";
import { generateShotBreakdown, summarizeLinks, convertToFountain, Shot } from "./ollama";
import { generateStoryboardImages } from "./mflux";
import { collectLinkContents } from "./vault";

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

				const scriptText = (await this.app.vault.read(activeFile)).trim();
				if (!scriptText) {
					new Notice("Slate: The current note is empty.");
					return;
				}

				const notice = new Notice("Slate: Generating shot breakdown…", 0);

				let shots: Shot[];
				try {
					shots = await generateShotBreakdown(
						this.settings.ollamaHost,
						this.settings.ollamaModel,
						scriptText,
						this.settings.breakdownLanguage,
						this.settings.breakdownCustomInstructions,
						(msg) => notice.setMessage(`Slate: ${msg}`)
					);
				} catch (err) {
					notice.hide();
					new Notice(`Slate error: ${err instanceof Error ? err.message : String(err)}`, 8000);
					console.error("[Slate]", err);
					return;
				}

				notice.hide();

				// Create a new note next to the original: "<Script Name> - Shot Breakdown.md"
				const baseName = activeFile.basename;
				const folder = activeFile.parent?.path ?? "";
				const breakdownPath = normalizePath(`${folder}/${baseName} - Shot Breakdown.md`);

				const table = buildMarkdownTable(shots);
				const content = inlineTitle(this.app)
					? table
					: `# ${baseName} — Shot breakdown\n\n${table}`;

				const existing = this.app.vault.getAbstractFileByPath(breakdownPath);
				let breakdownFile: TFile;
				if (existing instanceof TFile) {
					await this.app.vault.modify(existing, content);
					breakdownFile = existing;
				} else {
					breakdownFile = await this.app.vault.create(breakdownPath, content);
				}

				await this.app.workspace.getLeaf(false).openFile(breakdownFile);
				new Notice(`Slate: Shot breakdown complete — ${shots.length} shots.`);
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

				new Notice(`Slate: Fountain file ready — ${fountainPath}`);
			},
		});

		// ── Command: Generate storyboard prompts ─────────────────────
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

				const baseName = activeFile.basename.replace(/ Shot Breakdown$/, "");
				const folder = activeFile.parent?.path ?? "";
				const promptsPath = normalizePath(`${folder}/${baseName} Prompts.md`);

				const lines: string[] = [];
				for (let i = 0; i < shots.length; i++) {
					const shot = shots[i];
					const body: string[] = [];

					const shotText = `${shot.action} ${shot.description} ${shot.dialog ?? ""}`;
					const featured = Object.entries(linkSummaries).filter(([name]) =>
						shotText.includes(`[[${name}]]`)
					);

					if (this.settings.mfluxPromptHeader) {
						body.push(`### Art style\n${this.settings.mfluxPromptHeader.trim()}`);
					}
					if (featured.length > 0) {
						body.push(
							`### Featured in this shot\n${featured.map(([name, summary]) => `[[${name}]]: ${summary}`).join("\n\n")}`
						);
					}
					body.push(`### Location\n${shot.scene}`);
					body.push(`### Camera\n${shot.camera}`);
					body.push(`### Action\n${shot.action}`);
					body.push(`### Description\n${shot.description}`);
					if (shot.dialog) {
						body.push(`### Dialog\n${shot.dialog}`);
					}
					if (i > 0) {
						const prev = shots[i - 1];
						body.push(`### Previous shot\n${prev.action}\n\n${prev.description}`);
					}
					if (shot.dialog) {
						body.push(`### Instructions\nSingle cinematic frame. Not a comic strip or panel sequence. The speaking character must be prominently featured. Display the dialog as visible text in the image — as a speech bubble, caption, or subtitle.`);
					} else {
						body.push(`### Instructions\nSingle cinematic frame. Not a comic strip or panel sequence.`);
					}

					lines.push(`## Shot ${shot.number}\n\n\`\`\`\n${body.join("\n\n")}\n\`\`\``);
				}

				const promptsContent = inlineTitle(this.app)
					? lines.join("\n\n")
					: `# ${baseName} — Storyboard prompts\n\n${lines.join("\n\n")}`;

				const existing = this.app.vault.getAbstractFileByPath(promptsPath);
				let promptsFile: TFile;
				if (existing instanceof TFile) {
					await this.app.vault.modify(existing, promptsContent);
					promptsFile = existing;
				} else {
					promptsFile = await this.app.vault.create(promptsPath, promptsContent);
				}

				await this.app.workspace.getLeaf(false).openFile(promptsFile);
				new Notice(`Slate: Prompts ready — ${shots.length} shots.`);
			},
		});

		// ── Command: Generate storyboard ─────────────────────────────
		this.addCommand({
			id: "generate-storyboard-images",
			name: "Generate storyboard",
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

				const notice = new Notice("Slate: Generating storyboard…", 0);

				// Derive paths
				const baseName = activeFile.basename.replace(/ Shot Breakdown$/, "");
				const folder = activeFile.parent?.path ?? "";
				const imagesFolderVaultPath = normalizePath(`${folder}/${baseName} Storyboard`);
				const storyboardNotePath = normalizePath(`${folder}/${baseName} Storyboard.md`);

				// Ensure the vault images folder exists
				const existingFolder = this.app.vault.getAbstractFileByPath(imagesFolderVaultPath);
				if (!existingFolder) {
					await this.app.vault.createFolder(imagesFolderVaultPath);
				}

				// Absolute path to the vault images folder on disk
				const vaultBasePath = (this.app.vault.adapter as any).basePath as string;
				const imagesFolderDiskPath = join(vaultBasePath, imagesFolderVaultPath);

				// Work in a temp dir — copy finished images into the vault folder
				const tempDir = await mkdtemp(join(tmpdir(), "slate-"));

				try {
					// 1. Resolve [[wikilinks]] to build enriched plain-text prompts for mflux
					notice.setMessage("Slate: Collecting links…");
					const linkContents = await collectLinkContents(shots, this.app);
					notice.setMessage("Slate: Summarizing links…");
					const linkSummaries = await summarizeLinks(
						this.settings.ollamaHost,
						this.settings.ollamaModel,
						linkContents
					);
					const resolvedDescriptions = shots.map((s, i) => {
						const parts: string[] = [];
						const shotText = `${s.action} ${s.description} ${s.dialog ?? ""}`;
						const featured = Object.entries(linkSummaries).filter(([name]) =>
							shotText.includes(`[[${name}]]`)
						);
						if (featured.length > 0) {
							parts.push(
								`Featured in this shot:\n${featured.map(([name, summary]) => `${name}: ${summary}`).join("\n")}`
							);
						}
						parts.push(`Location: ${s.scene}`);
						parts.push(`Camera: ${s.camera}`);
						parts.push(`Action: ${s.action}`);
						parts.push(`Description: ${s.description}`);
						if (s.dialog) {
							parts.push(`Dialog — feature this text visually in the image: "${s.dialog}"`);
						}
						if (i > 0) {
							const prev = shots[i - 1];
							parts.push(`Previous shot: ${prev.action} ${prev.description}`);
						}
						parts.push(`Single cinematic frame. Not a comic strip or panel sequence.`);
						return parts.join("\n\n");
					});

					// 2. Pre-compute filenames
					const filenames = shots.map((s) =>
						`${this.settings.storyboardImageName.replace("#", String(s.number))}.png`
					);
					const outputAsImage = this.settings.storyboardOutputType === "image";

					// Note mode: write the gallery note up front so images appear as they are copied in
					if (!outputAsImage) {
						const noteContent = inlineTitle(this.app)
							? buildGalleryNote(imagesFolderVaultPath)
							: `# ${baseName} — Storyboard\n\n${buildGalleryNote(imagesFolderVaultPath)}`;
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

					// 3. Generate individual shot images into temp dir, copying each into the vault as it completes
					const generatedImages = await generateStoryboardImages(
						shots,
						tempDir,
						this.settings,
						(msg, i, total) => notice.setMessage(`Slate: ${msg} (${i + 1}/${total})`),
						async ({ filePath }) => {
							const filename = filePath.split("/").pop()!;
							await copyFile(filePath, join(imagesFolderDiskPath, filename));
						},
						resolvedDescriptions
					);

					// 4. Image mode: composite all shots into a single tiled PNG saved directly to the vault folder
					if (outputAsImage) {
						notice.setMessage("Slate: Compositing storyboard image…");
						const imagePaths = generatedImages.map((g) => g.filePath);
						const tileFilename = `${baseName} Storyboard.png`;
						const tileDiskPath = join(vaultBasePath, folder ? folder + "/" : "", tileFilename);
						await tileImages(
							imagePaths,
							tileDiskPath,
							this.settings.storyboardTileColumns,
							this.settings.storyboardTilePadding,
							this.settings.storyboardTileBackground
						);
						if (this.settings.storyboardDeleteIndividualImages) {
							await rm(imagesFolderDiskPath, { recursive: true, force: true });
							const vaultFolder = this.app.vault.getAbstractFileByPath(imagesFolderVaultPath);
							if (vaultFolder) await this.app.vault.delete(vaultFolder, true);
						}
					}

					notice.hide();
					new Notice(`Slate: Storyboard ready — ${shots.length} shots.`);
				} catch (err) {
					notice.hide();
					new Notice(`Slate error: ${err instanceof Error ? err.message : String(err)}`, 8000);
					console.error("[Slate]", err);
				} finally {
					await rm(tempDir, { recursive: true, force: true });
				}
			},
		});
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildMarkdownTable(shots: Shot[]): string {
	const header =
		"| # | Scene | Camera | Action | Description | Dialog |\n" +
		"|---|-------|--------|--------|-------------|--------|";

	const rows = shots.map((s) =>
		`| ${s.number} | ${esc(s.scene)} | ${esc(s.camera)} | ${esc(s.action)} | ${esc(s.description)} | ${esc(s.dialog ?? "")} |`
	);

	return [header, ...rows].join("\n");
}

function esc(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Returns true when Obsidian is configured to show the filename as an inline title. */
function inlineTitle(app: App): boolean {
	return (app.vault as any).config?.showInlineTitle !== false;
}

function buildGalleryNote(imagesFolderVaultPath: string): string {
	return `\`\`\`img-gallery\ntype: vertical\nsort: asc\ncolumns: 1\npath: "${imagesFolderVaultPath}"\n\`\`\``;
}

function parseShotsFromTable(content: string): Shot[] {
	const lines = content.split("\n");
	const shots: Shot[] = [];

	// Detect column positions from the header row so old breakdowns still parse correctly.
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
			scene:    cells[colScene]  ?? "",
			camera:   cells[colCamera] ?? "",
			action:   cells[colAction] ?? "",
			description: cells[colDesc] ?? "",
			dialog:   cells[colDialog] || undefined,
		});
	}

	return shots;
}
