/**
 * Josh's bulk tiers (Nov 17 2026), per piece, firm. Rewrites ONLY these 4 price lists' row blocks in BOT PRICES and
 * clears their leftover rows. Every other row is untouched. Run with --write to change the sheet (default: preview).
 *   npx tsx --env-file=.env scripts/update-bot-prices.ts [--write]
 */
import { loadConfig } from "../src/config.js";
import { GoogleSheetsReader, parseServiceAccount, PRICES_TAB } from "../src/sheet.js";

export const BULK_TIERS: Record<string, { tiers: [number, number][]; notes: Record<number, string> }> = {
  ESSENTIALS: { tiers: [[1, 60], [5, 50], [10, 42], [15, 37], [20, 33], [25, 30], [30, 27], [40, 25]], notes: { 1: "Firm. Bulk starts at 5 pieces. XS runs a size up.", 40: "40+ pieces" } },
  "SPIDER HOODIES": { tiers: [[1, 80], [5, 60], [10, 54], [15, 49], [20, 45], [30, 41]], notes: { 1: "Firm. Bulk starts at 5 pieces. 25 uses the 20 price.", 30: "31+: quote this price, the team confirms" } },
  "BAPE TEES": { tiers: [[1, 40], [5, 35], [10, 32], [15, 29], [20, 27], [30, 24]], notes: { 1: "Firm. Bulk starts at 5 pieces. 25 uses the 20 price.", 30: "31+: quote this price, the team confirms" } },
  "SUPREME HOODIES": { tiers: [[1, 100]], notes: { 1: "No bulk pricing on Supreme hoodies." } },
};

const env = { ...process.env } as NodeJS.ProcessEnv;
for (const k of ["IG_APP_SECRET", "IG_ACCESS_TOKEN", "IG_VERIFY_TOKEN"]) if (!env[k]?.trim()) env[k] = "x";
const c = loadConfig(env);
const sa = parseServiceAccount(c.googleServiceAccountJson);
if (!sa) throw new Error("no service account in .env");
const sheet = new GoogleSheetsReader(sa, c.warehouseSheetId);
const [rows] = await sheet.tabs([PRICES_TAB]);
const data: { range: string; values: (string | number)[][] }[] = [];
for (const [list, { tiers, notes }] of Object.entries(BULK_TIERS)) {
  const at = rows.map((r, i) => ((r[0] ?? "").trim().toUpperCase() === list ? i : -1)).filter((i) => i >= 0);
  if (!at.length) throw new Error(`${list} not found in ${PRICES_TAB}`);
  if (at[at.length - 1] - at[0] + 1 !== at.length) throw new Error(`${list} rows aren't one block: ${at.map((i) => i + 1).join(",")}`);
  if (tiers.length > at.length) throw new Error(`${list}: ${tiers.length} new rows don't fit in ${at.length}`);
  const values = at.map((_, k) => {
    const t = tiers[k];
    return t ? [list, t[0], t[0] * t[1], t[1], notes[t[0]] ?? ""] : ["", "", "", "", ""];
  });
  data.push({ range: `'${PRICES_TAB}'!A${at[0] + 1}:E${at[at.length - 1] + 1}`, values });
  console.log(`${list}: rows ${at[0] + 1}-${at[at.length - 1] + 1} -> ${tiers.map(([q, p]) => `${q}:$${p}`).join(" ")}`);
}
if (process.argv.includes("--write")) {
  await sheet.write(data);
  console.log("WRITTEN");
} else console.log("(preview only; add --write)");
