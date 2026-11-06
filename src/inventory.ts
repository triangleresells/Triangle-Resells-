import { parse } from "csv-parse/sync";

const CACHE_MS = 5 * 60 * 1000;
const MAX_ROWS = 300;

/**
 * Turns the inventory sheet's CSV into compact text for the AI.
 * Any column layout works; the header row is kept so the AI knows what each column means.
 */
export function formatInventoryCsv(csv: string): string {
  const rows = parse(csv, { skip_empty_lines: true, relax_column_count: true }) as string[][];
  const cleaned = rows
    .map((r) => r.map((c) => c.trim()))
    .filter((r) => r.some((c) => c !== ""));
  if (cleaned.length < 2) return "";
  return cleaned
    .slice(0, MAX_ROWS + 1)
    .map((r) => r.join(" | "))
    .join("\n");
}

/**
 * Fetches the published Google Sheet, cached for 5 minutes. Falls back to the last good copy on errors.
 * With no sheet URL, uses config/stock.csv (a starter list Josh edits on GitHub) until the sheet is ready.
 */
export class InventorySheet {
  private cached = "";
  private fetchedAt = 0;
  private fallback: string;

  constructor(
    private url: string,
    private fetchFn: typeof fetch = fetch,
    fallbackCsv = "",
  ) {
    this.fallback = fallbackCsv ? formatInventoryCsv(fallbackCsv) : "";
  }

  async get(): Promise<string> {
    if (!this.url) return this.fallback;
    if (Date.now() - this.fetchedAt < CACHE_MS) return this.cached;
    try {
      const res = await this.fetchFn(this.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.cached = formatInventoryCsv(await res.text());
      this.fetchedAt = Date.now();
    } catch (err) {
      console.error("[inventory] could not load sheet, using last copy:", err);
    }
    return this.cached;
  }
}
