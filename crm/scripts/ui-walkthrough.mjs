// Walks a real (headless) browser through every screen of the live CRM, in TEST MODE, with a screenshot per step.
// Everything it adds is TEST and is deleted at the end. Run from crm/:  node scripts/ui-walkthrough.mjs <screenshot dir>
// Needs in ../.env: CRM_API_URL, CRM_BOT_API_KEY, E2E_EMAIL, E2E_PASSWORD (a team login).
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

process.loadEnvFile("../.env");
const SITE = process.env.CRM_API_URL.replace(/\/+$/, "");
const KEY = process.env.CRM_BOT_API_KEY;
const out = process.argv[2] ?? "ui-shots";
mkdirSync(out, { recursive: true });
const api = async (method, p, body) =>
  (await fetch(`${SITE}/api${p}`, { method, headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: body && JSON.stringify(body) })).json();

const steps = [];
const problems = [];
let n = 0;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text().slice(0, 200)}`));
page.on("pageerror", (e) => problems.push(`page error: ${e.message.slice(0, 200)}`));
page.on("dialog", (d) => d.accept());
const shot = async (name, note) => {
  const file = path.join(out, `${String(++n).padStart(2, "0")}-${name}.png`);
  await page.waitForTimeout(700);
  await page.screenshot({ path: file, fullPage: false });
  steps.push({ n, name, note, file });
};
const banner = async () => ((await page.locator("#banner:not([hidden])").textContent({ timeout: 1500 }).catch(() => "")) || "").trim();

try {
  // A TEST item with stock, to sell in test mode.
  const stock = (await api("GET", "/stock?is_test=true")).stock.filter((s) => s.status === "for_sale" && s.qty >= 2);
  if (!stock.length) throw new Error("no TEST stock: run scripts/sync-test-stock.ts first");
  const item = stock[0];
  const stamp = Date.now().toString(36);

  await page.goto(SITE);
  await page.waitForSelector("#em", { timeout: 20000 });
  await shot("login", "The login screen.");

  await page.fill("#em", "nobody@example.com");
  await page.fill("#pw", "wrong-password");
  await page.click("button:has-text('Log in')");
  await page.waitForTimeout(2500);
  await shot("wrong-password", `A wrong login is refused: "${(await page.locator(".login .muted").textContent().catch(() => "")) || "?"}"`);

  await page.fill("#em", process.env.E2E_EMAIL);
  await page.fill("#pw", process.env.E2E_PASSWORD);
  await page.click("button:has-text('Log in')");
  await page.waitForSelector("[data-tab=calendar]", { timeout: 20000 });
  await shot("calendar", `Logged in as ${(await page.locator("#who span").textContent()).trim()}: the calendar and today's list.`);

  await page.check("#tst");
  await page.waitForTimeout(1500);
  await shot("test-mode", "Test mode on: the yellow banner says anything added is TEST.");

  await page.click("#add");
  await page.fill("#f_ig", `@TEST_ui_${stamp}`);
  await page.fill("#f_name", "TEST Walkthrough Buyer");
  const row = page.locator("[data-row]").first();
  await row.locator("[name=brand]").fill(item.brand ?? "");
  await row.locator("[name=item]").fill(item.item);
  await row.locator("[name=color]").fill(item.color ?? "");
  await row.locator("[name=size]").fill(item.size ?? "One Size");
  await row.locator("[name=qty]").fill("1");
  await row.locator("[name=unit_price]").fill("50");
  await page.fill("#f_time", "15:00");
  await shot("add-sale-form", `The New sale form, filled in: 1x ${item.item} ${item.color ?? ""} ${item.size ?? ""}, $50, cash pickup.`);
  await page.click("#bf button.gold");
  await page.waitForTimeout(2500);
  await shot("sale-added", `Saved: ${await banner() || "(no message)"}. The booking card with its status buttons.`);

  const card = page.locator("article.card").filter({ hasText: `test_ui_${stamp}` }).first();
  await card.locator("[data-st=paid]").click();
  await page.waitForTimeout(2000);
  await shot("marked-paid", "Tapped Paid.");
  await card.locator("[data-st=done]").click();
  await page.waitForTimeout(2000);
  await shot("marked-done", "Tapped Done: it now counts as revenue.");
  await card.locator("[data-hist]").click();
  await page.waitForTimeout(2000);
  await shot("history", "History: every change, who made it, and an Undo button.");

  await page.click("[data-tab=money]");
  await page.waitForTimeout(2500);
  await shot("money", "Money: this month's revenue and profit (TEST data shown in test mode).");
  await page.click("#mChart");
  await page.waitForTimeout(2500);
  await shot("money-chart", "Tapped the number: the chart of every month, and the list of Done sales.");

  await page.click("[data-tab=stock]");
  await page.waitForTimeout(2500);
  await shot("stock", "Stock: came in / sold / reserved / free to sell (TEST stock in test mode).");

  await page.click("[data-tab=videos]");
  await page.waitForTimeout(2000);
  await page.fill("#vHook", `TEST hook ${stamp}: how I flipped $200 into $2,000`);
  await page.click("#vAdd button");
  await page.waitForTimeout(2000);
  await page.locator("[data-vstatus]").first().click();
  await page.waitForTimeout(2000);
  await shot("videos", "Videos: added a TEST idea and tapped its status to Filmed.");

  await page.click("[data-tab=customers]");
  await page.waitForTimeout(2500);
  await shot("customers", "Customers: sortable list with orders and total spent.");

  await page.click("[data-tab=cash]");
  await page.waitForTimeout(2500);
  await shot("cash", "Cash: what each person collected today.");

  await page.click("[data-tab=assistant]");
  await page.waitForTimeout(1500);
  await shot("assistant", "Assistant: the chat (it answers once the bot on Render has the new version).");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.click("[data-tab=calendar]");
  await page.waitForTimeout(2000);
  await shot("phone-calendar", "The same CRM on a phone-size screen.");
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.click("#out");
  await page.waitForSelector("#em", { timeout: 15000 });
  await shot("logged-out", "Logged out: back to the login screen.");
} catch (err) {
  problems.push(`walkthrough stopped: ${err.message}`);
  await shot("stopped-here", "Where it stopped.").catch(() => {});
} finally {
  await browser.close();
  const cleanup = await api("POST", "/test-data/delete").catch((e) => ({ error: e.message }));
  console.log(JSON.stringify({ steps, problems, cleanup }, null, 1));
}
