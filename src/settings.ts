import { App, PluginSettingTab, Setting } from "obsidian";
import type VaultBridgePlugin from "./main";

export interface VaultBridgeSettings {
  token: string;
  relayUrl: string;
  syncIntervalSeconds: number;
  excludedFolders: string[];
  enabled: boolean;
}

export const DEFAULT_SETTINGS: VaultBridgeSettings = {
  token: "",
  relayUrl: "https://vault-bridge.the-empyrean.com",
  syncIntervalSeconds: 60,
  excludedFolders: [".obsidian/plugins", ".obsidian/workspace.json", ".trash"],
  enabled: true,
};

export class VaultBridgeSettingTab extends PluginSettingTab {
  plugin: VaultBridgePlugin;

  constructor(app: App, plugin: VaultBridgePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Vault Bridge Settings" });
    containerEl.createEl("p", {
      text: "Sync your vault to Cloudflare R2 so Claude.ai can read and write to it from any device, even when this machine is off.",
    });

    new Setting(containerEl)
      .setName("Enabled")
      .setDesc("Toggle Vault Bridge sync on/off without uninstalling.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enabled)
          .onChange(async (value) => {
            this.plugin.settings.enabled = value;
            await this.plugin.saveSettings();
            this.plugin.restartSync();
          })
      );

    new Setting(containerEl)
      .setName("Token")
      .setDesc("Your Vault Bridge access token (provided by your admin).")
      .addText((text) =>
        text
          .setPlaceholder("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx")
          .setValue(this.plugin.settings.token)
          .onChange(async (value) => {
            this.plugin.settings.token = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Relay URL")
      .setDesc("The Vault Bridge relay endpoint.")
      .addText((text) =>
        text
          .setPlaceholder("https://vault-bridge.the-empyrean.com")
          .setValue(this.plugin.settings.relayUrl)
          .onChange(async (value) => {
            this.plugin.settings.relayUrl = value.trim().replace(/\/$/, "");
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Sync interval")
      .setDesc("How often to do a full sync check, in seconds.")
      .addText((text) =>
        text
          .setPlaceholder("60")
          .setValue(String(this.plugin.settings.syncIntervalSeconds))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!isNaN(n) && n >= 10) {
              this.plugin.settings.syncIntervalSeconds = n;
              await this.plugin.saveSettings();
              this.plugin.restartSync();
            }
          })
      );

    new Setting(containerEl)
      .setName("Excluded folders")
      .setDesc(
        "Comma-separated list of paths to skip during sync. Defaults exclude Obsidian internals."
      )
      .addTextArea((text) =>
        text
          .setPlaceholder(".obsidian/plugins, .trash")
          .setValue(this.plugin.settings.excludedFolders.join(", "))
          .onChange(async (value) => {
            this.plugin.settings.excludedFolders = value
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h3", { text: "Manual actions" });

    new Setting(containerEl)
      .setName("Sync now")
      .setDesc("Trigger a full sync immediately.")
      .addButton((btn) =>
        btn.setButtonText("Sync now").onClick(async () => {
          await this.plugin.syncNow();
        })
      );

    new Setting(containerEl)
      .setName("Initial upload")
      .setDesc(
        "Push every file in this vault to R2. Use once when first connecting a vault."
      )
      .addButton((btn) =>
        btn
          .setButtonText("Upload all files")
          .setWarning()
          .onClick(async () => {
            await this.plugin.initialUpload();
          })
      );
  }
}
