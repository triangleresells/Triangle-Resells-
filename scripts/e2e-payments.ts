/**
 * End-to-end payment run, no network: the real Bot, OrderDesk, StockKeeper and express server, with a fake
 * Instagram, a scripted "AI" that calls the real order tools, a fake Stripe API, and a fake stock sheet.
 * Stripe webhooks are signed exactly like Stripe signs them and posted to the real /stripe/webhook route.
 *
 *   npx tsx scripts/e2e-payments.ts
 */
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { OrderTools, ReplyEngine } from "../src/ai.js";
import { Bot } from "../src/bot.js";
import { loadPricing } from "../src/config.js";
import { OrderDesk, SalesLog, StockKeeper, type SheetIO } from "../src/desk.js";
import type { InstagramApi } from "../src/instagram.js";
import { handlePaidOrder, type CalendarEvent } from "../src/orders.js";
import { createServer } from "../src/server.js";
import { Store } from "../src/store.js";
import { StripeCheckout } from "../src/stripe.js";

const WHSEC = "whsec_e2e";
const OWN = "own";
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  (${detail})` : ""}`);
};

// ---- fake stock sheet (BOT STOCK) + sales tracker ----
const stock = [
  ["Category", "Brand", "Item", "Color", "Size", "Qty", "Price List", "Status", "Notes", "Cost"],
  ["Hoodie", "Alo", "Alo Hoodie", "Gray", "M", "1", "ALO", "FOR SALE", "", "25"],
  ["Hoodie", "Spider", "Spider Hoodie", "White/Black", "XS", "2", "SPIDER HOODIES", "FOR SALE", "", "28"],
];
const tracker: string[] = [];
const io: SheetIO = {
  tabs: async () => [stock],
  ranges: async () => [tracker.map((t) => [t])],
  write: async (data) => {
    for (const d of data) {
      const m = d.range.match(/^'BOT STOCK'!F(\d+)$/);
      if (m) stock[Number(m[1]) - 1][5] = String(d.values[0][0]);
      else if (/!(A|AD)\d+:/.test(d.range)) tracker.push(String(d.values[0][3]));
    }
  },
};
const qty = (item: string) => stock.find((r) => r[2] === item)![5];

// ---- fake Stripe API ----
const sessions = new Map<string, { status: "open" | "complete" | "expired"; metadata: Record<string, string>; amount: number }>();
let sid = 0;
const stripeFetch = (async (url: string, init?: RequestInit) => {
  const u = String(url);
  if (u.endsWith("/checkout/sessions") && init?.method === "POST") {
    const form = new URLSearchParams(String(init.body));
    const metadata: Record<string, string> = {};
    let amount = 0;
    for (const [k, v] of form) {
      const m = k.match(/^metadata\[(.+)\]$/);
      if (m) metadata[m[1]] = v;
    }
    for (let i = 0; form.has(`line_items[${i}][quantity]`); i++) amount += Number(form.get(`line_items[${i}][quantity]`)) * Number(form.get(`line_items[${i}][price_data][unit_amount]`));
    const id = `cs_test_${++sid}`;
    sessions.set(id, { status: "open", metadata, amount });
    return new Response(JSON.stringify({ id, url: `https://checkout.stripe.com/c/pay/${id}`, expires_at: 0 }), { status: 200 });
  }
  const id = decodeURIComponent(u.split("/checkout/sessions/")[1]?.replace("/expire", "") ?? "");
  const s = sessions.get(id);
  if (!s) return new Response("{}", { status: 404 });
  if (u.endsWith("/expire")) {
    if (s.status !== "open") return new Response(JSON.stringify({ error: { message: `status ${s.status}` } }), { status: 400 });
    s.status = "expired";
    return new Response(JSON.stringify({ id, status: "expired" }), { status: 200 });
  }
  return new Response(JSON.stringify({ id, status: s.status }), { status: 200 });
}) as unknown as typeof fetch;

