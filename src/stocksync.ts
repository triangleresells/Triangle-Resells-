/**
 * BOT STOCK <-> CRM, every minute. The CRM keeps the live count (it reserves pieces with each booking); the sheet is
 * where people edit stock. Each run: read the tab, send it to the CRM (edits made on the sheet, like a restock, flow in),
 * and write back the counts the CRM says the sheet should show. "BOT STOCK TEST" (a copy of the tab, if it exists) is
 * synced into TEST stock, which only TEST bookings use.
 */
import { parseStockCsv } from "./catalog.js";
import type { Crm, CrmStockRow } from "./crm.js";
import type { SheetIO, StockKeeper } from "./desk.js";
import { STOCK_TAB } from "./sheet.js";

export const TEST_STOCK_TAB = "BOT STOCK TEST";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** BOT STOCK as read (rows of cells) -> rows for the CRM. */
export function crmRowsOf(table: string[][]): CrmStockRow[] {
  return parseStockCsv(table).map((r) => ({
    category: r.category,
    brand: r.brand,
    item: r.item,
    color: r.color,
    size: r.size,
    qty: String(r.qty),
    price_list: r.priceList,
    status: norm(r.rawStatus) === "incoming" ? "incoming" : r.status,
    notes: r.notes,
    cost: r.cost === undefined ? "" : String(r.cost),
  }));
}

export interface StockSyncDeps {
  crm: Crm;
  io: Pick<SheetIO, "tabs">;
  keeper: Pick<StockKeeper, "setQty">;
}

export class StockSync {
  private running = false;
  constructor(private d: StockSyncDeps) {}

  /** One sync of both tabs. Never throws. Returns how many cells it wrote. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let wrote = 0;
    try {
      for (const [tab, isTest] of [[STOCK_TAB, false], [TEST_STOCK_TAB, true]] as const) {
        let table: string[][];
        try {
          [table] = await this.d.io.tabs([tab]);
        } catch (err) {
          if (!isTest) console.error(`[stock-sync] can't read ${tab}:`, (err as Error).message ?? err);
          continue; // no test tab is fine
        }
        const rows = crmRowsOf(table ?? []);
        // An empty read (a glitch, or a cleared tab) must never mark every item as removed.
        if (!rows.length) continue;
        try {
          const res = await this.d.crm.syncStock(rows, isTest);
          if (res.sheet_edits_applied) console.log(`[stock-sync] ${res.sheet_edits_applied} edit(s) on ${tab} applied to the CRM`);
          if (res.writes.length) {
            const problems = await this.d.keeper.setQty(res.writes, tab);
            wrote += res.writes.length - problems.length;
            for (const p of problems) console.error(`[stock-sync] ${p}`);
          }
        } catch (err) {
          console.error(`[stock-sync] ${tab} -> CRM failed:`, (err as Error).message ?? err);
        }
      }
    } finally {
      this.running = false;
    }
    return wrote;
  }
}
