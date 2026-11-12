/**
 * Reads Josh's sales tracker (one tab per month, headers on row 5, data from row 6) into rows for the CRM's
 * import_sales. Online orders live in columns A-AA, local meetups in AD-AN. Columns are found by their header names
 * (so a moved column still reads right), with the brief's order as the fallback.
 */

export interface ImportRow {
  key: string;
  date: string;
  channel?: string;
  handle?: string;
  buyer_name?: string;
  phone?: string;
  products?: string;
  cost?: string;
  total?: string;
  platform_fee?: string;
  label_cost?: string;
  payment?: string;
  closer?: string;
  fulfillment: "ship" | "pickup";
  location?: string;
  tracking?: string;
  notes?: string;
  items: { item: string; qty: number }[];
}

const norm = (s: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** "A" -> 0, "AD" -> 29. */
export const colIndex = (letters: string) => [...letters].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;
const colName = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : colName(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)));

/** "$1,234.50" -> "1234.50"; blank or text -> undefined. */
export function moneyOf(v: string | undefined): string | undefined {
  const m = String(v ?? "").replace(/[$,\s]/g, "").match(/^-?\d+(\.\d+)?$/);
  return m ? String(Math.abs(Number(m[0]))) : undefined;
}

/** "11/3/2026", "11/3/26", "2026-11-03", "11/3" (year from the tab) -> "2026-11-03". */
export function dateOf(v: string | undefined, tabYear: number): string | undefined {
  const s = String(v ?? "").trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (!m) return undefined;
  const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : tabYear;
  return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

/** "2x Alo Hoodie Gray M, 1x Bleu de Chanel" -> [{item: "Alo Hoodie Gray M", qty: 2}, {item: "Bleu de Chanel", qty: 1}]. */
export function itemsOf(products: string | undefined): { item: string; qty: number }[] {
  return String(products ?? "")
    .split(/[,;\n+]|\band\b/i)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const lead = p.match(/^(\d+)\s*x\s*(.+)$/i);
      const tail = p.match(/^(.+?)\s*x\s*(\d+)$/i);
      if (lead) return { item: lead[2].trim(), qty: Number(lead[1]) };
      if (tail) return { item: tail[1].trim(), qty: Number(tail[2]) };
      return { item: p, qty: 1 };
    })
    .filter((i) => i.item.length > 0 && i.qty > 0);
}

/** Tab names that are months ("Nov 2026"), except the ones to skip ("Oct 2026"). */
export function monthTabs(names: string[], skip: string[] = ["Oct 2026"]): string[] {
  const skipped = new Set(skip.map(norm));
  return names.filter((n) => /^[A-Za-z]{3,9}\s+\d{4}$/.test(n.trim()) && !skipped.has(norm(n)));
}

const ONLINE = { from: colIndex("A"), to: colIndex("AA") };
const LOCAL = { from: colIndex("AD"), to: colIndex("AN") };
// The brief's column order, used when a header can't be found.
const ONLINE_DEFAULT: Record<string, string> = {
  date: "A", channel: "B", handle: "C", products: "D", cost: "E", total: "F", platform_fee: "G", label_cost: "H", payment: "J", buyer_name: "L", phone: "M",
};
const LOCAL_DEFAULT: Record<string, string> = { date: "AD", closer: "AE", buyer: "AF", products: "AG", cost: "AH", total: "AI", payment: "AK", notes: "AN" };
const ONLINE_NAMES: Record<string, string[]> = {
  date: ["date"], channel: ["sales channel", "channel"], handle: ["handle", "ig", "instagram"], products: ["products sold", "products"],
  cost: ["product cost", "cost"], total: ["order total", "total"], platform_fee: ["platform fee", "fee"], label_cost: ["label cost", "label"],
  payment: ["payment method", "payment"], buyer_name: ["buyer name", "name"], phone: ["phone"], tracking: ["tracking number", "tracking"], notes: ["notes"],
};
const LOCAL_NAMES: Record<string, string[]> = {
  date: ["date"], closer: ["closer"], buyer: ["buyer"], products: ["products"], cost: ["cost"], total: ["sale", "total"], payment: ["payment"], notes: ["meetup notes", "notes"],
};

