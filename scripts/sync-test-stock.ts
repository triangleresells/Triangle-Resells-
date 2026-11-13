/**
 * One sync of the BOT STOCK TEST tab (only) into the CRM's TEST stock, for the end-to-end tests. Never touches the real
 * BOT STOCK tab or real stock. Writes counts back to BOT STOCK TEST only.
 *
 *   npx tsx scripts/sync-test-stock.ts
 *
 * Needs in .env: GOOGLE_SERVICE_ACCOUNT_JSON, CRM_API_URL, CRM_BOT_API_KEY (WAREHOUSE_SHEET_ID optional).
 */
import { existsSync } from "node:fs";
import { crmClient } from "../src/crm.js";
import { StockKeeper } from "../src/desk.js";
import { DEFAULT_SHEET_ID } from "../src/config.js";
import { GoogleSheetsReader, parseServiceAccount } from "../src/sheet.js";
import { crmRowsOf, TEST_STOCK_TAB } from "../src/stocksync.js";

async function main() {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const sa = parseServiceAccount(process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? "");
  const url = process.env.CRM_API_URL?.trim();
  const key = process.env.CRM_BOT_API_KEY?.trim();
  if (!sa || !url || !key) {
    console.error("Missing in .env: GOOGLE_SERVICE_ACCOUNT_JSON, CRM_API_URL or CRM_BOT_API_KEY. Nothing was changed.");
    process.exit(1);
  }
  const sheets = new GoogleSheetsReader(sa, process.env.WAREHOUSE_SHEET_ID || DEFAULT_SHEET_ID);
  const [table] = await sheets.tabs([TEST_STOCK_TAB]);
  const rows = crmRowsOf(table);
  if (!rows.length) throw new Error(`${TEST_STOCK_TAB} is empty`);
  const res = await crmClient(url, key).syncStock(rows, true);
  const problems = res.writes.length || res.add_rows?.length ? await new StockKeeper(sheets).setQty(res.writes, TEST_STOCK_TAB, res.add_rows ?? []) : [];
  console.log(`${TEST_STOCK_TAB}: ${rows.length} rows sent to the CRM's TEST stock; ${res.writes.length} count(s) written back to ${TEST_STOCK_TAB}.`);
  for (const p of problems) console.log(`  ${p}`);
}

main().catch((err) => {
  console.error("Test stock sync failed:", (err as Error).message ?? err);
  process.exit(1);
});
