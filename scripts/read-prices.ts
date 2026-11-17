/** Read-only: dumps the live BOT PRICES tab to a JSON file and prints where the restock price lists sit.
 *  npx tsx --env-file=.env scripts/read-prices.ts <out.json> */
import { writeFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { GoogleSheetsReader, parseServiceAccount, PRICES_TAB } from "../src/sheet.js";
const env = { ...process.env } as NodeJS.ProcessEnv;
for (const k of ["IG_APP_SECRET", "IG_ACCESS_TOKEN", "IG_VERIFY_TOKEN"]) if (!env[k]?.trim()) env[k] = "x";
const c = loadConfig(env);
const sa = parseServiceAccount(c.googleServiceAccountJson);
if (!sa) throw new Error("no service account in .env");
const [rows] = await new GoogleSheetsReader(sa, c.warehouseSheetId).tabs([PRICES_TAB]);
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(rows));
rows.forEach((r, i) => { if (/ESSENTIALS|SPIDER|BAPE|SUPREME/i.test(r[0] ?? "")) console.log(i + 1, JSON.stringify(r)); });
console.log("rows:", rows.length, "widest:", Math.max(...rows.map((r) => r.length)));
