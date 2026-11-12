import { parse } from "csv-parse/sync";

/**
 * The warehouse sheet's BOT STOCK and BOT PRICES tabs are the bot's only source for stock and prices.
 * config/stock.csv and the tables in config/pricing.json are snapshots of those tabs (npm run sync-sheet),
 * used when the live sheet can't be read.
 */

export type RowStatus = "for_sale" | "freebie" | "not_for_sale" | "other";

export interface StockRow {
  category: string;
  brand: string;
  item: string;
  color: string;
  size: string;
  /** Pieces on hand. "~60" reads as 60. Blank or unreadable = 0. */
  qty: number;
  priceList: string;
  status: RowStatus;
  rawStatus: string;
  notes: string;
  /** What Josh paid per piece (optional "Cost" column). Used to log profit in the sales tracker. */
  cost?: number;
}

export interface Freebie {
  item: string;
  /** Free once the order has at least this many paid pieces. */
  minPieces: number;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const noParens = (s: string) => norm(s.replace(/\([^)]*\)/g, " "));

/** CSV text, or rows straight from the Sheets API. */
export type Table = string | string[][];

function rowsOf(csv: Table): string[][] {
  if (Array.isArray(csv)) return csv.map((r) => r.map((c) => String(c ?? "").trim()));
  return (parse(csv, { skip_empty_lines: true, relax_column_count: true, relax_quotes: true }) as string[][]).map((r) =>
    r.map((c) => String(c ?? "").trim()),
  );
}

/** Finds the header row (the tabs have a title line above it) and maps column names to indexes. */
function headerIndex(rows: string[][], must: string[]): { at: number; col: (name: string) => number } | undefined {
  const at = rows.findIndex((r) => must.every((m) => r.some((c) => norm(c) === norm(m))));
  if (at < 0) return undefined;
  const header = rows[at].map(norm);
  return { at, col: (name) => header.indexOf(norm(name)) };
}

function statusOf(s: string): RowStatus {
  const n = norm(s);
  if (n === "for sale") return "for_sale";
  if (n === "freebie" || n === "free") return "freebie";
  if (n === "not for sale") return "not_for_sale";
  return "other";
}

function num(s: string): number {
  const m = s.replace(/,/g, "").match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : 0;
}

export function parseStockCsv(csv: Table): StockRow[] {
  const rows = rowsOf(csv);
  const h = headerIndex(rows, ["Item", "Status"]);
  if (!h) return [];
  const get = (r: string[], name: string) => {
    const i = h.col(name);
    return i >= 0 ? (r[i] ?? "") : "";
  };
  return rows
    .slice(h.at + 1)
    .filter((r) => get(r, "Item"))
    .map((r) => ({
      category: get(r, "Category"),
      brand: get(r, "Brand"),
      item: get(r, "Item"),
      color: get(r, "Color"),
      size: get(r, "Size"),
      qty: Math.floor(num(get(r, "Qty"))),
      priceList: get(r, "Price List"),
      status: statusOf(get(r, "Status")),
      rawStatus: get(r, "Status"),
      notes: get(r, "Notes"),
      ...(get(r, "Cost") ? { cost: num(get(r, "Cost")) } : {}),
    }));
}

/** BOT PRICES: Price List | Pieces | Total | Each. Returns { "ALO": { "1": 70, "2": 52, ... } }. */
export function parsePricesCsv(csv: Table): Record<string, Record<string, number>> {
  const rows = rowsOf(csv);
  const h = headerIndex(rows, ["Price List", "Pieces", "Each"]);
  const tables: Record<string, Record<string, number>> = {};
  if (!h) return tables;
  for (const r of rows.slice(h.at + 1)) {
    const list = r[h.col("Price List")]?.trim();
    const pieces = Math.floor(num(r[h.col("Pieces")] ?? ""));
    const eachCell = r[h.col("Each")] ?? "";
    const totalCell = h.col("Total") >= 0 ? (r[h.col("Total")] ?? "") : "";
    const each = eachCell ? num(eachCell) : pieces && totalCell ? num(totalCell) / pieces : 0;
    if (!list || pieces < 1 || !(each > 0)) continue;
    (tables[list] ??= {})[String(pieces)] = each;
  }
  return tables;
}

