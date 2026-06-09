import { Notice, Plugin, TFile, TAbstractFile, debounce } from "obsidian";
import {
  DEFAULT_SETTINGS,
  VaultBridgeSettings,
  VaultBridgeSettingTab,
} from "./settings";
import { SyncEngine, SyncStatus, VaultIndex } from "./sync";

interface PluginData {
  settings: VaultBridgeSettings;
  lastKnownIndex?: VaultIndex;
  // Older versions stored a slimmer "manifest" here. Field kept only so we
  // can detect and discard it on load.
  lastKnownManifest?: unknown;
}

const EMPTY_INDEX: VaultIndex = {
  version: 1,
  files: {},
  lastUpdated: new Date(0).toISOString(),
};

export default class VaultBridgePlugin extends Plugin {
  settings!: VaultBridgeSettings;
  private lastKnownIndex: VaultIndex = EMPTY_INDEX;
  private engine!: SyncEngine;
  private statusBarItem!: HTMLElement;
  private syncTimer: number | null = null;
  private syncInProgress = false;
  private debouncedFileSync: (() => void) | null = null;
  // Timestamp of the user's most recent edit. The periodic sync uses this as a
  // write-quiet guard so it never pulls while the user is mid-keystroke.
  private lastEditTime = 0;
  private readonly QUIET_PERIOD_MS = 10_000;
  // Track consecutive sync failures so we only bother the user once
  // a transient blip becomes a real persistent problem.
  private consecutiveFailures = 0;
  private readonly FAILURE_NOTICE_THRESHOLD = 3;

