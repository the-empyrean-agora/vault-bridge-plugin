/**
 * Sync engine — bidirectional sync between local Obsidian vault and Cloudflare R2.
 *
 * Algorithm: pull-before-push with manifest comparison.
 *   1. Fetch manifest from R2
 *   2. Compare R2 entries against local files (hash + mtime)
 *   3. Pull files that changed in R2 since last sync (Claude wrote them)
 *   4. Push files that changed locally
 *   5. Handle deletes on both sides
 *   6. Update manifest in R2
 *
 * Conflict policy: R2 wins. Local conflicting version saved as `<name>.conflict.md`.
 */

import { App, TFile, normalizePath, Notice, requestUrl } from "obsidian";
import type { VaultBridgeSettings } from "./settings";

// --- Types ---

export interface ManifestEntry {
  hash: string;          // sha256 of content
  modified: string;      // ISO timestamp
  size: number;
}

export interface Manifest {
  files: Record<string, ManifestEntry>;
  lastSync: string | null;
}

export type SyncStatus = "idle" | "syncing" | "synced" | "error";

export interface SyncResult {
  pulled: number;
  pushed: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: number;
  errors: string[];
}

// --- Helpers ---

async function sha256(content: string): Promise<string> {
  const buf = new TextEncoder().encode(content);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function isExcluded(path: string, excluded: string[]): boolean {
  for (const ex of excluded) {
    if (path === ex || path.startsWith(ex + "/")) return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Identify transient errors that are worth retrying. Network blips and 5xx
 * server errors qualify; 4xx auth/validation errors do not.
 */
function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("err_connection_closed") ||
    msg.includes("err_network_changed") ||
    msg.includes("err_internet_disconnected") ||
    msg.includes("err_timed_out") ||
    msg.includes("failed to fetch") ||
    msg.includes("network") ||
    /\b5\d\d\b/.test(msg)
  );
}

/**
 * Wrap an async operation with exponential-backoff retry on transient errors.
 * Tries up to `attempts` times with delays of 500ms, 1s, 2s, ...
 */
async function withRetry<T>(
  op: () => Promise<T>,
  attempts: number = 3
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (!isTransientError(err) || i === attempts - 1) throw err;
      await sleep(500 * Math.pow(2, i));
    }
  }
  throw lastErr;
}

// --- Sync engine ---

export class SyncEngine {
  constructor(
    private app: App,
    private settings: VaultBridgeSettings,
    private onStatusChange: (status: SyncStatus, message?: string) => void,
    private loadLastKnown: () => Promise<Manifest>,
    private saveLastKnown: (manifest: Manifest) => Promise<void>
  ) {}

  /**
   * Build a manifest of all local files (sorted, with hashes).
   */
  private async buildLocalManifest(): Promise<Map<string, ManifestEntry>> {
    const local = new Map<string, ManifestEntry>();
    const files = this.app.vault.getFiles();

    for (const file of files) {
      if (isExcluded(file.path, this.settings.excludedFolders)) continue;

      try {
        const content = await this.app.vault.read(file);
        local.set(file.path, {
          hash: await sha256(content),
          modified: new Date(file.stat.mtime).toISOString(),
          size: file.stat.size,
        });
      } catch (err) {
        console.warn(`[VaultBridge] Failed to read ${file.path}:`, err);
      }
    }

    return local;
  }