function columns(header: string[], block: { from: number; to: number }, names: Record<string, string[]>, fallback: Record<string, string>) {
  const out: Record<string, number> = {};
  for (const [field, options] of Object.entries(names)) {
    let found = -1;
    for (const o of options) {
      for (let c = block.from; c <= block.to; c++) if (norm(header[c] ?? "") === o) { found = c; break; }
      if (found >= 0) break;
    }
    out[field] = found >= 0 ? found : fallback[field] ? colIndex(fallback[field]) : -1;
  }
  return out;
}

/** One month tab (rows from row 1) -> the sales on it. Rows with no date, no products and no total are skipped. */
export function parseTrackerTab(tab: string, values: string[][]): ImportRow[] {
  const header = values[4] ?? [];
  const year = Number(tab.match(/\d{4}/)?.[0] ?? new Date().getFullYear());
  const on = columns(header, ONLINE, ONLINE_NAMES, ONLINE_DEFAULT);
  const lo = columns(header, LOCAL, LOCAL_NAMES, LOCAL_DEFAULT);
  // Address: every header in the online block that looks like part of one.
  const addressCols: number[] = [];
  for (let c = ONLINE.from; c <= ONLINE.to; c++) if (/address|street|apt|city|state|zip/.test(norm(header[c] ?? ""))) addressCols.push(c);
  const cell = (r: string[], c: number) => (c >= 0 ? String(r[c] ?? "").trim() || undefined : undefined);
  const out: ImportRow[] = [];
  values.slice(5).forEach((r, i) => {
    const rowNo = i + 6;
    // Online order (ships).
    if (cell(r, on.date) || cell(r, on.products) || cell(r, on.total)) {
      const products = cell(r, on.products);
      const address = addressCols.map((c) => cell(r, c)).filter(Boolean).join(", ");
      out.push({
        key: `${tab}!A${rowNo}`, date: dateOf(cell(r, on.date), year) ?? "", channel: cell(r, on.channel), handle: cell(r, on.handle),
        buyer_name: cell(r, on.buyer_name), phone: cell(r, on.phone), products, cost: moneyOf(cell(r, on.cost)), total: moneyOf(cell(r, on.total)),
        platform_fee: moneyOf(cell(r, on.platform_fee)), label_cost: moneyOf(cell(r, on.label_cost)), payment: cell(r, on.payment),
        fulfillment: "ship", location: address || undefined, tracking: cell(r, on.tracking), notes: cell(r, on.notes), items: itemsOf(products),
      });
    }
    // Local meetup (pickup).
    if (cell(r, lo.date) || cell(r, lo.products) || cell(r, lo.total)) {
      const products = cell(r, lo.products);
      const buyer = cell(r, lo.buyer);
      out.push({
        key: `${tab}!${colName(LOCAL.from)}${rowNo}`, date: dateOf(cell(r, lo.date), year) ?? "", channel: "Meetup", closer: cell(r, lo.closer),
        ...(buyer?.startsWith("@") ? { handle: buyer } : { buyer_name: buyer }), products, cost: moneyOf(cell(r, lo.cost)), total: moneyOf(cell(r, lo.total)),
        payment: cell(r, lo.payment), fulfillment: "pickup", notes: cell(r, lo.notes), items: itemsOf(products),
      });
    }
  });
  return out;
}

/** Preview lines per month: "Nov 2026: 12 sales, $1,450.00". */
export function previewByMonth(rows: ImportRow[]): string[] {
  const by = new Map<string, { n: number; total: number }>();
  for (const r of rows) {
    const tab = r.key.split("!")[0];
    const x = by.get(tab) ?? { n: 0, total: 0 };
    x.n++;
    x.total += Number(r.total ?? 0);
    by.set(tab, x);
  }
  return [...by].map(([tab, x]) => `${tab}: ${x.n} sale${x.n === 1 ? "" : "s"}, $${x.total.toFixed(2)}`);
}