/** A row the bot must never price on its own: a CONFIRM note, or no price list / no prices for it. */
export function needsJosh(row: StockRow, tables: Record<string, Record<string, number>>): boolean {
  if (/confirm/i.test(row.notes)) return true;
  if (!row.priceList) return true;
  const t = findTable(tables, row.priceList);
  return !t || Object.keys(t).length === 0;
}

export function findTable(tables: Record<string, Record<string, number>>, list: string): Record<string, number> | undefined {
  const key = Object.keys(tables).find((k) => norm(k) === norm(list));
  return key ? tables[key] : undefined;
}

/** Freebies come from rows marked FREEBIE. A note like "5+ piece order" sets the minimum; otherwise every order. */
export function freebiesOf(rows: StockRow[]): Freebie[] {
  return rows
    .filter((r) => r.status === "freebie" && r.qty > 0)
    .map((r) => {
      const m = r.notes.match(/(\d+)\s*\+\s*(piece|pc|item)/i);
      return { item: r.item, minPieces: m ? Number(m[1]) : 1 };
    });
}

export function freebiesFor(rows: StockRow[], paidPieces: number): string[] {
  if (paidPieces < 1) return [];
  return freebiesOf(rows)
    .filter((f) => paidPieces >= f.minPieces)
    .map((f) => `1 free ${f.item}`);
}

export type Match =
  | { ok: true; rows: StockRow[]; available: number }
  | { ok: false; problem: string };

/** Which item name on the sheet the buyer means: exact, then without "(B tier)" etc, then one unique partial match. */
function itemRows(rows: StockRow[], wanted: string): StockRow[] {
  const w = norm(wanted);
  const wp = noParens(wanted);
  if (!w) return [];
  let hit = rows.filter((r) => norm(r.item) === w);
  if (!hit.length) hit = rows.filter((r) => noParens(r.item) === wp || norm(`${r.brand} ${r.item}`) === w);
  if (!hit.length) {
    const names = new Set(rows.filter((r) => ` ${norm(r.item)} `.includes(` ${wp} `) || ` ${wp} `.includes(` ${noParens(r.item)} `)).map((r) => r.item));
    if (names.size === 1) hit = rows.filter((r) => names.has(r.item));
  }
  return hit;
}

const sameField = (have: string, want: string) => {
  const h = norm(have);
  const w = norm(want);
  if (!w) return true;
  if (!h || h === "one size") return w === h || w === "one size" || w === "os";
  return h === w;
};

const label = (r: Pick<StockRow, "item" | "color" | "size">) => [r.item, r.color, r.size].filter((s) => s && norm(s) !== "one size").join(" ");

/** True if a sheet row is the item/color/size of an order line (same rules quote_order uses). */
export function rowMatches(r: Pick<StockRow, "item" | "color" | "size">, line: { name: string; variant?: string; size?: string }): boolean {
  return norm(r.item) === norm(line.name) && sameField(r.color, line.variant ?? "") && sameField(r.size, line.size ?? "");
}

