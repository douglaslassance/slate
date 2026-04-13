import { App, PluginSettingTab, Setting } from "obsidian";
import type PompeiPlugin from "./main";

export interface PompeiSettings {
	// Ollama settings
	ollamaHost: string;
	ollamaModel: string;

	// mflux settings
	mfluxModel: string;
	mfluxSteps: number;
	mfluxWidth: number;
	mfluxHeight: number;
	mfluxQuantize: number | null;

	// Output settings
	outputFolder: string;
}

export const DEFAULT_SETTINGS: PompeiSettings = {
	ollamaHost: "http://localhost:11434",
	ollamaModel: "llama3",
	mfluxModel: "schnell",
	mfluxSteps: 4,
	mfluxWidth: 1024,
	mfluxHeight: 576,
	mfluxQuantize: 8,
	outputFolder: "Storyboards",
};

export class PompeiSettingTab extends PluginSettingTab {
	plugin: PompeiPlugin;

	constructor(app: App, plugin: PompeiPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// ── Ollama ──────────────────────────────────────────────────
		containerEl.createEl("h2", { text: "Ollama" });

		new Setting(containerEl)
			.setName("Host")
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
			.setName("Model")
			.setDesc("Ollama model to use for shot breakdown (e.g. llama3, mistral).")
			.addText((text) =>
				text
					.setPlaceholder("llama3")
					.setValue(this.plugin.settings.ollamaModel)
					.onChange(async (value) => {
						this.plugin.settings.ollamaModel = value.trim();
						await this.plugin.saveSettings();
					})
			);

		// ── mflux ───────────────────────────────────────────────────
		containerEl.createEl("h2", { text: "mflux" });

		new Setting(containerEl)
			.setName("Model")
			.setDesc('Flux model variant: "schnell" (fast) or "dev" (quality).')
			.addDropdown((drop) =>
				drop
					.addOptions({ schnell: "schnell", dev: "dev" })
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
			.setName("Width")
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
			.setName("Height")
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

		new Setting(containerEl)
			.setName("Quantization")
			.setDesc("Model quantization bits (4 or 8) to reduce VRAM usage. Leave empty to disable.")
			.addDropdown((drop) =>
				drop
					.addOptions({ "": "None", "4": "4-bit", "8": "8-bit" })
					.setValue(this.plugin.settings.mfluxQuantize !== null ? String(this.plugin.settings.mfluxQuantize) : "")
					.onChange(async (value) => {
						this.plugin.settings.mfluxQuantize = value === "" ? null : parseInt(value);
						await this.plugin.saveSettings();
					})
			);

		// ── Output ──────────────────────────────────────────────────
		containerEl.createEl("h2", { text: "Output" });

		new Setting(containerEl)
			.setName("Output folder")
			.setDesc("Vault folder where storyboard images will be saved.")
			.addText((text) =>
				text
					.setPlaceholder("Storyboards")
					.setValue(this.plugin.settings.outputFolder)
					.onChange(async (value) => {
						this.plugin.settings.outputFolder = value.trim();
						await this.plugin.saveSettings();
					})
			);
	}
}
