/**
 * Refreshes the saved snapshot (config/stock.csv + the tables in config/pricing.json) from the warehouse sheet's
 * BOT STOCK and BOT PRICES tabs, using the same Google service account as the bot. The live bot reads the sheet
 * itself every 2 minutes; the snapshot is only the fallback (and what the tests and retests use).
 *
 *   GOOGLE_SERVICE_ACCOUNT_JSON="$(cat key.json)" npm run sync-sheet
 *   (or GOOGLE_SERVICE_ACCOUNT_FILE=path/to/key.json npm run sync-sheet; keep that file OUT of the repo)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parsePricesCsv, parseStockCsv } from "../src/catalog.js";
import { DEFAULT_SHEET_ID } from "../src/config.js";
import { GoogleSheetsReader, parseServiceAccount, PRICES_TAB, STOCK_TAB } from "../src/sheet.js";

const csvCell = (c: string) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);

async function main() {
  // Keys come from .env in the repo root (gitignored). Env vars already set win over the file.
  if (existsSync(".env")) process.loadEnvFile(".env");
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? (process.env.GOOGLE_SERVICE_ACCOUNT_FILE ? readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_FILE, "utf8") : "");
  const sa = parseServiceAccount(raw);
  if (!sa) throw new Error("Set GOOGLE_SERVICE_ACCOUNT_JSON (the key file contents) or GOOGLE_SERVICE_ACCOUNT_FILE.");
  const reader = new GoogleSheetsReader(sa, process.env.WAREHOUSE_SHEET_ID || DEFAULT_SHEET_ID);
  const [stock, prices] = await reader.tabs([STOCK_TAB, PRICES_TAB]);

  const header = stock.findIndex((r) => r.includes("Item") && r.includes("Status"));
  if (header < 0) throw new Error(`No header row (Item, Status) on the ${STOCK_TAB} tab`);
  const rows = stock.slice(header).filter((r) => r.some((c) => String(c).trim()));
  const width = rows[0].length;
  writeFileSync(new URL("../config/stock.csv", import.meta.url), rows.map((r) => Array.from({ length: width }, (_, i) => csvCell(String(r[i] ?? "").trim())).join(",")).join("\n") + "\n");

  const tables = parsePricesCsv(prices);
  if (!Object.keys(tables).length) throw new Error(`No prices found on the ${PRICES_TAB} tab`);
  const file = new URL("../config/pricing.json", import.meta.url);
  const pricing = JSON.parse(readFileSync(file, "utf8"));
  pricing.tables = tables;
  writeFileSync(file, JSON.stringify(pricing, null, 2) + "\n");

  const parsed = parseStockCsv(rows);
  const missing = [...new Set(parsed.filter((r) => r.status === "for_sale" && r.priceList && !tables[r.priceList]).map((r) => r.priceList))];
  console.log(`Saved ${parsed.length} stock rows and ${Object.keys(tables).length} price lists.`);
  if (missing.length) console.log(`Heads up: these price lists are used on ${STOCK_TAB} but missing from ${PRICES_TAB} (the bot hands those to Josh): ${missing.join(", ")}`);
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