/** Matches one order line to FOR SALE rows on the stock sheet and checks there's enough. */
export function matchStock(
  rows: StockRow[],
  tables: Record<string, Record<string, number>>,
  item: string,
  color: string | undefined,
  size: string | undefined,
  qty: number,
): Match {
  const named = itemRows(rows, item);
  if (!named.length) return { ok: false, problem: `"${item}" is not on the stock sheet (not in stock). Offer something we do have` };
  const blocked = named.find((r) => r.status === "freebie");
  if (blocked) return { ok: false, problem: `${blocked.item} is a free gift and never sold (it's added to orders automatically)` };
  const reserved = named.find((r) => r.status === "not_for_sale");
  if (reserved) return { ok: false, problem: `${reserved.item} is NOT FOR SALE. Hand off to josh` };
  const forSale = named.filter((r) => r.status === "for_sale" && r.qty > 0);
  if (!forSale.length && named.some((r) => norm(r.rawStatus) === "incoming")) {
    return { ok: false, problem: `${named[0].item} is INCOMING (lands with the restock), not in stock yet. Pitch it from the INCOMING RESTOCK and call save_interest; it can't be ordered yet` };
  }
  if (!forSale.length) return { ok: false, problem: `${named[0].item} is sold out` };
  const exact = forSale.filter((r) => sameField(r.color, color ?? "") && sameField(r.size, size ?? ""));
  if (!exact.length) {
    const have = forSale.map((r) => `${[r.color, r.size].filter(Boolean).join(" ")} (${r.qty})`).join(", ");
    return { ok: false, problem: `${forSale[0].item}${color ? ` ${color}` : ""}${size ? ` ${size}` : ""} is not in stock. In stock: ${have}` };
  }
  const confirm = exact.find((r) => needsJosh(r, tables));
  if (confirm) return { ok: false, problem: `${label(confirm)} has no set price yet (CONFIRM). Hand off to josh, never make up a price` };
  const lists = new Set(exact.map((r) => norm(r.priceList)));
  if (lists.size > 1) return { ok: false, problem: `"${item}" matches items with different prices. Ask which color/size` };
  const available = exact.reduce((s, r) => s + r.qty, 0);
  if (qty > available) return { ok: false, problem: `Only ${available} of ${label({ item: exact[0].item, color: color ?? "", size: size ?? "" })} in stock (asked for ${qty})` };
  return { ok: true, rows: exact, available };
}

/** Compact stock and price text for the AI's prompt. Only FOR SALE rows with stock are offered. */
export function formatCatalog(rows: StockRow[], tables: Record<string, Record<string, number>>): string {
  if (!rows.length) return "";
  const forSale = rows.filter((r) => r.status === "for_sale" && r.qty > 0 && !needsJosh(r, tables));
  const confirm = rows.filter((r) => r.status === "for_sale" && r.qty > 0 && needsJosh(r, tables));
  const soldOut = rows.filter((r) => r.status === "for_sale" && r.qty <= 0);
  const out: string[] = [];
  out.push("FOR SALE (item | color | size | qty | price list). Use the item name exactly as written in quote_order.");
  for (const r of forSale) out.push([r.item, r.color || "-", r.size || "-", r.qty, r.priceList].join(" | "));
  if (soldOut.length) out.push("", "SOLD OUT: " + soldOut.map(label).join(", "));
  if (confirm.length) out.push("", "IN STOCK BUT NO SET PRICE (hand off to josh, never quote a price): " + confirm.map(label).join(", "));
  const free = freebiesOf(rows);
  if (free.length) {
    out.push("", "FREE GIFTS (never sell these, never put them in quote_order; quote_order adds them by itself):");
    for (const f of free) out.push(`- ${f.item}: ${f.minPieces > 1 ? `free with any ${f.minPieces}+ piece order` : "1 free with EVERY order"}`);
  }
  const incoming = rows.filter((r) => norm(r.rawStatus) === "incoming");
  if (incoming.length) {
    out.push("", "INCOMING, NOT IN STOCK YET (can't be quoted or sold; pitch it and call save_interest, see INCOMING RESTOCK in the knowledge base): " + [...new Set(incoming.map((r) => [r.item, r.color].filter(Boolean).join(" ")))].join(", "));
  }
  const nfs = rows.filter((r) => r.status === "not_for_sale");
  if (nfs.length) out.push("", "NOT FOR SALE (if asked, hand off to josh): " + nfs.map((r) => r.item).join(", "));
  const used = [...new Set(forSale.map((r) => r.priceList))];
  out.push("", "PRICE LISTS (per piece; the tier is counted per price list across the whole order; in-between quantities use the highest tier reached):");
  for (const list of used) {
    const t = findTable(tables, list);
    if (!t) continue;
    const tiers = Object.keys(t).map(Number).sort((a, b) => a - b);
    out.push(`${list}: ${tiers.map((n) => `${n}=$${t[String(n)]}`).join(", ")}`);
  }
  return out.join("\n");
}
