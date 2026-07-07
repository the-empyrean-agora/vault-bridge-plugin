/**
 * Sync engine — bidirectional sync between local Obsidian vault and Cloudflare R2.
 *
 * Algorithm: pull-before-push with three-way diff, in two phases.
 *   1. Plan — build local index, fetch remote index, compare local vs remote
 *      vs last-known synced state; classify every path into a pending op.
 *      Nothing mutates in this phase.
 *   2. Apply — execute the ops (pull / push / delete / conflict) with
 *      per-file progress, then persist the merged index locally.
 * Between the phases sits the large-sync guardrail: if the plan contains more
 * mutations (pushes + deletes + conflicts) than settings.largeSyncThreshold,
 * the sync pauses and requires explicit confirmation before applying —
 * protection against runaway bulk syncs (see docs/sync-hardening-brief.md in
 * the relay repo, written after the 2026-07-07 folder-reorg incident).
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
  /** True when the large-sync guardrail stopped the sync before applying anything. */
  aborted: boolean;
  /** True when the sync stepped aside for an active remote-write lease. */
  deferred: boolean;
  /** The plan the guardrail blocked; present only when aborted. */
  planned?: SyncSummary;
}

/** Counts of what a sync is about to do, computed before anything mutates. */
export interface SyncSummary {
  pulls: number;
  pushes: number;
  deletesLocal: number;
  deletesRemote: number;
  conflicts: number;
  /** pushes + deletes + conflicts — the destructive subset the guardrail counts. */
  mutations: number;
}

export interface SyncOptions {
  /**
   * Called when the planned diff exceeds settings.largeSyncThreshold.
   * Return true to apply anyway; returning false — or omitting the callback —
   * aborts the sync with nothing applied.
   */
  confirmLargeSync?: (summary: SyncSummary) => Promise<boolean>;
  /**
   * Step aside while the relay reports an active remote-write lease (Claude
   * mid-burst). Background syncs set this; manual syncs don't. The caller
   * enforces a max-defer cap so a stuck lease can't freeze sync forever.
   */
  deferOnRemoteWrite?: boolean;
}

/**
 * One pending operation from the plan phase. `r` (the remote index entry at
 * plan time) doubles as the If-Match base for guarded pushes/deletes; `k`
 * (last-known) is preserved on per-file errors so the path retries next sync.
 */
type PlannedOp =
  | {
      action: "push" | "pull" | "conflict" | "delete-remote";
      path: string;
      r: FileIndexEntry;
      k?: FileIndexEntry;
    }
  | { action: "push-new" | "delete-local"; path: string; k?: FileIndexEntry };

// --- Helpers ---

/**
 * Thrown when the relay rejects a conditional write/delete with 412 — the file
 * changed in R2 since our snapshot (e.g. Claude wrote it). The sync loop catches
 * this and reconciles (re-pull + conflict-file) instead of clobbering.
 */
class PreconditionFailedError extends Error {
  constructor(public readonly path: string) {
    super(`Precondition failed for ${path} (changed remotely)`);
    this.name = "PreconditionFailedError";
  }
}

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

/**
 * Include-only scope filter. An empty list means "no scope" — everything is
 * in scope. With a non-empty list, only paths matching or sitting under one of
 * the prefixes are in scope.
 *
 * MUST be applied uniformly to local, remote, and last-known views in the diff
 * — out-of-scope paths must never enter the comparison at all. If a path
 * appeared in last-known but is filtered from local, the diff would mis-read
 * it as a local delete and push a delete to R2.
 */