// ---- scripted AI: each DM runs the next tool call for that buyer ----
type Step = (t: OrderTools) => Promise<unknown>;
const script = new Map<string, Step[]>();
const results = new Map<string, any[]>();
const agent: ReplyEngine = {
  reply: async (history, _inv, tools) => {
    const user = history.at(-1)!.text.split("|")[0];
    const step = script.get(user)?.shift();
    const r = step ? await step(tools!) : undefined;
    results.set(user, [...(results.get(user) ?? []), r]);
    return { text: "ok", checkoutUrl: (r as any)?.url };
  },
};

const sent: { to: string; text: string }[] = [];
const ig: InstagramApi = {
  sendText: async (to, text) => (sent.push({ to, text }), `mid-${sent.length}`),
  sendPrivateReply: async () => "m",
  replyToComment: async () => {},
  getUsername: async (id) => `buyer_${id}`,
};

async function main() {
  const store = new Store();
  const alerts: string[] = [];
  const calendar: CalendarEvent[] = [];
  const notify = async (a: { reason: string }) => void alerts.push(a.reason);
  const desk = new OrderDesk({ store, notify, accountName: "Triangle Resells", stock: new StockKeeper(io), sales: new SalesLog(io, "T"), calendar: async (e) => void calendar.push(e) });
  const pricing = loadPricing();
  const bot = new Bot({
    ig, agent, store, notify, getInventory: async () => "", accountName: "Triangle Resells", keywords: [], publicCommentReplies: [], humanPauseHours: 12,
    pricing, desk, checkout: new StripeCheckout("sk_test_e2e", "https://triangleresells.com", stripeFetch), now: () => new Date("2026-11-12T17:00:00Z"),
  });
  // Same wiring as src/index.ts onPaidOrder.
  const onPaidOrder = async (order: any) => {
    if (!store.firstTime(`stripe:${order.sessionId}`)) return;
    await bot.markPaid(order.igUserId, order.summary, order.total, [order.fulfillment, order.fulfillDate, order.fulfillTime].filter(Boolean).join(" "), order.fulfillment, {
      lines: order.lines, shipping: order.shipping, deliveryFee: order.deliveryFee, shipTo: order.shipAddress, test: order.test,
    });
    await handlePaidOrder(order, { sendDm: (id, t) => bot.sendDm(id, t), calendar: async (e) => void calendar.push(e), notify, warehouseAddress: "", accountName: "Triangle Resells" });
  };
  const server = createServer(bot, { appSecret: "x", verifyToken: "v", stripeWebhookSecret: WHSEC, onPaidOrder }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const dm = (user: string, n: number) =>
    bot.handle({ object: "instagram", entry: [{ id: OWN, messaging: [{ sender: { id: user }, recipient: { id: OWN }, message: { mid: `${user}-${n}`, text: `${user}|msg ${n}` } }] }] });
  const pay = async (id: string, extra: Record<string, unknown> = {}) => {
    const s = sessions.get(id)!;
    s.status = "complete";
    const event = { id: `evt_${id}`, type: "checkout.session.completed", created: Math.floor(Date.parse("2026-11-12T17:05:00Z") / 1000), data: { object: { id, payment_status: "paid", amount_total: s.amount, metadata: s.metadata, customer_details: { name: "Jay Smith", phone: "+15550001111" }, ...extra } } };
    const body = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", WHSEC).update(`${t}.${body}`).digest("hex");
    const res = await fetch(`${base}/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${sig}` }, body });
    await new Promise((r) => setTimeout(r, 50));
    return res.status;
  };
  const link = (o: unknown[], f: "pickup" | "ship" = "pickup"): Step => (t) => t.checkout!(o as any, f, "2026-11-13", f === "pickup" ? "3:00 PM" : undefined);
  const spider = (n: number) => [{ product: "Spider Hoodie", variant: "White/Black", size: "XS", qty: n }];
  const alo = [{ product: "Alo Hoodie", variant: "Gray", size: "M", qty: 1 }];

  console.log("\n1) Buyer changes the order: old link cancelled, new link paid");
  script.set("a", [link(spider(1)), link(spider(2))]);
  await dm("a", 1);
  await dm("a", 2);
  check("first link cancelled on Stripe", sessions.get("cs_test_1")?.status === "expired");
  check("second link made with the full new order", results.get("a")![1]?.ok === true && sessions.get("cs_test_2")?.status === "open");
  check("stock not touched before payment", qty("Spider Hoodie") === "2");
  check("webhook accepted (signed)", (await pay("cs_test_2")) === 200);
  check("sandbox payment leaves BOT STOCK alone", qty("Spider Hoodie") === "2");
  check("sandbox payment not in the sales tracker", tracker.length === 0);
  check("buyer got the paid DM", sent.some((s) => s.to === "a" && s.text.startsWith("paid ✅")));
  check("team alert marked [TEST]", alerts.some((a) => a.startsWith("[TEST] PAID")));

  console.log("\n2) Duplicate Stripe delivery is ignored");
  const dmsBefore = sent.filter((s) => s.to === "a").length;
  await pay("cs_test_2");
  check("no second paid DM", sent.filter((s) => s.to === "a").length === dmsBefore);

  console.log("\n3) Bad signature rejected");
  const bad = await fetch(`${base}/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=nope" }, body: "{}" });
  check("unsigned webhook gets 400", bad.status === 400);

  console.log("\n4) Last piece: second buyer can't get a link while the first link is open");
  script.set("b", [link(alo)]);
  script.set("c", [link(alo)]);
  await dm("b", 1);
  await dm("c", 1);
  check("buyer b got a link", results.get("b")![0]?.ok === true);
  check("buyer c told it's taken", results.get("c")![0]?.ok === false, JSON.stringify(results.get("c")![0]));

  console.log("\n5) Paying an old link that was already paid: no new link, handoff");
  script.set("b", [link(alo)]);
  sessions.get(`cs_test_${sid}`)!.status = "complete"; // b paid in another tab
  await dm("b", 2);
  check("no new link, handed to Josh", results.get("b")![1]?.ok === false && results.get("b")![1]?.handoff === true);

  console.log("\n6) Cash App order: stock stays until Mark paid; cancel before pay never touches the sheet");
  script.set("d", [(t) => t.submitOrder!(spider(1) as any, "pickup", "2026-11-13", "4:00 PM", undefined, "cash_app")]);
  await dm("d", 1);
  const booked = store.allLabels().find((l) => l.userId === "d")!;
  check("BOOKED label made", booked?.label === "BOOKED");
  check("stock untouched while BOOKED", qty("Spider Hoodie") === "2");
  await desk.cancel(booked.id);
  check("cancel before pay: sheet untouched", qty("Spider Hoodie") === "2");
  script.set("e", [(t) => t.submitOrder!(spider(1) as any, "pickup", "2026-11-13", "4:30 PM", undefined, "cash_app")]);
  await dm("e", 1);
  const e = store.allLabels().find((l) => l.userId === "e")!;
  await desk.markPaid(e.id);
  check("Mark paid takes it off", qty("Spider Hoodie") === "1");
  check("Mark paid logs one sale", tracker.length === 1);
  await desk.cancel(e.id);
  check("cancel after pay puts it back", qty("Spider Hoodie") === "2");

  console.log("\n7) Shipped card order: address read back + on the calendar");
  script.set("f", [link(spider(1), "ship")]);
  await dm("f", 1);
  await pay(`cs_test_${sid}`, { collected_information: { shipping_details: { name: "Jay Smith", address: { line1: "1 Main St", line2: "Apt 2", city: "Atlanta", state: "GA", postal_code: "30301" } } } });
  const conf = sent.filter((s) => s.to === "f").map((s) => s.text).join("\n");
  check("DM reads the address back", conf.includes("Jay Smith") && conf.includes("Atlanta, GA 30301"), conf.slice(0, 200));
  check("calendar has SHIP TO block", calendar.some((c) => c.description.includes("SHIP TO (for the label):\nJay Smith")));

  server.close();
  console.log(`\n${failures ? `${failures} FAILED` : "ALL PASSED"}`);
  process.exit(failures ? 1 : 0);
}
void main();
