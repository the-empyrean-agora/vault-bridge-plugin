import { App, Modal, Setting } from "obsidian";
import type { SyncSummary } from "./sync";

/**
 * Confirmation dialog shown when a planned sync exceeds the large-sync
 * threshold. Shows the full breakdown of what would change and resolves true
 * only on an explicit "Apply changes" — closing the dialog any other way
 * (Esc, click-away, Cancel) counts as a decline.
 */
export class ConfirmSyncModal extends Modal {
  private resolved = false;

  constructor(
    app: App,
    private summary: SyncSummary,
    private threshold: number,
    private onResolve: (apply: boolean) => void
  ) {
    super(app);
  }

  private resolve(apply: boolean): void {
    if (this.resolved) return;
    this.resolved = true;
    this.onResolve(apply);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.titleEl.setText("Vault Bridge — confirm large sync");

    contentEl.createEl("p", {
      text: `This sync wants to make ${this.summary.mutations} changes — above the confirmation threshold of ${this.threshold}. A count this size usually means a folder reorg or bulk edit; it can also mean a divergent copy about to overwrite the other side.`,
    });

    const list = contentEl.createEl("ul");
    const row = (n: number, text: string) => {
      if (n > 0) list.createEl("li", { text });
    };
    row(this.summary.pushes, `Push ${this.summary.pushes} file(s) to R2`);
    row(this.summary.pulls, `Pull ${this.summary.pulls} file(s) from R2`);
    row(
      this.summary.deletesRemote,
      `Delete ${this.summary.deletesRemote} file(s) from R2`
    );
    row(
      this.summary.deletesLocal,
      `Delete ${this.summary.deletesLocal} local file(s) (moved to Obsidian trash)`
    );
    row(
      this.summary.conflicts,
      `Resolve ${this.summary.conflicts} conflict(s) — R2 wins, local copies saved as .conflict.md`
    );

    contentEl.createEl("p", {
      text: "Cancel applies nothing; the same plan will be offered again on the next manual sync.",
    });

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("Apply changes")
          .setWarning()
          .onClick(() => {
            this.resolve(true);
            this.close();
          })
      )
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => {
          this.resolve(false);
          this.close();
        })
      );
  }

  onClose(): void {
    this.resolve(false);
    this.contentEl.empty();
  }
}