function isInScope(path: string, scoped: string[]): boolean {
  if (scoped.length === 0) return true;
  for (const s of scoped) {
    if (path === s || path.startsWith(s + "/")) return true;
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

function summarise(ops: PlannedOp[]): SyncSummary {
  const s: SyncSummary = {
    pulls: 0,
    pushes: 0,
    deletesLocal: 0,
    deletesRemote: 0,
    conflicts: 0,
    mutations: 0,
  };
  for (const op of ops) {
    switch (op.action) {
      case "pull":
        s.pulls++;
        break;
      case "push":
      case "push-new":
        s.pushes++;
        break;
      case "conflict":
        s.conflicts++;
        break;
      case "delete-local":
        s.deletesLocal++;
        break;
      case "delete-remote":
        s.deletesRemote++;
        break;
    }
  }
  s.mutations = s.pushes + s.deletesLocal + s.deletesRemote + s.conflicts;
  return s;
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
      if (!isInScope(file.path, this.settings.scopedFolders)) continue;

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
   *
   * The relay sets `X-Remote-Write-Active: 1` while an MCP write burst
   * (Claude editing) is in flight — the write-lease a background sync defers
   * to. Absent header (older relay) reads as inactive.
   */
  private async fetchRemoteIndex(): Promise<{
    index: VaultIndex;
    remoteWriteActive: boolean;
  }> {
    const url = `${this.settings.relayUrl}/sync/index?token=${this.settings.token}`;
    return withRetry(async () => {
      const resp = await requestUrl({ url, method: "GET", throw: false });
      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(`Failed to fetch index: ${resp.status}`);
      }
      const headers = resp.headers ?? {};
      const lease =
        headers["x-remote-write-active"] ?? headers["X-Remote-Write-Active"];
      return {
        index: resp.json as VaultIndex,
        remoteWriteActive: lease === "1",
      };
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
   * Upload a file to R2. Pass `ifMatch` (the base content-hash we're overwriting)
   * or `ifNoneMatch: "*"` (create-only) to get optimistic-concurrency protection:
   * the relay returns 412 if the file changed in R2 since our snapshot, which we
   * surface as PreconditionFailedError for the caller to reconcile.
   */
  private async pushFile(
    path: string,
    content: string,
    opts: { ifMatch?: string; ifNoneMatch?: string } = {}
  ): Promise<void> {
    const url = `${this.settings.relayUrl}/sync/files/${encodeURI(path)}?token=${this.settings.token}`;
    await withRetry(async () => {
      const headers: Record<string, string> = { "Content-Type": "text/markdown" };
      if (opts.ifMatch) headers["If-Match"] = opts.ifMatch;
      if (opts.ifNoneMatch) headers["If-None-Match"] = opts.ifNoneMatch;
      const resp = await requestUrl({
        url,
        method: "PUT",
        headers,
        body: content,
        throw: false,
      });
      if (resp.status === 412) throw new PreconditionFailedError(path);
      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(`Failed to push ${path}: ${resp.status}`);
      }
    });
  }

  /**
   * Delete a file from R2. Pass `ifMatch` to guard the delete — the relay
   * returns 412 (→ PreconditionFailedError) if the file changed in R2 since our
   * snapshot, so we don't delete a version we never saw.
   */
  private async deleteRemoteFile(
    path: string,
    opts: { ifMatch?: string } = {}
  ): Promise<void> {
    const url = `${this.settings.relayUrl}/sync/files/${encodeURI(path)}?token=${this.settings.token}`;
    await withRetry(async () => {
      const headers: Record<string, string> = {};
      if (opts.ifMatch) headers["If-Match"] = opts.ifMatch;
      const resp = await requestUrl({ url, method: "DELETE", headers, throw: false });
      if (resp.status === 412) throw new PreconditionFailedError(path);
      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(`Failed to delete ${path}: ${resp.status}`);
      }
    });
  }

  /**
   * Reconcile a path after a push/delete was rejected with 412 (it changed in
   * R2 since our snapshot). Pull the current remote, save the local copy as
   * `.conflict.md` if it differs, and adopt the remote — the same "R2 wins,
   * never silently lose" policy as the both-changed branch.
   */
  private async reconcileRemoteChange(
    path: string,
    result: SyncResult,
    newLastKnown: Record<string, FileIndexEntry>
  ): Promise<void> {
    const remoteContent = await this.pullFile(path);
    let localContent: string | null = null;
    try {
      localContent = await this.readLocalFile(path);
    } catch {
      localContent = null; // local may have been deleted — nothing to preserve
    }
    if (localContent !== null && localContent !== remoteContent) {
      await this.writeLocalFile(`${path}.conflict.md`, localContent);
      result.conflicts++;
    }
    await this.writeLocalFile(path, remoteContent);
    const filename = path.split("/").pop() ?? path;
    const hash = await sha256(remoteContent);
    const size = new TextEncoder().encode(remoteContent).length;
    newLastKnown[path] = parseFile(
      remoteContent,
      hash,
      new Date().toISOString(),
      size,
      filename
    );
    result.pulled++;
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
   * Read a local file fresh and push it to R2, returning a fresh index entry
   * for the content actually sent. Re-reading at apply time (rather than
   * reusing the plan-time entry) matters because the confirmation dialog can
   * hold a plan open for minutes while the user keeps editing.
   */
  private async pushLocalFile(
    path: string,
    opts: { ifMatch?: string; ifNoneMatch?: string }
  ): Promise<FileIndexEntry> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(file instanceof TFile)) {
      throw new Error(`Local file not found: ${path}`);
    }
    const content = await this.app.vault.read(file);
    await this.pushFile(path, content, opts);
    const hash = await sha256(content);
    const filename = path.split("/").pop() ?? path;
    return parseFile(
      content,
      hash,
      new Date(file.stat.mtime).toISOString(),
      file.stat.size,
      filename
    );
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
   * Run a full sync (plan → guardrail → apply; see module comment).
   */
  async sync(opts: SyncOptions = {}): Promise<SyncResult> {
    const result: SyncResult = {
      pulled: 0,
      pushed: 0,
      deletedLocal: 0,
      deletedRemote: 0,
      conflicts: 0,
      errors: [],
      aborted: false,
      deferred: false,
    };

    if (!this.settings.token) {
      throw new Error("No token configured. Open Vault Bridge settings to add one.");
    }

    this.onStatusChange("syncing", "Checking for changes...");

    try {
      // Fetch remote first: if a remote-write lease is active, a background
      // sync steps aside before paying for the full local vault scan.
      const { index: remote, remoteWriteActive } = await this.fetchRemoteIndex();
      if (remoteWriteActive && opts.deferOnRemoteWrite) {
        result.deferred = true;
        this.onStatusChange("idle", "Sync deferred — remote write in progress");
        return result;
      }

      // --- Phase 1: plan. Three-way comparison (local now, remote now,
      // last-known synced state) classifying every path. No mutations here.
      const local = await this.buildLocalIndex();
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
      const ops: PlannedOp[] = [];

      for (const path of allPaths) {
        if (isExcluded(path, this.settings.excludedFolders)) continue;
        if (!isInScope(path, this.settings.scopedFolders)) continue;

        const l = local.get(path);
        const r = remoteFiles[path];
        const k = lastFiles[path];

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
            ops.push({ action: "push", path, r, k });
          } else if (!localChanged && remoteChanged) {
            ops.push({ action: "pull", path, r, k });
          } else {
            ops.push({ action: "conflict", path, r, k });
          }
          continue;
        }

        // Case 2: Local-only
        if (l && !r) {
          if (k && l.hash === k.hash) {
            // Was previously synced and unchanged locally → R2 deleted it → delete locally
            ops.push({ action: "delete-local", path, k });
          } else {
            // New local file (or local edited + R2 deleted = treat as new)
            ops.push({ action: "push-new", path, k });
          }
          continue;
        }

        // Case 3: Remote-only
        if (!l && r) {
          if (k && r.hash === k.hash) {
            // Was previously synced and unchanged in R2 → local deleted it → delete from R2
            ops.push({ action: "delete-remote", path, r, k });
          } else {
            // New remote file (or R2 edited + local deleted = treat as new from R2) → pull
            ops.push({ action: "pull", path, r, k });
          }
          continue;
        }

        // Case 4: Tracked in last-known but neither local nor remote exists → drop
      }

      // --- Guardrail: pause for confirmation on a large diff. Aborting saves
      // nothing — last-known stays put, so the same plan is recomputed on the
      // next sync rather than half-applied.
      const summary = summarise(ops);
      const threshold = this.settings.largeSyncThreshold;
      if (threshold > 0 && summary.mutations > threshold) {
        const ok = opts.confirmLargeSync
          ? await opts.confirmLargeSync(summary)
          : false;
        if (!ok) {
          result.aborted = true;
          result.planned = summary;
          this.onStatusChange(
            "error",
            `Sync paused: ${summary.mutations} pending changes — run "Sync now" to review`
          );
          return result;
        }
      }

      // --- Phase 2: apply ---
      const total = ops.length;
      let done = 0;
      const progress = () => {
        done++;
        const deletes = result.deletedLocal + result.deletedRemote;
        this.onStatusChange(
          "syncing",
          `Syncing ${done}/${total} (↓${result.pulled} ↑${result.pushed}${
            deletes > 0 ? ` ✕${deletes}` : ""
          })`
        );
      };

      for (const op of ops) {
        const path = op.path;
        try {
          switch (op.action) {
            case "push": {
              // Only local changed → push. Guard on r.hash (the remote base we
              // believe we're overwriting); if R2 changed since (e.g. Claude
              // wrote it), the relay 412s and we reconcile instead of clobbering.
              try {
                newLastKnown[path] = await this.pushLocalFile(path, {
                  ifMatch: op.r.hash,
                });
                result.pushed++;
              } catch (err) {
                if (err instanceof PreconditionFailedError) {
                  await this.reconcileRemoteChange(path, result, newLastKnown);
                } else throw err;
              }
              break;
            }

            case "push-new": {
              // Create-only push; if R2 gained this path since our snapshot,
              // 412 → reconcile rather than clobber.
              try {
                newLastKnown[path] = await this.pushLocalFile(path, {
                  ifNoneMatch: "*",
                });
                result.pushed++;
              } catch (err) {
                if (err instanceof PreconditionFailedError) {
                  await this.reconcileRemoteChange(path, result, newLastKnown);
                } else throw err;
              }
              break;
            }

            case "pull": {
              const content = await this.pullFile(path);
              await this.writeLocalFile(path, content);
              // Re-parse the pulled content so the index entry has fresh tokens
              const filename = path.split("/").pop() ?? path;
              newLastKnown[path] = parseFile(
                content,
                op.r.hash,
                op.r.modified,
                op.r.size,
                filename
              );
              result.pulled++;
              break;
            }

            case "conflict": {
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
                op.r.hash,
                op.r.modified,
                op.r.size,
                filename
              );
              result.pulled++;
              break;
            }

            case "delete-local": {
              await this.deleteLocalFile(path);
              result.deletedLocal++;
              // Don't add to newLastKnown (file gone)
              break;
            }

            case "delete-remote": {
              // Guard on r.hash: if R2 changed since (Claude wrote it), don't
              // delete — pull the new version back locally.
              try {
                await this.deleteRemoteFile(path, { ifMatch: op.r.hash });
                result.deletedRemote++;
                // Don't add to newLastKnown (file gone)
              } catch (err) {
                if (err instanceof PreconditionFailedError) {
                  await this.reconcileRemoteChange(path, result, newLastKnown);
                } else throw err;
              }
              break;
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(`${path}: ${msg}`);
          // Preserve last-known entry for this path so we retry next sync
          if (op.k) newLastKnown[path] = op.k;
        }
        progress();
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

      const deletes = result.deletedLocal + result.deletedRemote;
      const totalChanges = result.pulled + result.pushed + deletes;
      let message: string;
      if (totalChanges === 0 && result.errors.length === 0) {
        message = "Up to date";
      } else {
        message = `Synced (↓${result.pulled} ↑${result.pushed}${
          deletes > 0 ? ` ✕${deletes}` : ""
        })`;
        if (result.errors.length > 0) {
          message += ` — ${result.errors.length} error(s)`;
        }
      }

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
      aborted: false,
      deferred: false,
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
