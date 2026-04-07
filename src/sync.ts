/**
 * Sync engine — bidirectional sync between local Obsidian vault and Cloudflare R2.
 *
 * Algorithm: pull-before-push with three-way diff.
 *   1. Build local index (one entry per file: hash + tokens + tags + links + ...)
 *   2. Fetch remote index from R2
 *   3. Compare local vs remote vs last-known synced state
 *   4. Pull files newer in R2, push files newer locally, handle deletes both ways
 *   5. Push merged index back to R2 and persist locally
 *
 * Conflict policy: R2 wins. Local conflicting version saved as `<name>.conflict.md`.
 *
 * The index is stored locally in the plugin's data.json (via main.ts) and in R2
 * at `{userPrefix}/_vault-bridge-index.json`. The Worker maintains entries on
 * write_file/delete_file calls so Claude's writes propagate without waiting for
 * the next plugin sync.
 */

import { App, TFile, normalizePath, requestUrl } from "obsidian";
import type { VaultBridgeSettings } from "./settings";
import {
  parseFile,
  type FileIndexEntry,
  type VaultIndex,
} from "./index-format";

export type { FileIndexEntry, VaultIndex } from "./index-format";

// --- Types ---

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
    private loadLastKnown: () => Promise<VaultIndex>,
    private saveLastKnown: (index: VaultIndex) => Promise<void>
  ) {}

  /**
   * Build a complete index of all local files. Each entry includes the
   * sync metadata (hash/modified/size) plus everything needed for search,
   * backlinks, tags, and previews.
   */
  private async buildLocalIndex(): Promise<Map<string, FileIndexEntry>> {
    const local = new Map<string, FileIndexEntry>();
    const files = this.app.vault.getFiles();

    for (const file of files) {
      if (isExcluded(file.path, this.settings.excludedFolders)) continue;

      try {
        const content = await this.app.vault.read(file);
        const hash = await sha256(content);
        const filename = file.path.split("/").pop() ?? file.path;
        local.set(
          file.path,
          parseFile(
            content,
            hash,
            new Date(file.stat.mtime).toISOString(),
            file.stat.size,
            filename
          )
        );
      } catch (err) {
        console.warn(`[VaultBridge] Failed to read ${file.path}:`, err);
      }
    }

    return local;
  }

  /**
   * Fetch the remote vault index from R2 (via the relay's sync API).
   * Uses Obsidian's requestUrl API to bypass CORS in the renderer.
   */
  private async fetchRemoteIndex(): Promise<VaultIndex> {
    const url = `${this.settings.relayUrl}/sync/index?token=${this.settings.token}`;
    return withRetry(async () => {
      const resp = await requestUrl({ url, method: "GET", throw: false });
      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(`Failed to fetch index: ${resp.status}`);
      }
      return resp.json as VaultIndex;
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
      const local = await this.buildLocalIndex();
      const remote = await this.fetchRemoteIndex();
      const lastKnown = await this.loadLastKnown();

      const remoteFiles = remote.files ?? {};
      const lastFiles = lastKnown.files ?? {};

      const allPaths = new Set([
        ...local.keys(),
        ...Object.keys(remoteFiles),
        ...Object.keys(lastFiles),
      ]);

      // The new last-known state we'll save at the end
      const newLastKnown: Record<string, FileIndexEntry> = {};

      for (const path of allPaths) {
        if (isExcluded(path, this.settings.excludedFolders)) continue;

        const l = local.get(path);
        const r = remoteFiles[path];
        const k = lastFiles[path];

        try {
          // Case 1: Both local and remote exist
          if (l && r) {
            if (l.hash === r.hash) {
              // Identical → no-op, just record state (prefer local — it has fresh tokens)
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
              // Re-parse the pulled content so the index entry has fresh tokens
              const filename = path.split("/").pop() ?? path;
              newLastKnown[path] = parseFile(
                content,
                r.hash,
                r.modified,
                r.size,
                filename
              );
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
              const filename = path.split("/").pop() ?? path;
              newLastKnown[path] = parseFile(
                remoteContent,
                r.hash,
                r.modified,
                r.size,
                filename
              );
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
              const filename = path.split("/").pop() ?? path;
              newLastKnown[path] = parseFile(
                content,
                r.hash,
                r.modified,
                r.size,
                filename
              );
              result.pulled++;
            }
            continue;
          }

          // Case 4: Tracked in last-known but neither local nor remote exists → drop
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(`${path}: ${msg}`);
          // Preserve last-known entry for this path so we retry next sync
          if (k) newLastKnown[path] = k;
        }
      }

      // Save the merged state locally as our new "last known" snapshot.
      // We DO NOT push the index to R2 — the Worker owns the R2 index and
      // updates it atomically as a side effect of each file upload/delete.
      // Pushing a whole index from the plugin would race with concurrent
      // MCP writes from Claude and clobber them.
      const merged: VaultIndex = {
        version: 1,
        files: newLastKnown,
        lastUpdated: new Date().toISOString(),
      };
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
   * Use once when first connecting a vault. Builds and pushes the full index.
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
      const local = await this.buildLocalIndex();
      const newRemoteFiles: Record<string, FileIndexEntry> = {};

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

      // Save locally only. The Worker updated the R2 index atomically
      // for each file we PUT above, so R2's index is already current.
      const index: VaultIndex = {
        version: 1,
        files: newRemoteFiles,
        lastUpdated: new Date().toISOString(),
      };
      await this.saveLastKnown(index);

      this.onStatusChange("synced", `Uploaded ${result.pushed} files`);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.onStatusChange("error", msg);
      throw err;
    }
  }
}
