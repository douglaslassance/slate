import { App, Notice, Plugin, TFolder, normalizePath } from "obsidian";
import { DEFAULT_SETTINGS, PompeiSettings, PompeiSettingTab } from "./settings";
import { generateShotBreakdown, Shot } from "./ollama";
import { generateStoryboardImages, GeneratedImage } from "./mflux";

export default class PompeiPlugin extends Plugin {
	settings: PompeiSettings;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new PompeiSettingTab(this.app, this));

		// ── Command: Generate shot breakdown ─────────────────────────
		this.addCommand({
			id: "generate-shot-breakdown",
			name: "Generate shot breakdown from script",
			editorCallback: async (editor) => {
				const scriptText = editor.getValue().trim();
				if (!scriptText) {
					new Notice("The current note is empty.");
					return;
				}

				const notice = new Notice("Pompei: Generating shot breakdown…", 0);

				let shots: Shot[];
				try {
					shots = await generateShotBreakdown(
						this.settings.ollamaHost,
						this.settings.ollamaModel,
						scriptText,
						(msg) => notice.setMessage(`Pompei: ${msg}`)
					);
				} catch (err) {
					notice.hide();
					new Notice(`Pompei error: ${err instanceof Error ? err.message : String(err)}`, 8000);
					console.error("[Pompei]", err);
					return;
				}

				notice.hide();

				// Append the breakdown as a markdown table below the script.
				const table = buildMarkdownTable(shots);
				const separator = "\n\n---\n\n## Shot Breakdown\n\n";
				editor.setValue(editor.getValue() + separator + table);

				new Notice(`Pompei: Shot breakdown complete — ${shots.length} shots.`);
			},
		});

		// ── Command: Generate storyboard images ──────────────────────
		this.addCommand({
			id: "generate-storyboard-images",
			name: "Generate storyboard images from shot breakdown",
			editorCallback: async (editor) => {
				const content = editor.getValue();
				const shots = parseShotsFromTable(content);

				if (shots.length === 0) {
					new Notice(
						'Pompei: No shot breakdown table found. Run "Generate shot breakdown" first.',
						6000
					);
					return;
				}

				// Ensure output folder exists.
				const outputFolderPath = normalizePath(this.settings.outputFolder);
				await this.ensureFolder(outputFolderPath);

				// Resolve absolute vault path for mflux (needs a real FS path).
				const vaultBasePath = (this.app.vault.adapter as any).getBasePath?.() ?? "";
				const outputDir = `${vaultBasePath}/${outputFolderPath}`;

				const notice = new Notice("Pompei: Generating storyboard images…", 0);

				let images: GeneratedImage[];
				try {
					images = await generateStoryboardImages(
						shots,
						outputDir,
						this.settings,
						(msg, i, total) =>
							notice.setMessage(`Pompei: ${msg} (${i + 1}/${total})`)
					);
				} catch (err) {
					notice.hide();
					new Notice(`Pompei error: ${err instanceof Error ? err.message : String(err)}`, 8000);
					console.error("[Pompei]", err);
					return;
				}

				notice.hide();

				// Append image embeds below the table.
				const embeds = buildImageEmbeds(images, outputFolderPath);
				editor.setValue(content + "\n\n## Storyboard\n\n" + embeds);

				new Notice(`Pompei: ${images.length} storyboard image(s) generated.`);
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

	private async ensureFolder(path: string) {
		const exists = this.app.vault.getAbstractFileByPath(path);
		if (!exists) {
			await this.app.vault.createFolder(path);
		} else if (!(exists instanceof TFolder)) {
			throw new Error(`Pompei: "${path}" already exists and is not a folder.`);
		}
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

/**
 * Naive parser: pulls shots back out of the markdown table so the storyboard
 * command can work directly from the note content.
 */
function parseShotsFromTable(content: string): Shot[] {
	const tableStart = content.indexOf("## Shot Breakdown");
	if (tableStart === -1) return [];

	const lines = content.slice(tableStart).split("\n");
	const shots: Shot[] = [];

	for (const line of lines) {
		if (!line.startsWith("|")) continue;
		const cells = line.split("|").map((c) => c.trim());
		// cells[0] is empty, cells[1..6] are the columns, cells[7] is empty
		if (cells.length < 7) continue;
		const num = parseInt(cells[1]);
		if (isNaN(num)) continue; // skip header / separator rows

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

function buildImageEmbeds(images: GeneratedImage[], folderPath: string): string {
	return images
		.map((img) => {
			const filename = img.filePath.split("/").pop() ?? img.filePath;
			const vaultPath = `${folderPath}/${filename}`;
			return `### Shot ${img.shot.number} — ${img.shot.scene}\n![[${vaultPath}]]`;
		})
		.join("\n\n");
}
