import { App, Notice, PluginSettingTab, Setting, requestUrl } from "obsidian";
import type VaultBridgePlugin from "./main";

export type LlmProvider = "anthropic" | "openai" | "google";

export interface VaultBridgeSettings {
  token: string;
  relayUrl: string;
  syncIntervalSeconds: number;
  excludedFolders: string[];
  enabled: boolean;
  /** Email-agent LLM settings — pushed to relay /secrets/llm on save. */
  llmProvider: LlmProvider;
  llmApiKey: string;
  /** Optional model override; blank falls back to the admin-configured default. */
  llmModel: string;
}

export const DEFAULT_SETTINGS: VaultBridgeSettings = {
  token: "",
  relayUrl: "https://vault-bridge.the-empyrean.com",
  syncIntervalSeconds: 60,
  excludedFolders: [".obsidian/plugins", ".obsidian/workspace.json", ".trash"],
  enabled: true,
  llmProvider: "anthropic",
  llmApiKey: "",
  llmModel: "",
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

    // --- Email agent LLM config ---

    containerEl.createEl("h3", { text: "Email agent" });
    containerEl.createEl("p", {
      text: "Configure the LLM that processes your forwarded-email attachments. The API key is stored on the relay keyed to your token, not in your vault. Leave blank to use the platform default.",
    });

    new Setting(containerEl)
      .setName("Provider")
      .setDesc("Which LLM provider to use. Only Anthropic is active today; OpenAI and Google are scaffolded for later.")
      .addDropdown((dd) =>
        dd
          .addOption("anthropic", "Anthropic")
          .addOption("openai", "OpenAI (coming soon)")
          .addOption("google", "Google (coming soon)")
          .setValue(this.plugin.settings.llmProvider)
          .onChange(async (value) => {
            this.plugin.settings.llmProvider = value as LlmProvider;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("API key")
      .setDesc("Your provider API key. Billed to your account. Click 'Save to relay' after editing.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-ant-… / sk-… / …")
          .setValue(this.plugin.settings.llmApiKey)
          .onChange(async (value) => {
            this.plugin.settings.llmApiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Optional model ID. Leave blank to use the platform default.")
      .addText((text) =>
        text
          .setPlaceholder("claude-sonnet-4-6")
          .setValue(this.plugin.settings.llmModel)
          .onChange(async (value) => {
            this.plugin.settings.llmModel = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Save to relay")
      .setDesc("Push the provider + API key + model to the relay secrets store so the email agent can use them.")
      .addButton((btn) =>
        btn.setButtonText("Save to relay").onClick(async () => {
          await this.saveLlmSecret();
        })
      )
      .addButton((btn) =>
        btn
          .setButtonText("Clear on relay")
          .setWarning()
          .onClick(async () => {
            await this.clearLlmSecret();
          })
      );
  }

  private async saveLlmSecret(): Promise<void> {
    const { token, relayUrl, llmProvider, llmApiKey, llmModel } = this.plugin.settings;
    if (!token) {
      new Notice("Vault Bridge: set your token first.");
      return;
    }
    if (!llmApiKey) {
      new Notice("Vault Bridge: enter an API key first.");
      return;
    }

    const body: Record<string, string> = {
      provider: llmProvider,
      apiKey: llmApiKey,
    };
    if (llmModel) body.model = llmModel;

    const url = `${relayUrl}/secrets/llm?token=${encodeURIComponent(token)}`;
    try {
      const resp = await requestUrl({
        url,
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        throw: false,
      });
      if (resp.status >= 200 && resp.status < 300) {
        new Notice("Email agent settings saved to relay.");
      } else {
        new Notice(`Save failed: ${resp.status} ${resp.text?.slice(0, 120) ?? ""}`);
      }
    } catch (err) {
      new Notice(`Save failed: ${(err as Error).message}`);
    }
  }

  private async clearLlmSecret(): Promise<void> {
    const { token, relayUrl } = this.plugin.settings;
    if (!token) {
      new Notice("Vault Bridge: set your token first.");
      return;
    }
    const url = `${relayUrl}/secrets/llm?token=${encodeURIComponent(token)}`;
    try {
      const resp = await requestUrl({ url, method: "DELETE", throw: false });
      if (resp.status >= 200 && resp.status < 300) {
        new Notice("Email agent settings cleared on relay.");
      } else {
        new Notice(`Clear failed: ${resp.status}`);
      }
    } catch (err) {
      new Notice(`Clear failed: ${(err as Error).message}`);
    }
  }
}