  /**
   * Fetch the remote manifest from R2 (via the relay's sync API).
   * Uses Obsidian's requestUrl API to bypass CORS in the renderer.
   */
  private async fetchRemoteManifest(): Promise<Manifest> {
    const url = `${this.settings.relayUrl}/sync/manifest?token=${this.settings.token}`;
    return withRetry(async () => {
      const resp = await requestUrl({ url, method: "GET", throw: false });
      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(`Failed to fetch manifest: ${resp.status}`);
      }
      return resp.json as Manifest;
    });
  }

  /**
   * Push the merged manifest back to R2.
   */
  private async putRemoteManifest(manifest: Manifest): Promise<void> {
    const url = `${this.settings.relayUrl}/sync/manifest?token=${this.settings.token}`;
    await withRetry(async () => {
      const resp = await requestUrl({
        url,
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(manifest),
        throw: false,
      });
      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(`Failed to push manifest: ${resp.status}`);
      }
    });
  }

  /**
   * Download a file from R2.
   */
  private async pullFile(path: string): Promise<string> {
    const url = `${this.settings.relayUrl}/sync/files/${encodeURI(path)}?token=${this.settings.token}`;
    return withRetry(async () => {
      const resp = await requestUrl({ url, method: "GET", throw: false });
      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(`Failed to pull ${path}: ${resp.status}`);
      }
      return resp.text;
    });
  }

  /**
   * Upload a file to R2.
   */
  private async pushFile(path: string, content: string): Promise<void> {
    const url = `${this.settings.relayUrl}/sync/files/${encodeURI(path)}?token=${this.settings.token}`;
    await withRetry(async () => {
      const resp = await requestUrl({
        url,
        method: "PUT",
        headers: { "Content-Type": "text/markdown" },
        body: content,
        throw: false,
      });
      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(`Failed to push ${path}: ${resp.status}`);
      }
    });
  }

  /**
   * Delete a file from R2.
   */
  private async deleteRemoteFile(path: string): Promise<void> {
    const url = `${this.settings.relayUrl}/sync/files/${encodeURI(path)}?token=${this.settings.token}`;
    await withRetry(async () => {
      const resp = await requestUrl({ url, method: "DELETE", throw: false });
      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(`Failed to delete ${path}: ${resp.status}`);
      }
    });
  }

  /**
   * Write content to a local file (creating parent folders if needed).
   */
  private async writeLocalFile(path: string, content: string): Promise<void> {
    const normalised = normalizePath(path);
    const existing = this.app.vault.getAbstractFileByPath(normalised);

    // Ensure parent folder exists
    const parts = normalised.split("/");
    if (parts.length > 1) {
      const parentPath = parts.slice(0, -1).join("/");
      if (!this.app.vault.getAbstractFileByPath(parentPath)) {
        await this.app.vault.createFolder(parentPath);
      }
    }

    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
    } else {
      await this.app.vault.create(normalised, content);
    }
  }

  /**
   * Delete a local file (uses Obsidian trash).
   */
  private async deleteLocalFile(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (file instanceof TFile) {
      await this.app.vault.trash(file, true);
    }
  }

  /**
   * Read a local file's content.
   */
  private async readLocalFile(path: string): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(file instanceof TFile)) {
      throw new Error(`Local file not found: ${path}`);
    }
    return await this.app.vault.read(file);
  }

  /**
   * Run a full sync.
   */
  async sync(): Promise<SyncResult> {
    const result: SyncResult = {
      pulled: 0,
      pushed: 0,
      deletedLocal: 0,
      deletedRemote: 0,
      conflicts: 0,
      errors: [],
    };

    if (!this.settings.token) {
      throw new Error("No token configured. Open Vault Bridge settings to add one.");
    }

    this.onStatusChange("syncing", "Syncing...");

    try {
      // Three-way comparison: local now, remote now, last-known synced state
      const local = await this.buildLocalManifest();
      const remote = await this.fetchRemoteManifest();
      const lastKnown = await this.loadLastKnown();

      const remoteFiles = remote.files ?? {};
      const lastFiles = lastKnown.files ?? {};

      const allPaths = new Set([
        ...local.keys(),
        ...Object.keys(remoteFiles),
        ...Object.keys(lastFiles),
      ]);

      // The new last-known state we'll save at the end
      const newLastKnown: Record<string, ManifestEntry> = {};

      for (const path of allPaths) {
        if (isExcluded(path, this.settings.excludedFolders)) continue;

        const l = local.get(path);
        const r = remoteFiles[path];
        const k = lastFiles[path];

        try {
          // Case 1: Both local and remote exist
          if (l && r) {
            if (l.hash === r.hash) {
              // Identical → no-op, just record state
              newLastKnown[path] = l;
              continue;
            }

            const localChanged = !k || l.hash !== k.hash;
            const remoteChanged = !k || r.hash !== k.hash;

            if (localChanged && !remoteChanged) {
              // Only local changed → push
              const content = await this.readLocalFile(path);
              await this.pushFile(path, content);
              newLastKnown[path] = l;
              result.pushed++;
            } else if (!localChanged && remoteChanged) {
              // Only R2 changed → pull
              const content = await this.pullFile(path);
              await this.writeLocalFile(path, content);
              newLastKnown[path] = r;
              result.pulled++;
            } else {
              // Both changed → real conflict, R2 wins, save local as .conflict
              const localContent = await this.readLocalFile(path);
              const remoteContent = await this.pullFile(path);
              if (localContent !== remoteContent) {
                await this.writeLocalFile(`${path}.conflict.md`, localContent);
                result.conflicts++;
              }
              await this.writeLocalFile(path, remoteContent);
              newLastKnown[path] = r;
              result.pulled++;
            }
            continue;
          }

          // Case 2: Local-only
          if (l && !r) {
            if (k && l.hash === k.hash) {
              // Was previously synced and unchanged locally → R2 deleted it → delete locally
              await this.deleteLocalFile(path);
              result.deletedLocal++;
              // Don't add to newLastKnown (file gone)
            } else {
              // New local file (or local edited + R2 deleted = treat as new) → push
              const content = await this.readLocalFile(path);
              await this.pushFile(path, content);
              newLastKnown[path] = l;
              result.pushed++;
            }
            continue;
          }

          // Case 3: Remote-only
          if (!l && r) {
            if (k && r.hash === k.hash) {
              // Was previously synced and unchanged in R2 → local deleted it → delete from R2
              await this.deleteRemoteFile(path);
              result.deletedRemote++;
              // Don't add to newLastKnown (file gone)
            } else {
              // New remote file (or R2 edited + local deleted = treat as new from R2) → pull
              const content = await this.pullFile(path);
              await this.writeLocalFile(path, content);
              newLastKnown[path] = r;
              result.pulled++;
            }
            continue;
          }

          // Case 4: Tracked in last-known but neither local nor remote exists → drop
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(`${path}: ${msg}`);
          // Preserve last-known entry for this path if anything was there, so we retry next sync
          if (k) newLastKnown[path] = k;
        }
      }

      // Push merged manifest to R2 and save locally
      const merged: Manifest = {
        files: newLastKnown,
        lastSync: new Date().toISOString(),
      };
      await this.putRemoteManifest(merged);
      await this.saveLastKnown(merged);

      const totalChanges =
        result.pulled +
        result.pushed +
        result.deletedLocal +
        result.deletedRemote;
      const message =
        totalChanges === 0
          ? "Up to date"
          : `Synced (↓${result.pulled} ↑${result.pushed}${
              result.deletedLocal + result.deletedRemote > 0
                ? ` ✕${result.deletedLocal + result.deletedRemote}`
                : ""
            })`;

      this.onStatusChange("synced", message);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.onStatusChange("error", msg);
      throw err;
    }
  }

  /**
   * Initial upload — push every local file to R2 without comparing.
   * Use once when first connecting a vault.
   */
  async initialUpload(): Promise<SyncResult> {
    const result: SyncResult = {
      pulled: 0,
      pushed: 0,
      deletedLocal: 0,
      deletedRemote: 0,
      conflicts: 0,
      errors: [],
    };

    this.onStatusChange("syncing", "Initial upload...");

    try {
      const local = await this.buildLocalManifest();
      const newRemoteFiles: Record<string, ManifestEntry> = {};

      let i = 0;
      const total = local.size;

      for (const [path, entry] of local) {
        try {
          const file = this.app.vault.getAbstractFileByPath(path) as TFile;
          const content = await this.app.vault.read(file);
          await this.pushFile(path, content);
          newRemoteFiles[path] = entry;
          result.pushed++;
          i++;
          if (i % 10 === 0 || i === total) {
            this.onStatusChange("syncing", `Uploading ${i}/${total}...`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(`${path}: ${msg}`);
        }
      }

      const manifest: Manifest = {
        files: newRemoteFiles,
        lastSync: new Date().toISOString(),
      };
      await this.putRemoteManifest(manifest);
      await this.saveLastKnown(manifest);

      this.onStatusChange("synced", `Uploaded ${result.pushed} files`);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.onStatusChange("error", msg);
      throw err;
    }
  }
}
