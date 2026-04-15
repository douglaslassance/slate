import { App, PluginSettingTab, Setting } from "obsidian";
import type SlatePlugin from "./main";

export interface SlateSettings {
	// ── Shot Breakdown ─────────────────────────────────────────────────────────
	ollamaHost: string;
	ollamaModel: string;
	breakdownLanguage: string;
	breakdownCustomInstructions: string;
	breakdownOutputFolder: string;
	breakdownChunkSize: number;

	// ── Storyboard ─────────────────────────────────────────────────────────────
	mfluxExecutable: string;
	storyboardImageName: string;
	mfluxStyleImagePath: string;
	mfluxPromptHeader: string;
	mfluxModel: string;
	mfluxSteps: number;
	mfluxWidth: number;
	mfluxHeight: number;
	mfluxQuantize: number | null;
	storyboardOutputType: "note" | "image";
	storyboardTileOrientation: "portrait" | "landscape";
	storyboardTilePadding: number;
	storyboardTileBackground: string;
}

export const DEFAULT_SETTINGS: SlateSettings = {
	ollamaHost: "http://localhost:11434",
	ollamaModel: "codestral:latest",
	breakdownLanguage: "",
	breakdownCustomInstructions: "",
	breakdownOutputFolder: "",
	breakdownChunkSize: 750,

	mfluxExecutable: "",
	storyboardImageName: "Shot #",
	mfluxStyleImagePath: "",
	mfluxPromptHeader: "",
	mfluxModel: "flux2-klein-4b",
	mfluxSteps: 8,
	mfluxWidth: 1024,
	mfluxHeight: 576,
	mfluxQuantize: 4,
	storyboardOutputType: "note",
	storyboardTileOrientation: "portrait",
	storyboardTilePadding: 16,
	storyboardTileBackground: "#000000",
};

export class SlateSettingTab extends PluginSettingTab {
	plugin: SlatePlugin;

