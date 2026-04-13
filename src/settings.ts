import { App, PluginSettingTab, Setting } from "obsidian";
import type SlatePlugin from "./main";

export interface SlateSettings {
	// Ollama settings
	ollamaHost: string;
	ollamaModel: string;

	// mflux settings
	mfluxExecutable: string;
	mfluxPromptHeader: string;
	mfluxModel: string;
	mfluxSteps: number;
	mfluxWidth: number;
	mfluxHeight: number;
	mfluxQuantize: number | null;

}

export const DEFAULT_SETTINGS: SlateSettings = {
	ollamaHost: "http://localhost:11434",
	ollamaModel: "mistral:latest",
	mfluxExecutable: "",
	mfluxPromptHeader: "",
	mfluxModel: "flux2-klein-4b",
	mfluxSteps: 8,
	mfluxWidth: 1024,
	mfluxHeight: 576,
	mfluxQuantize: 8,
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
			.setDesc("Ollama model to use for shot breakdown (e.g. mistral:latest, codestral:latest).")
			.addText((text) =>
				text
					.setPlaceholder("mistral:latest")
					.setValue(this.plugin.settings.ollamaModel)
					.onChange(async (value) => {
						this.plugin.settings.ollamaModel = value.trim();
						await this.plugin.saveSettings();
					})
			);

		// ── MFLUX ───────────────────────────────────────────────────
		containerEl.createEl("h2", { text: "MFLUX" });

		new Setting(containerEl)
			.setName("Executable path")
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
			.setName("Storyboard prompt header")
			.setDesc("Text prepended to every shot prompt (e.g. a style or aesthetic description).")
			.addTextArea((text) =>
				text
					.setPlaceholder("Cinematic storyboard frame, black and white ink sketch…")
					.setValue(this.plugin.settings.mfluxPromptHeader)
					.onChange(async (value) => {
						this.plugin.settings.mfluxPromptHeader = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Model")
			.setDesc("Flux 2 model variant. 4b is faster, 9b is higher quality. Base variants support guidance scale.")
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
			.setName("Storyboard width")
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
			.setName("Storyboard height")
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

	}
}