  async onload() {
    await this.loadPluginData();

    this.statusBarItem = this.addStatusBarItem();
    this.setStatus("idle", "Vault Bridge ready");

    this.engine = new SyncEngine(
      this.app,
      this.settings,
      (status, msg) => this.setStatus(status, msg),
      async () => this.lastKnownIndex,
      async (index) => {
        this.lastKnownIndex = index;
        await this.savePluginData();
      }
    );

    this.addSettingTab(new VaultBridgeSettingTab(this.app, this));

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => this.syncNow(),
    });

    this.addCommand({
      id: "initial-upload",
      name: "Initial upload (push all files to R2)",
      callback: () => this.initialUpload(),
    });

    // Debounced reactive sync — when local files change, sync after 5s of quiet
    this.debouncedFileSync = debounce(
      () => this.syncNow().catch(console.error),
      5000,
      true
    );

    this.registerEvent(
      this.app.vault.on("modify", (file) => this.onFileChange(file))
    );
    this.registerEvent(
      this.app.vault.on("create", (file) => this.onFileChange(file))
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => this.onFileChange(file))
    );
    this.registerEvent(
      this.app.vault.on("rename", (file) => this.onFileChange(file))
    );

    // Keystroke-level edit signal. The vault "modify" event only fires after
    // Obsidian flushes the editor buffer to disk — but the clobber happens in
    // the window *before* that flush. "editor-change" fires on every keystroke,
    // so it keeps lastEditTime fresh during an active ramble and closes that gap.
    this.registerEvent(
      this.app.workspace.on("editor-change", () => {
        this.lastEditTime = Date.now();
      })
    );

    // Initial sync on load (after Obsidian finishes indexing)
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.enabled && this.settings.token) {
        setTimeout(() => this.syncNow().catch(console.error), 2000);
      }
    });

    this.startSyncTimer();
  }

  onunload() {
    this.stopSyncTimer();
  }

  async loadPluginData() {
    const data = ((await this.loadData()) ?? {}) as Partial<PluginData> &
      Partial<VaultBridgeSettings>;

    // Backwards compat: older versions stored settings at the top level
    const storedSettings = data.settings ?? (data as VaultBridgeSettings);
    this.settings = Object.assign({}, DEFAULT_SETTINGS, storedSettings);

    // Load the persisted index. The lastKnownManifest field from older
    // plugin versions is intentionally not migrated — its shape is leaner
    // than the new index, and the plugin's next sync will rebuild fresh.
    this.lastKnownIndex = data.lastKnownIndex ?? EMPTY_INDEX;
  }

  async savePluginData() {
    const data: PluginData = {
      settings: this.settings,
      lastKnownIndex: this.lastKnownIndex,
    };
    await this.saveData(data);
  }

  async saveSettings() {
    await this.savePluginData();
  }

  // --- Status bar ---

  private setStatus(status: SyncStatus, message?: string) {
    if (!this.statusBarItem) return;
    const icon =
      status === "syncing"
        ? "↻"
        : status === "synced"
          ? "✓"
          : status === "error"
            ? "⚠"
            : "○";
    const text = message ? `${icon} ${message}` : icon;
    this.statusBarItem.setText(`VB ${text}`);
    this.statusBarItem.title = `Vault Bridge: ${status}${message ? " — " + message : ""}`;
  }

  // --- Sync orchestration ---

  async syncNow(): Promise<void> {
    if (!this.settings.enabled) {
      new Notice("Vault Bridge is disabled. Enable in settings.");
      return;
    }
    if (!this.settings.token) {
      new Notice("Vault Bridge: no token configured. Open settings.");
      return;
    }
    if (this.syncInProgress) {
      // Quietly skip — concurrent triggers (file events + periodic timer)
      // are expected to overlap. Logging here just creates console noise.
      return;
    }

    this.syncInProgress = true;
    try {
      const result = await this.engine.sync();
      this.consecutiveFailures = 0;
      if (result.errors.length > 0) {
        new Notice(
          `Vault Bridge: sync completed with ${result.errors.length} error(s). Check console.`
        );
        console.warn("[VaultBridge] Sync errors:", result.errors);
      }
      if (result.conflicts > 0) {
        new Notice(
          `Vault Bridge: ${result.conflicts} conflict(s). See .conflict.md files.`
        );
      }
    } catch (err) {
      this.consecutiveFailures++;
      console.warn(
        `[VaultBridge] Sync failed (${this.consecutiveFailures}):`,
        err
      );
      // Only show a Notice if we've failed several times in a row.
      // Single transient failures self-heal on the next sync.
      if (this.consecutiveFailures >= this.FAILURE_NOTICE_THRESHOLD) {
        new Notice(
          `Vault Bridge: sync failing repeatedly. Check the console.`
        );
        // Reset so we don't spam every interval
        this.consecutiveFailures = 0;
      }
    } finally {
      this.syncInProgress = false;
    }
  }

  async initialUpload(): Promise<void> {
    if (!this.settings.token) {
      new Notice("Vault Bridge: no token configured. Open settings.");
      return;
    }
    if (this.syncInProgress) {
      new Notice("Sync already in progress. Try again in a moment.");
      return;
    }

    this.syncInProgress = true;
    try {
      const result = await this.engine.initialUpload();
      new Notice(`Vault Bridge: uploaded ${result.pushed} files to R2.`);
    } catch (err) {
      console.error("[VaultBridge] Initial upload failed:", err);
      new Notice(`Vault Bridge upload failed: ${err}`);
    } finally {
      this.syncInProgress = false;
    }
  }

  private onFileChange(file: TAbstractFile): void {
    if (!this.settings.enabled || !this.settings.token) return;
    if (!(file instanceof TFile)) return;
    // Skip Obsidian internal events for excluded paths
    for (const ex of this.settings.excludedFolders) {
      if (file.path === ex || file.path.startsWith(ex + "/")) return;
    }
    // Record the edit so the periodic timer's write-quiet guard knows the user
    // is active. (editor-change covers in-editor typing pre-flush; this covers
    // create/delete/rename and external modifications.)
    this.lastEditTime = Date.now();
    this.debouncedFileSync?.();
  }

  // --- Periodic sync timer ---

  private startSyncTimer() {
    this.stopSyncTimer();
    if (!this.settings.enabled) return;

    const intervalMs = Math.max(10, this.settings.syncIntervalSeconds) * 1000;
    this.syncTimer = window.setInterval(() => {
      // Write-quiet guard — the actual clobber fix. Don't run a periodic pull
      // while the user is actively typing: a pull mid-keystroke (before the
      // editor buffer flushes to disk) overwrites unsaved text, because the
      // on-disk file still matches last-known and the three-way diff mis-reads
      // it as "remote-only changed". Defer to a later tick once they pause.
      // Manual "Sync now" and the post-edit debounced push deliberately bypass
      // this — they're intentional and quiet-by-construction.
      if (Date.now() - this.lastEditTime < this.QUIET_PERIOD_MS) {
        return;
      }
      this.syncNow().catch(console.error);
    }, intervalMs);
  }

  private stopSyncTimer() {
    if (this.syncTimer !== null) {
      window.clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  restartSync() {
    this.stopSyncTimer();
    this.startSyncTimer();
  }
}