	constructor(app: App, plugin: SlatePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// ── Shot Breakdown ──────────────────────────────────────────────────────
		containerEl.createEl("h2", { text: "Shot breakdown" });

		new Setting(containerEl)
			.setName("Ollama host")
			.setDesc("URL of your local Ollama server.")
			.addText((text) =>
				text
					.setPlaceholder("http://localhost:11434")
					.setValue(this.plugin.settings.ollamaHost)
					.onChange(async (value) => {
						this.plugin.settings.ollamaHost = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Ollama model")
			.setDesc("Model to use for shot breakdown. If the model is not installed it will be pulled automatically when you run a command.")
			.addDropdown((drop) =>
				drop
					.addOptions({ "codestral:latest": "codestral:latest" })
					.setValue(this.plugin.settings.ollamaModel)
					.onChange(async (value) => {
						this.plugin.settings.ollamaModel = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Output language")
			.setDesc("Translate the shot breakdown into this language. Leave on \"Source\" to keep the script's original language.")
			.addDropdown((drop) =>
				drop
					.addOptions({
						"": "Source",
						"English": "English",
						"French": "French",
						"Spanish": "Spanish",
						"German": "German",
						"Italian": "Italian",
						"Portuguese": "Portuguese",
						"Japanese": "Japanese",
						"Korean": "Korean",
						"Chinese (Simplified)": "Chinese (Simplified)",
						"Chinese (Traditional)": "Chinese (Traditional)",
						"Arabic": "Arabic",
						"Hindi": "Hindi",
						"Russian": "Russian",
						"Dutch": "Dutch",
						"Polish": "Polish",
						"Turkish": "Turkish",
						"Swedish": "Swedish",
						"Norwegian": "Norwegian",
						"Danish": "Danish",
					})
					.setValue(this.plugin.settings.breakdownLanguage)
					.onChange(async (value) => {
						this.plugin.settings.breakdownLanguage = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Custom instructions")
			.setDesc("Additional instructions appended to the breakdown prompt (e.g. \"Focus on action sequences, skip dialogue-only scenes\").")
			.addTextArea((text) => {
				text
					.setPlaceholder("Focus on action sequences, skip dialogue-only scenes…")
					.setValue(this.plugin.settings.breakdownCustomInstructions)
					.onChange(async (value) => {
						this.plugin.settings.breakdownCustomInstructions = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 5;
				return text;
			});

		new Setting(containerEl)
			.setName("Chunk size")
			.setDesc("Maximum words per request sent to Ollama. The script is split at scene boundaries so no scene is ever cut in half. Lower values mean more focused calls; higher values mean fewer calls. Larger chunks give the model more to process at once, which tends to produce fewer shots per scene.")
			.addText((text) =>
				text
					.setPlaceholder("750")
					.setValue(String(this.plugin.settings.breakdownChunkSize))
					.onChange(async (value) => {
						const n = parseInt(value);
						if (!isNaN(n) && n > 0) {
							this.plugin.settings.breakdownChunkSize = n;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Output folder")
			.setDesc(
				"Where to create the scene folder for each breakdown. " +
				"Leave empty to place it next to the source file. " +
				"Start with / for a vault-root path (e.g. /Breakdowns), " +
				"or use a relative path (e.g. Breakdowns) to place it relative to the source file."
			)
			.addText((text) =>
				text
					.setPlaceholder("Same folder as source file")
					.setValue(this.plugin.settings.breakdownOutputFolder)
					.onChange(async (value) => {
						this.plugin.settings.breakdownOutputFolder = value.trim();
						await this.plugin.saveSettings();
					})
			);

		// ── Storyboard ──────────────────────────────────────────────────────────
		containerEl.createEl("h2", { text: "Storyboard" });

		new Setting(containerEl)
			.setName("MFLUX executable path")
			.setDesc("Full path to mflux-generate-flux2 (e.g. /usr/local/bin/mflux-generate-flux2). Leave empty to auto-resolve via login shell.")
			.addText((text) =>
				text
					.setPlaceholder("/usr/local/bin/mflux-generate-flux2")
					.setValue(this.plugin.settings.mfluxExecutable)
					.onChange(async (value) => {
						this.plugin.settings.mfluxExecutable = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Image name")
			.setDesc("Filename template for each generated shot image. Use # as a placeholder for the shot number (e.g. \"Shot #\" → \"Shot 1.png\").")
			.addText((text) =>
				text
					.setPlaceholder("Shot #")
					.setValue(this.plugin.settings.storyboardImageName)
					.onChange(async (value) => {
						this.plugin.settings.storyboardImageName = value || "Shot #";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Model")
			.setDesc("Flux 2 model variant. 4b is faster, 9b is higher quality.")
			.addDropdown((drop) =>
				drop
					.addOptions({
						"flux2-klein-4b": "flux2-klein-4b (fast)",
						"flux2-klein-9b": "flux2-klein-9b (quality)",
						"flux2-klein-base-4b": "flux2-klein-base-4b (fast, guided)",
						"flux2-klein-base-9b": "flux2-klein-base-9b (quality, guided)",
					})
					.setValue(this.plugin.settings.mfluxModel)
					.onChange(async (value) => {
						this.plugin.settings.mfluxModel = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Steps")
			.setDesc("Number of diffusion steps (4 for schnell, 20–50 for dev).")
			.addSlider((slider) =>
				slider
					.setLimits(1, 50, 1)
					.setValue(this.plugin.settings.mfluxSteps)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.mfluxSteps = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Quantization")
			.setDesc("Model quantization bits to reduce VRAM usage. 4 is a good default. None = full precision.")
			.addDropdown((drop) =>
				drop
					.addOptions({ "": "None", "3": "3-bit", "4": "4-bit", "5": "5-bit", "6": "6-bit", "8": "8-bit" })
					.setValue(this.plugin.settings.mfluxQuantize !== null ? String(this.plugin.settings.mfluxQuantize) : "")
					.onChange(async (value) => {
						this.plugin.settings.mfluxQuantize = value === "" ? null : parseInt(value);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Style image path")
			.setDesc("Path to a reference image or a folder of images used as style input (up to 4 images from the folder). Start with / for an absolute path; otherwise relative to the vault root (e.g. Assets/Style). Leave empty to disable.")
			.addText((text) =>
				text
					.setPlaceholder("/path/to/style-reference.png")
					.setValue(this.plugin.settings.mfluxStyleImagePath)
					.onChange(async (value) => {
						this.plugin.settings.mfluxStyleImagePath = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Prompt header")
			.setDesc("Text prepended to every shot prompt (e.g. a style or aesthetic description).")
			.addTextArea((text) => {
				text
					.setPlaceholder("Cinematic storyboard frame, black and white ink sketch…")
					.setValue(this.plugin.settings.mfluxPromptHeader)
					.onChange(async (value) => {
						this.plugin.settings.mfluxPromptHeader = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 5;
				return text;
			});

		new Setting(containerEl)
			.setName("Image width")
			.setDesc("Output image width in pixels.")
			.addText((text) =>
				text
					.setPlaceholder("1024")
					.setValue(String(this.plugin.settings.mfluxWidth))
					.onChange(async (value) => {
						const n = parseInt(value);
						if (!isNaN(n) && n > 0) {
							this.plugin.settings.mfluxWidth = n;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Image height")
			.setDesc("Output image height in pixels.")
			.addText((text) =>
				text
					.setPlaceholder("576")
					.setValue(String(this.plugin.settings.mfluxHeight))
					.onChange(async (value) => {
						const n = parseInt(value);
						if (!isNaN(n) && n > 0) {
							this.plugin.settings.mfluxHeight = n;
							await this.plugin.saveSettings();
						}
					})
			);

		const tileSettings: Setting[] = [];

		new Setting(containerEl)
			.setName("Output type")
			.setDesc("Generate a gallery note (using img-gallery) or a single tiled image combining all shots.")
			.addDropdown((drop) => {
				drop
					.addOptions({ note: "Note", image: "Tiled image" })
					.setValue(this.plugin.settings.storyboardOutputType)
					.onChange(async (value: "note" | "image") => {
						this.plugin.settings.storyboardOutputType = value;
						await this.plugin.saveSettings();
						tileSettings.forEach((s) => s.settingEl.toggle(value === "image"));
					});
			});

		const showTile = this.plugin.settings.storyboardOutputType === "image";

		const orientationSetting = new Setting(containerEl)
			.setName("Orientation")
			.setDesc("Column count is calculated automatically to match A4 proportions.")
			.addDropdown((drop) =>
				drop
					.addOptions({ portrait: "Portrait", landscape: "Landscape" })
					.setValue(this.plugin.settings.storyboardTileOrientation)
					.onChange(async (value: "portrait" | "landscape") => {
						this.plugin.settings.storyboardTileOrientation = value;
						await this.plugin.saveSettings();
					})
			);
		orientationSetting.settingEl.toggle(showTile);
		tileSettings.push(orientationSetting);

		const padSetting = new Setting(containerEl)
			.setName("Padding")
			.setDesc("Gap in pixels between images and around the border.")
			.addSlider((slider) =>
				slider
					.setLimits(0, 128, 4)
					.setValue(this.plugin.settings.storyboardTilePadding)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.storyboardTilePadding = value;
						await this.plugin.saveSettings();
					})
			);
		padSetting.settingEl.toggle(showTile);
		tileSettings.push(padSetting);

		const bgSetting = new Setting(containerEl)
			.setName("Background color")
			.setDesc("Background and padding color for the tiled image.");
		const colorInput = bgSetting.controlEl.createEl("input", { type: "color" });
		colorInput.value = this.plugin.settings.storyboardTileBackground;
		colorInput.addEventListener("input", async () => {
			this.plugin.settings.storyboardTileBackground = colorInput.value;
			await this.plugin.saveSettings();
		});
		bgSetting.settingEl.toggle(showTile);
		tileSettings.push(bgSetting);

	}
}
