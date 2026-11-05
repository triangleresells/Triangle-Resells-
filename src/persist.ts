import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Store, StoreSnapshot } from "./store.js";

/**
 * The bot's small database: one JSON file. Loaded at startup, saved a couple of seconds after
 * anything changes (written to a temp file first, so a crash mid-save can't corrupt it).
 * On Render, point STATE_FILE at the persistent disk (render.yaml mounts /var/data).
 */
export class FileSaver {
  private timer?: NodeJS.Timeout;

  constructor(
    private file: string,
    private store: Store,
    private delayMs = 2000,
  ) {}

  load(): void {
    if (!this.file) return;
    try {
      const snap = JSON.parse(readFileSync(this.file, "utf8")) as StoreSnapshot;
      this.store.restore(snap);
      console.log(`[persist] loaded ${snap.convos?.length ?? 0} chats and ${snap.customers?.length ?? 0} customers from ${this.file}`);
    } catch (err: any) {
      if (err?.code !== "ENOENT") console.error(`[persist] could not read ${this.file}, starting fresh:`, err);
    }
  }

  /** Start saving on every change. */
  watch(): void {
    if (!this.file) return;
    this.store.onChange = () => {
      if (this.timer) return;
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.saveNow();
      }, this.delayMs);
      this.timer.unref?.();
    };
  }

  saveNow(): void {
    if (!this.file) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.store.snapshot()));
      renameSync(tmp, this.file);
    } catch (err) {
      console.error("[persist] save failed:", err);
    }
  }
}
