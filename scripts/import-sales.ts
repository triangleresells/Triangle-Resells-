/**
 * Old sales -> the CRM (so past months show up in revenue and the chart).
 * Reads every month tab of the sales tracker (except Oct 2026), shows a preview, and writes NOTHING unless --commit.
 *
 *   npm run import-sales              preview: what it would import, per month, plus anything it can't read
 *   npm run import-sales -- --commit  writes them (as Done; no stock touched; never imports the same row twice)
 *
 * Needs in .env: GOOGLE_SERVICE_ACCOUNT_JSON (shared on the tracker), TRACKER_SHEET_ID, CRM_API_URL, CRM_BOT_API_KEY.
 */
import { existsSync } from "node:fs";
import { crmClient } from "../src/crm.js";
import { GoogleSheetsReader, parseServiceAccount } from "../src/sheet.js";
import { monthTabs, parseTrackerTab, previewByMonth } from "../src/team/importsales.js";

async function main() {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const commit = process.argv.includes("--commit");
  const sa = parseServiceAccount(process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? "");
  const tracker = process.env.TRACKER_SHEET_ID ?? "";
  const crmUrl = process.env.CRM_API_URL ?? "";
  const crmKey = process.env.CRM_BOT_API_KEY ?? "";
  const missing = [!sa && "GOOGLE_SERVICE_ACCOUNT_JSON", !tracker && "TRACKER_SHEET_ID", !crmUrl && "CRM_API_URL", !crmKey && "CRM_BOT_API_KEY"].filter(Boolean);
  if (missing.length) {
    console.error(`Missing in .env: ${missing.join(", ")}. Nothing was read or written.`);
    process.exit(1);
  }
  const sheets = new GoogleSheetsReader(sa!, tracker);
  const tabs = monthTabs(await sheets.tabNames(tracker));
  console.log(`Month tabs (Oct 2026 skipped): ${tabs.join(", ") || "none"}`);
  const rows = [];
  for (const tab of tabs) {
    const [values] = await sheets.ranges([`'${tab}'!A1:AN1000`], tracker);
    rows.push(...parseTrackerTab(tab, values));
  }
  console.log(`\nFound ${rows.length} sale row(s):`);
  for (const line of previewByMonth(rows)) console.log(`  ${line}`);
  const unreadable = rows.filter((r) => !r.date || !r.total);
  if (unreadable.length) {
    console.log(`\n${unreadable.length} row(s) can't be imported (no readable date or total):`);
    for (const r of unreadable.slice(0, 30)) console.log(`  ${r.key}: date "${r.date || "?"}", total "${r.total ?? "?"}", ${r.products ?? ""}`);
  }
  console.log("\nFirst rows, as they'll be saved:");
  for (const r of rows.filter((x) => x.date && x.total).slice(0, 8)) {
    console.log(`  ${r.key}  ${r.date}  ${r.handle ?? r.buyer_name ?? "-"}  ${r.products ?? "-"}  $${r.total}  cost ${r.cost ?? "?"}  ${r.payment ?? "-"}  ${r.fulfillment}`);
  }
  const crm = crmClient(crmUrl, crmKey);
  const result = await crm.importSales(rows, commit);
  console.log(`\nCRM ${commit ? "import" : "preview"}:`, JSON.stringify(result, null, 1));
  if (!commit) console.log("\nNothing was written. If this looks right: npm run import-sales -- --commit");
}

main().catch((err) => {
  console.error("Import failed:", (err as Error).message ?? err);
  process.exit(1);
});
