import { mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Notice, Plugin, TFile, normalizePath } from "obsidian";
import { DEFAULT_SETTINGS, SlateSettings, SlateSettingTab } from "./settings";
import { generateShotBreakdown, Shot } from "./ollama";
import { generateStoryboardImages } from "./mflux";
import { tileImages } from "./tile";

export default class SlatePlugin extends Plugin {
	settings: SlateSettings;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new SlateSettingTab(this.app, this));

		// ── Command: Generate shot breakdown ─────────────────────────
		this.addCommand({
			id: "generate-shot-breakdown",
			name: "Generate shot breakdown from script",
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
				const content = `# ${baseName} — Shot Breakdown\n\n${table}`;

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

		// ── Command: Generate storyboard ─────────────────────────────
		this.addCommand({
			id: "generate-storyboard-images",
			name: "Generate storyboard from shot breakdown",
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

				// Work entirely in a temp directory — nothing permanent until tiling is done.
				const tempDir = await mkdtemp(join(tmpdir(), "slate-"));

				try {
					// 1. Generate individual shot images into the temp dir.
					const images = await generateStoryboardImages(
						shots,
						tempDir,
						this.settings,
						(msg, i, total) => notice.setMessage(`Slate: ${msg} (${i + 1}/${total})`)
					);

					// 2. Tile into a single contact sheet.
					notice.setMessage("Slate: Compositing contact sheet…");
					const tempTilePath = join(tempDir, "storyboard.png");
					await tileImages(
						images.map((img) => img.filePath),
						tempTilePath,
						this.settings.mfluxWidth,
						this.settings.mfluxHeight
					);

					// 3. Copy tiled image into the vault next to the breakdown file.
					const baseName = activeFile.basename.replace(/ - Shot Breakdown$/, "");
					const folder = activeFile.parent?.path ?? "";
					const storyboardVaultPath = normalizePath(`${folder}/${baseName} - Storyboard.png`);

					const imageBuffer = await readFile(tempTilePath);
					const existingImg = this.app.vault.getAbstractFileByPath(storyboardVaultPath);
					if (existingImg instanceof TFile) {
						await this.app.vault.modifyBinary(existingImg, imageBuffer.buffer as ArrayBuffer);
					} else {
						await this.app.vault.createBinary(storyboardVaultPath, imageBuffer.buffer as ArrayBuffer);
					}

					notice.hide();
					new Notice(`Slate: Storyboard ready — ${shots.length} shots tiled.`);
				} catch (err) {
					notice.hide();
					new Notice(`Slate error: ${err instanceof Error ? err.message : String(err)}`, 8000);
					console.error("[Slate]", err);
				} finally {
					// 5. Always clean up temp files.
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
		"| # | Scene | Shot | Camera | Visual Description | Notes |\n" +
		"|---|-------|------|--------|--------------------|-------|";

	const rows = shots.map((s) =>
		`| ${s.number} | ${esc(s.scene)} | ${esc(s.shotType)} | ${esc(s.cameraMovement)} | ${esc(s.visualDescription)} | ${esc(s.notes ?? "")} |`
	);

	return [header, ...rows].join("\n");
}

function esc(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function parseShotsFromTable(content: string): Shot[] {
	const lines = content.split("\n");
	const shots: Shot[] = [];

	for (const line of lines) {
		if (!line.startsWith("|")) continue;
		const cells = line.split("|").map((c) => c.trim());
		if (cells.length < 7) continue;
		const num = parseInt(cells[1]);
		if (isNaN(num)) continue;

		shots.push({
			number: num,
			scene: cells[2],
			shotType: cells[3],
			cameraMovement: cells[4],
			visualDescription: cells[5],
			notes: cells[6] || undefined,
		});
	}

	return shots;
}
