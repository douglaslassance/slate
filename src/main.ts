import { copyFile, rm, mkdtemp } from "fs/promises";
import { tileImages, calculateColumns } from "./tile";
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

				// Output: {output folder}/{basename}/Breakdown.md
				const baseName = activeFile.basename;
				const folder = resolveOutputFolder(activeFile, this.settings.breakdownOutputFolder);
				const sceneVaultPath = normalizePath(`${folder}/${baseName}`);
				const breakdownVaultPath = normalizePath(`${sceneVaultPath}/Breakdown.md`);

				await ensureVaultFolder(sceneVaultPath, this.app);

				const table = buildMarkdownTable(shots);
				const content = inlineTitle(this.app)
					? table
					: `# ${baseName} — Shot breakdown\n\n${table}`;

				const existing = this.app.vault.getAbstractFileByPath(breakdownVaultPath);
				let breakdownFile: TFile;
				if (existing instanceof TFile) {
					await this.app.vault.modify(existing, content);
					breakdownFile = existing;
				} else {
					breakdownFile = await this.app.vault.create(breakdownVaultPath, content);
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

					const promptContent = buildShotPrompt(shot, i, shots, linkSummaries, this.settings, shotName, rendersVaultPath, sceneVaultPath);
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
				new Notice(`Slate: Prompts ready — ${shots.length} shots.`);
			},
		});

		// ── Command: Generate storyboard ─────────────────────────────
		// Run from Breakdown.md — its parent is the scene root.
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

				// Scene root = parent folder of Breakdown.md
				const sceneVaultPath = activeFile.parent?.path ?? "";
				const sceneName = activeFile.parent?.name ?? activeFile.basename;
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
					notice.setMessage("Slate: Summarizing links…");
					const linkSummaries = await summarizeLinks(
						this.settings.ollamaHost,
						this.settings.ollamaModel,
						linkContents
					);

					// 2. Build per-shot names and prompts
					const shotNames = shots.map((s) =>
						(this.settings.storyboardImageName || "Shot #").replace("#", String(s.number))
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
						parts.push(`Single cinematic frame. Not a comic strip or panel sequence. Each character must appear only once in the image — never duplicate the same person. Respect the camera instruction strictly: a Close-Up is a tight frame on the main subject filling most of the image, a Wide Shot shows the full environment with the subject small within it, a Medium Shot frames the subject from the waist up, and an Extreme Close-Up isolates a single detail.`);
						return parts.join("\n\n");
					});

					// 3. Always write prompt files into Prompts/
					for (let i = 0; i < shots.length; i++) {
						const promptVaultPath = normalizePath(`${promptsVaultPath}/${shotNames[i]}.md`);
						const promptContent = buildShotPrompt(shots[i], i, shots, linkSummaries, this.settings, shotNames[i], rendersVaultPath, sceneVaultPath);
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
							: `# ${sceneName} — Storyboard\n\n${buildGalleryNote(rendersVaultPath)}`;
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

/** Build the markdown content for a single shot's prompt file. */
function buildShotPrompt(
	shot: Shot,
	index: number,
	allShots: Shot[],
	linkSummaries: Record<string, string>,
	settings: SlateSettings,
	shotName: string,
	storyboardFolderVaultPath: string,
	sceneVaultPath: string
): string {
	const body: string[] = [];

	const shotText = `${shot.action} ${shot.description} ${shot.dialog ?? ""}`;
	const featured = Object.entries(linkSummaries).filter(([name]) =>
		shotText.includes(`[[${name}]]`)
	);

	if (settings.mfluxPromptHeader) {
		body.push(`### Art style\n${settings.mfluxPromptHeader.trim()}`);
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
	if (index > 0) {
		const prev = allShots[index - 1];
		body.push(`### Previous shot\n${prev.action}\n\n${prev.description}`);
	}
	if (shot.dialog) {
		body.push(`### Instructions\nSingle cinematic frame. Not a comic strip or panel sequence. Each character must appear only once in the image — never duplicate the same person. Respect the camera instruction strictly: a Close-Up is a tight frame on the main subject filling most of the image, a Wide Shot shows the full environment with the subject small within it, a Medium Shot frames the subject from the waist up, and an Extreme Close-Up isolates a single detail. Respect the camera instruction strictly: a Close-Up is a tight frame on the main subject filling most of the image, a Wide Shot shows the full environment with the subject small within it, a Medium Shot frames the subject from the waist up, and an Extreme Close-Up isolates a single detail. The speaking character must be prominently featured. Display the dialog as visible text in the image — as a speech bubble, caption, or subtitle.`);
	} else {
		body.push(`### Instructions\nSingle cinematic frame. Not a comic strip or panel sequence. Each character must appear only once in the image — never duplicate the same person. Respect the camera instruction strictly: a Close-Up is a tight frame on the main subject filling most of the image, a Wide Shot shows the full environment with the subject small within it, a Medium Shot frames the subject from the waist up, and an Extreme Close-Up isolates a single detail.`);
	}

	const imageEmbed = `![[${storyboardFolderVaultPath}/${shotName}.png]]`;
	const breakdownLink = `[[${sceneVaultPath}/Breakdown|← Breakdown]]`;

	return `${imageEmbed}\n\n\`\`\`\n${body.join("\n\n")}\n\`\`\`\n\n${breakdownLink}`;
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
