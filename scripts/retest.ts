/**
 * 1,000 simulated conversations through the REAL bot code: prices, delivery fees, pickup/delivery
 * times, farthest-first routes, the 7pm ship cutoff, Stripe link contents, follow-ups, paid webhook,
 * and the calendar event. A "perfect AI" calls the tools the way config/agent-instructions.md says,
 * and an independent checker (Josh's rules written out by hand below, not the bot's code) grades
 * every result. No network, no API keys, no real Stripe.
 *
 *   npx tsx scripts/retest.ts            (summary)
 *   npx tsx scripts/retest.ts --json out.json   (every scenario + result)
 *
 * What this can't test: the AI's own wording and judgment (tone, arguments, handoffs, reading
 * screenshots, stock from the sheet). scripts/ai-retest.ts does that once ANTHROPIC_API_KEY is set.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { OrderTools, ReplyEngine } from "../src/ai.js";
import { Bot } from "../src/bot.js";
import type { InstagramApi } from "../src/instagram.js";
import { calendarEventFor, confirmationText } from "../src/orders.js";
import type { Fulfillment, OrderItem, PricingConfig, Quote } from "../src/pricing.js";
import { addDays, etParts, etToDate, parseTime, type BusyBlock } from "../src/schedule.js";
import { Store } from "../src/store.js";
import { checkoutParams, paidOrderFromEvent, type CheckoutApi, type OrderDetails } from "../src/stripe.js";

const pricing = JSON.parse(readFileSync(new URL("../config/pricing.json", import.meta.url), "utf8")) as PricingConfig;

// ---------- Josh's rules, written out independently ----------
const STOCK: { product: string; variant: string; size: string; qty: number }[] = [
  ["spider_hoodie", "OG Web Black", "XS", 5], ["spider_hoodie", "OG Web Black", "S", 5], ["spider_hoodie", "OG Web Black", "M", 5],
  ["spider_hoodie", "Pink/Black", "S", 5], ["spider_hoodie", "Pink/Black", "M", 5],
  ["essentials_hoodie", "Black", "XS", 5], ["essentials_hoodie", "Black", "L", 5],
  ["essentials_sweatpants", "Black Uncuffed", "S", 2], ["essentials_sweatpants", "Black Uncuffed", "M", 3],
  ["alo_hoodie", "Black", "XS", 5], ["alo_hoodie", "Gray", "S", 3], ["alo_hoodie", "Gray", "M", 3], ["alo_hoodie", "Gray", "L", 3],
  ["alo_pants", "Black Uncuffed", "XL", 3], ["alo_pants", "Light Gray Uncuffed", "L", 3],
  ["bape_tee", "ABC Camo Green", "S", 4], ["bape_tee", "ABC Camo Green", "M", 4], ["bape_tee", "Joshua Vides", "M", 3],
  ["bape_tee", "Joshua Vides", "L", 3], ["bape_tee", "Big Blue Ape Head White", "M", 4], ["bape_tee", "Big Blue Ape Head White", "L", 4],
  ["jeans", "Blue", "32", 6], ["valley_hoodie", "Black", "M", 6], ["hat", "Black", "", 10], ["cologne", "Bleu de Chanel", "", 8],
  ["cologne", "Baccarat Rouge 540", "", 4], ["cologne", "Valentino Born in Roma", "", 4], ["lv_cologne", "Imagination", "", 3],
].map(([product, variant, size, qty]) => ({ product, variant, size, qty }) as { product: string; variant: string; size: string; qty: number });

const TIERS: Record<string, [number, number][]> = {
  heavy_hoodies: [[1, 55], [2, 52], [3, 50], [4, 49], [5, 48], [6, 47], [7, 46], [8, 45], [9, 44], [10, 43], [15, 42], [20, 41], [50, 40], [100, 38], [200, 36]],
  essentials: [[1, 50], [2, 45], [3, 44], [4, 42], [5, 41], [6, 40], [7, 38], [8, 35], [9, 34], [10, 33], [15, 31], [20, 30], [50, 28], [100, 26], [200, 25]],
  tees: [[1, 35], [2, 32], [3, 31], [4, 30], [5, 29], [6, 28], [7, 27], [8, 26], [9, 25], [10, 24], [15, 23], [20, 23], [50, 22], [100, 22], [200, 20]],
  colognes: [[1, 60], [2, 52], [3, 50], [4, 48], [5, 45], [6, 39], [7, 38], [8, 37], [9, 36], [10, 35], [20, 33], [50, 31], [100, 28], [200, 24]],
  lv_colognes: [[1, 65], [2, 62], [3, 60], [4, 58], [5, 55], [6, 49], [7, 48], [8, 47], [9, 46], [10, 45], [20, 43], [50, 41], [100, 39], [200, 36]],
};
const TABLE_OF: Record<string, string> = {
  alo_hoodie: "heavy_hoodies", alo_pants: "heavy_hoodies", spider_hoodie: "heavy_hoodies", hellstar_hoodie: "heavy_hoodies",
  essentials_hoodie: "essentials", essentials_sweatpants: "essentials", bape_tee: "tees", chrome_tee: "tees", amiri_tee: "tees",
  hellstar_tee: "tees", cologne: "colognes", lv_cologne: "lv_colognes",
};
const FLAT: Record<string, number> = { golf_iron_set: 400, jordan_12_flu_game: 50, jeans: 70, valley_hoodie: 60, hat: 30 };

function rulePrice(product: string, piecesOfThatProduct: number): number | undefined {
  if (FLAT[product] !== undefined) return FLAT[product];
  const t = TIERS[TABLE_OF[product]];
  if (!t) return undefined;
  let p = t[0][1];
  for (const [q, price] of t) if (piecesOfThatProduct >= q) p = price; // last tier reached
  return p;
}
function ruleDeliveryFee(minutes: number): number | undefined {
  if (minutes <= 20) return 5;
  if (minutes <= 30) return 10;
  if (minutes <= 45) return 15;
  if (minutes <= 60) return 20;
  return undefined; // over an hour: no delivery
}
const OPEN = 10 * 60, LAST = 21 * 60 + 30;

// ---------- random scenario generator ----------
let seed = 20261105;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

const KINDS = [
  "instant_sale", "normal_flow", "two_day_buyer", "ghost_then_back", "ghost_then_no", "haggler_argument", "taken_time",
  "outside_hours", "delivery_route", "too_far_meet_halfway", "unknown_town", "ship_after_7pm", "bulk_10plus_ship",
  "upsell_tier", "mixed_products", "out_of_stock_item", "unpriced_item", "cash_delivery", "deposit_request", "closed_day",
] as const;
type Kind = (typeof KINDS)[number];

interface Scenario {
  id: number;
  kind: Kind;
  clock: string; // ISO
  items: OrderItem[];
  fulfillment: Fulfillment;
  area?: string;
  date: string;
  time?: string;
  busy: BusyBlock[];
  /** Customer goes quiet after the link. */
  ghost?: "back" | "no";
  /** Days between first message and ordering (two-day buyer). */
  gapDays?: number;
}

const TOWNS_NEAR = ["Raleigh", "Garner", "Knightdale", "Cary", "Wake Forest", "Clayton", "Durham", "Apex", "Chapel Hill", "Smithfield", "Rocky Mount", "Goldsboro", "Burlington", "Holly Springs", "Wendell"];
const TOWNS_FAR = ["Greensboro", "Winston-Salem", "High Point", "Fayetteville", "Wilmington", "Charlotte", "Greenville"];
const TOWNS_UNKNOWN = ["Bunn", "Kenly", "Middlesex", "Spring Hope", "Coats"];

function stockPiece(): OrderItem {
  const s = pick(STOCK.filter((x) => !["cologne", "lv_cologne", "hat"].includes(x.product) || rnd() < 0.5));
  return { product: s.product, variant: s.variant, size: s.size || undefined, qty: 1 };
}
function order(maxPieces: number): OrderItem[] {
  const out: OrderItem[] = [];
  const lines = int(1, 3);
  for (let i = 0; i < lines; i++) {
    const it = stockPiece();
    const have = STOCK.find((s) => s.product === it.product && s.variant === it.variant && (s.size || undefined) === it.size)!.qty;
    const already = out.find((o) => o.product === it.product && o.variant === it.variant && o.size === it.size);
    const room = have - (already?.qty ?? 0);
    if (room <= 0) continue;
    const q = Math.min(room, int(1, Math.max(1, Math.floor(maxPieces / lines))));
    if (already) already.qty += q;
    else out.push({ ...it, qty: q });
  }
  return out.length ? out : [{ product: "alo_hoodie", variant: "Gray", size: "M", qty: 1 }];
}
function randomClock(): Date {
  const day = addDays("2026-11-05", int(0, 6));
  return etToDate(day, int(8 * 60, 23 * 60));
}
function busyFor(clock: Date): BusyBlock[] {
  const b: BusyBlock[] = [];
  const today = etParts(clock).date;
  for (let d = 0; d < 4; d++) {
    const date = addDays(today, d);
    for (let k = int(0, 5); k > 0; k--) {
      const start = int(20, 43) * 30; // 10:00 AM .. 9:30 PM
      const s = etToDate(date, start), e = etToDate(date, start + 30);
      const delivery = rnd() < 0.4 ? pick([15, 20, 25, 30, 35, 45, 55]) : undefined;
      b.push({ start: s.toISOString(), end: e.toISOString(), ...(delivery ? { title: `🚗 DELIVERY ${delivery}min Town: x – $1` } : {}) });
    }
  }
  return b;
}
function hhmm(min: number) {
  const h = Math.floor(min / 60), m = min % 60;
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

function makeScenario(id: number): Scenario {
  const kind = KINDS[id % KINDS.length];
  const clock = randomClock();
  const today = etParts(clock).date;
  const busy = busyFor(clock);
  const s: Scenario = {
    id, kind, clock: clock.toISOString(), items: order(6), fulfillment: pick(["pickup", "pickup", "ship", "delivery"]),
    date: addDays(today, int(0, 2)), busy,
  };
  if (s.fulfillment === "delivery") s.area = pick(TOWNS_NEAR);
  if (s.fulfillment !== "ship") s.time = hhmm(int(20, 43) * 30);
  switch (kind) {
    case "instant_sale": s.date = addDays(today, 1); break;
    case "two_day_buyer": s.gapDays = int(1, 2); break; // they come back 1-2 days later with the old date
    case "ghost_then_back": s.ghost = "back"; break;
    case "ghost_then_no": s.ghost = "no"; break;
    case "taken_time": {
      s.fulfillment = "pickup"; s.date = addDays(today, 1);
      const day = busy.find((b) => etParts(new Date(b.start)).date === s.date);
      const start = day ? etParts(new Date(day.start)).minutes : 15 * 60;
      if (!day) busy.push({ start: etToDate(s.date, start).toISOString(), end: etToDate(s.date, start + 30).toISOString() });
      s.time = hhmm(start); break;
    }
    case "outside_hours": s.fulfillment = pick(["pickup", "delivery"]); s.area = s.fulfillment === "delivery" ? pick(TOWNS_NEAR) : undefined; s.date = addDays(today, 1); s.time = pick(["9:00 AM", "8:30 AM", "10:00 PM", "10:30 PM", "11:00 PM"]); break;
    case "delivery_route": s.fulfillment = "delivery"; s.area = pick(TOWNS_NEAR); s.date = addDays(today, 1); break;
    case "too_far_meet_halfway": s.fulfillment = "delivery"; s.area = pick(TOWNS_FAR); s.items = order(rnd() < 0.5 ? 6 : 40); s.date = addDays(today, 1); break;
    case "unknown_town": s.fulfillment = "delivery"; s.area = pick(TOWNS_UNKNOWN); s.date = addDays(today, 1); break;
    case "ship_after_7pm": s.fulfillment = "ship"; s.clock = etToDate(today, int(19 * 60, 23 * 60 + 30)).toISOString(); s.date = today; s.time = undefined; break;
    case "bulk_10plus_ship": s.fulfillment = "ship"; s.time = undefined; s.items = [{ product: "spider_hoodie", variant: "OG Web Black", size: "S", qty: 5 }, { product: "spider_hoodie", variant: "Pink/Black", size: "M", qty: int(5, 5) }, ...(rnd() < 0.5 ? [{ product: "alo_hoodie", variant: "Black", size: "XS", qty: int(1, 5) }] : [])]; break;
    case "upsell_tier": s.items = [{ product: pick(["alo_hoodie", "spider_hoodie"]) === "alo_hoodie" ? "alo_hoodie" : "spider_hoodie", variant: "Pink/Black", size: "S", qty: pick([2, 4, 9]) }].map((i) => (i.product === "alo_hoodie" ? { ...i, variant: "Black", size: "XS", qty: Math.min(i.qty, 5) } : { ...i, qty: Math.min(i.qty, 5) })); break;
    case "mixed_products": s.items = order(9); break;
    case "closed_day": s.fulfillment = "pickup"; s.date = addDays(today, 1); s.time = "3:00 PM"; busy.push({ start: etToDate(s.date, 0).toISOString(), end: etToDate(addDays(s.date, 1), 0).toISOString(), allDay: true, title: "CLOSED - family" }); break;
    default: break; // haggler, out-of-stock, unpriced, cash, deposit: the order itself is normal; the twist is AI-only
  }
  if (s.fulfillment === "ship") s.time = undefined;
  return s;
}

// ---------- independent expectations ----------
interface Expect {
  total: number;
  shipping: number;
  label: boolean;
  deliveryFee: number;
  /** The first try should be refused (taken / out of hours / closed / route / too far / unknown town). */
  firstRefused: boolean;
  why?: string;
  shipDate?: string;
}

function overlaps(date: string, startMin: number, busy: BusyBlock[]) {
  const s = etToDate(date, startMin).getTime(), e = s + 30 * 60_000;
  return busy.some((b) => !b.allDay && new Date(b.start).getTime() < e && new Date(b.end).getTime() > s);
}
function closed(date: string, busy: BusyBlock[]) {
  const s = etToDate(date, 12 * 60).getTime();
  return busy.some((b) => b.allDay && /closed/i.test(b.title ?? "") && new Date(b.start).getTime() <= s && new Date(b.end).getTime() > s);
}
function routeOk(date: string, startMin: number, minutes: number, busy: BusyBlock[]) {
  for (const b of busy) {
    const m = (b.title ?? "").match(/DELIVERY (\d+)min/);
    if (!m || etParts(new Date(b.start)).date !== date) continue;
    const other = Number(m[1]), t = etParts(new Date(b.start)).minutes;
    if (other > minutes && startMin < t) return false;
    if (other < minutes && startMin > t) return false;
  }
  return true;
}
function slotOk(date: string, time: string | undefined, f: Fulfillment, minutes: number, busy: BusyBlock[], now: Date): string | undefined {
  const t = parseTime(time);
  if (t === undefined) return "no time";
  if (t < OPEN || t > LAST) return "outside 10-10";
  const n = etParts(now);
  if (date < n.date || (date === n.date && t < n.minutes)) return "passed";
  if (closed(date, busy)) return "closed";
  if (overlaps(date, t, busy)) return "taken";
  if (f === "delivery" && !routeOk(date, t, minutes, busy)) return "route";
  return undefined;
}

function expectFor(s: Scenario, items: OrderItem[], f: Fulfillment, area: string | undefined, date: string, time: string | undefined, now: Date): Expect {
  const pieces = new Map<string, number>();
  for (const i of items) pieces.set(i.product, (pieces.get(i.product) ?? 0) + i.qty);
  let subtotal = 0;
  for (const i of items) subtotal += rulePrice(i.product, pieces.get(i.product)!)! * i.qty;
  const count = items.reduce((a, i) => a + i.qty, 0);
  const label = f === "ship" && count >= 10;
  const shipping = f === "ship" && !label ? 10 : 0;
  let deliveryFee = 0, why: string | undefined;
  let minutes = 0;
  if (f === "delivery") {
    const m = pricing.delivery!.areas[area ?? ""];
    if (m === undefined) why = "unknown town";
    else if (ruleDeliveryFee(m) === undefined) why = "too far";
    else { minutes = m; deliveryFee = ruleDeliveryFee(m)!; }
  }
  if (!why && f !== "ship") why = slotOk(date, time, f, minutes, s.busy, now);
  let shipDate: string | undefined;
  if (f === "ship") {
    const n = etParts(now);
    const earliest = n.minutes < 19 * 60 ? n.date : addDays(n.date, 1);
    shipDate = date < earliest ? earliest : date;
  }
  return { total: subtotal + shipping + deliveryFee, shipping, label, deliveryFee, firstRefused: !!why, why, shipDate };
}

/** What a good bot does after a refusal: the next open slot (same day first), meet halfway in Durham, or ask the town. */
function fix(s: Scenario, f: Fulfillment, area: string | undefined, date: string, now: Date) {
  if (f === "delivery") {
    const m = pricing.delivery!.areas[area ?? ""];
    if (m === undefined) area = "Raleigh"; // "what's the closest bigger town?" -> Raleigh
    else if (m > 60) area = "Durham"; // meet halfway
  }
  const minutes = f === "delivery" ? pricing.delivery!.areas[area!] : 0;
  for (let d = 0; d < 5; d++) {
    const day = addDays(date < etParts(now).date ? etParts(now).date : date, d);
    for (let t = OPEN; t <= LAST; t += 30) if (!slotOk(day, hhmm(t), f, minutes, s.busy, now)) return { area, date: day, time: hhmm(t) };
  }
  return { area, date, time: undefined };
}

// ---------- run one scenario through the real bot ----------
interface Result { id: number; kind: Kind; ok: boolean; problems: string[]; transcript: string[] }

async function run(s: Scenario): Promise<Result> {
  const problems: string[] = [];
  const transcript: string[] = [];
  let now = new Date(s.clock);
  const created: { quote: Quote; order: OrderDetails; params: any }[] = [];
  const sent: string[] = [];
  const ig: InstagramApi = {
    sendText: async (_to, text) => { sent.push(text); transcript.push(`BOT: ${text}`); return `mid${sent.length}`; },
    sendPrivateReply: async () => "m", replyToComment: async () => {}, getUsername: async () => "buyer",
  };
  const checkout: CheckoutApi = {
    create: async (quote, order) => {
      const params = checkoutParams(quote, order, "https://triangleresells.com", now.getTime()) as any;
      created.push({ quote, order, params });
      return { id: `cs_${s.id}_${created.length}`, url: `https://checkout.stripe.com/test/${s.id}/${created.length}`, expiresAt: 0 };
    },
  };

  // The "perfect AI": quote, then try the link, then fix what the tool says and try again (like the instructions say).
  let plan = { items: s.items, f: s.fulfillment, area: s.area, date: s.date, time: s.time };
  let attempt: { first?: Awaited<ReturnType<OrderTools["checkout"]>>; final?: Awaited<ReturnType<OrderTools["checkout"]>>; quoteText?: string } = {};
  let wantsLink = true;
  const agent: ReplyEngine = {
    reply: async (_h, _inv, tools, schedule) => {
      if (!schedule?.includes("10:00 AM to 10:00 PM")) problems.push("AI wasn't given the pickup hours");
      if (!wantsLink) return { text: "No problem at all, I'm here if you change your mind.", cancelFollowUp: true };
      attempt.quoteText = tools!.quote(plan.items, plan.f, plan.area);
      let r = await tools!.checkout(plan.items, plan.f, plan.date, plan.time, plan.area);
      attempt.first ??= r;
      if (!r.ok && r.fixable) {
        const fx = fix(s, plan.f, plan.area, plan.date, now);
        plan = { ...plan, ...fx };
        r = await tools!.checkout(plan.items, plan.f, plan.date, plan.time, plan.area);
      }
      attempt.final = r;
      return r.ok ? { text: "All sales final. Here's your link, I'm holding it for you.", checkoutUrl: r.url } : { text: "Let me get Josh on this.", handoff: { route: "josh", reason: "link failed", summary: r.error } };
    },
  };
  const store = new Store(() => now.getTime());
  const bot = new Bot({ ig, agent, store, notify: async () => {}, getInventory: async () => "stock sheet", accountName: "Triangle Resells", keywords: [], publicCommentReplies: [], humanPauseHours: 12, pricing, checkout, getBusy: async () => s.busy, now: () => now });
  let mid = 0;
  const say = async (text: string) => {
    transcript.push(`CUSTOMER: ${text}`);
    await bot.handle({ object: "instagram", entry: [{ id: "own", messaging: [{ sender: { id: `u${s.id}` }, recipient: { id: "own" }, message: { mid: `${s.id}-${++mid}`, text } }] }] });
  };

  if (s.gapDays) {
    // Day 1: just asking. Day 2-3: comes back, the date they first said has passed.
    transcript.push("CUSTOMER: how much for these? (asks, then goes quiet)");
    now = new Date(now.getTime() + s.gapDays * 86_400_000);
    if (plan.date < etParts(now).date) {
      // Good bot re-dates to an open time (the code refuses old dates, so check that too).
    }
  }

  const expFirst = expectFor(s, plan.items, plan.f, plan.area, plan.date, plan.time, now);
  await say(`order: ${plan.items.map((i) => `${i.qty} ${i.product} ${i.variant ?? ""} ${i.size ?? ""}`).join(", ")} ${plan.f} ${plan.area ?? ""} ${plan.date} ${plan.time ?? ""}`);

  // 1. The first try is refused exactly when Josh's rules say it should be.
  const firstRefused = attempt.first ? !attempt.first.ok : true;
  if (firstRefused !== expFirst.firstRefused) {
    problems.push(`first link ${firstRefused ? "refused" : "allowed"} but rules say ${expFirst.firstRefused ? `refuse (${expFirst.why})` : "allow"}${attempt.first && !attempt.first.ok ? `: ${attempt.first.error}` : ""}`);
  }
  if (attempt.first && !attempt.first.ok && !attempt.first.fixable) problems.push(`refusal not fixable by the AI: ${attempt.first.error}`);

  // 2. The final link matches the rules exactly.
  const final = attempt.final;
  const c = created.at(-1);
  if (!final?.ok || !c) {
    problems.push(`no payment link in the end${final && !final.ok ? `: ${final.error}` : ""}`);
  } else {
    const exp = expectFor(s, plan.items, plan.f, plan.area, plan.date, plan.time, now);
    if (exp.firstRefused) problems.push(`final link allowed but rules say refuse (${exp.why})`);
    if (final.total !== exp.total) problems.push(`total $${final.total}, rules say $${exp.total}`);
    const stripeTotal = c.params.line_items.reduce((a: number, l: any) => a + l.quantity * l.price_data.unit_amount, 0) / 100;
    if (stripeTotal !== exp.total) problems.push(`Stripe page charges $${stripeTotal}, rules say $${exp.total}`);
    if (c.quote.buyerProvidesLabel !== exp.label) problems.push(`buyer label ${c.quote.buyerProvidesLabel}, rules say ${exp.label}`);
    if (exp.label && !/label/i.test(attempt.quoteText ?? "")) problems.push("quote didn't mention the buyer's label at 10+");
    if (plan.f === "ship" && c.order.fulfillDate !== exp.shipDate) problems.push(`ship date ${c.order.fulfillDate}, rules say ${exp.shipDate}`);
    if (c.params.branding_settings?.button_color !== "#D4A017") problems.push("checkout not branded gold");
    if (!/All sales final/.test(c.params.custom_text.submit.message)) problems.push("checkout missing 'All sales final'");
    if (c.params.metadata.source !== "ai_dm_bot" || c.params.metadata.ig_user_id !== `u${s.id}`) problems.push("checkout metadata missing buyer");
    if (plan.f === "delivery" && c.params.metadata.delivery_area !== plan.area) problems.push("delivery area missing from checkout");
    if (plan.f !== "pickup" && !c.params.shipping_address_collection) problems.push("no address collected for ship/delivery");
    if (c.params.expires_at - Math.floor(now.getTime() / 1000) !== 31 * 60) problems.push("link not open 31 min");
    if (!sent.at(-1)?.includes(final.url)) problems.push("link never reached the customer");

    // 3. Ghosting: exactly one follow-up after 31 min, then a fresh link if they come back.
    if (s.ghost) {
      now = new Date(now.getTime() + 20 * 60_000);
      if ((await bot.followUpUnpaid()) !== 0) problems.push("followed up before the link expired");
      now = new Date(now.getTime() + 12 * 60_000);
      const n1 = await bot.followUpUnpaid();
      now = new Date(now.getTime() + 3 * 3_600_000);
      const n2 = await bot.followUpUnpaid();
      if (n1 !== 1 || n2 !== 0) problems.push(`sent ${n1 + n2} follow-ups, rules say exactly 1`);
      if (!/following up/i.test(sent.at(-1) ?? "")) problems.push("follow-up text missing");
      if (s.ghost === "back") {
        const links = created.length;
        attempt = {};
        await say("my bad I was busy");
        if (created.length !== links + 1 || !attempt.final?.ok) problems.push(`no fresh link after they came back${attempt.final && !attempt.final.ok ? `: ${attempt.final.error}` : ""}`);
      } else {
        wantsLink = false;
        await say("nah I'm good actually");
        now = new Date(now.getTime() + 2 * 3_600_000);
        if ((await bot.followUpUnpaid()) !== 0) problems.push("followed up after they said no");
      }
    }

    // 4. They pay: webhook -> confirmation DM text and calendar event on the right day/time.
    if (s.ghost !== "no") {
      const last = created.at(-1)!;
      const paidAt = new Date(now.getTime() + 5 * 60_000);
      const event = {
        type: "checkout.session.completed", created: Math.floor(paidAt.getTime() / 1000),
        data: { object: { id: "cs", payment_status: "paid", amount_total: Math.round(last.params.line_items.reduce((a: number, l: any) => a + l.quantity * l.price_data.unit_amount, 0)), customer_details: { name: "Test Buyer" }, metadata: last.params.metadata, ...(plan.f !== "pickup" ? { collected_information: { shipping_details: { name: "Test Buyer", address: { line1: "1 Main St", city: plan.area ?? "Raleigh", state: "NC", postal_code: "27601" } } } } : {}) } },
      };
      const paid = paidOrderFromEvent(event);
      if (!paid) problems.push("paid webhook not recognized");
      else {
        bot.markPaid(paid.igUserId);
        const ev = calendarEventFor(paid, "123 Warehouse Rd");
        const expDate = plan.f === "ship" ? (() => { const p = etParts(paidAt); const e = p.minutes < 19 * 60 ? p.date : addDays(p.date, 1); return last.order.fulfillDate > e ? last.order.fulfillDate : e; })() : last.order.fulfillDate;
        if (ev.date !== expDate) problems.push(`calendar on ${ev.date}, rules say ${expDate}`);
        if (plan.f !== "ship" && ev.time !== last.order.fulfillTime) problems.push("calendar time doesn't match the booked time");
        if (plan.f === "delivery" && !new RegExp(`DELIVERY ${pricing.delivery!.areas[plan.area!]}min`).test(ev.title)) problems.push("delivery calendar title missing drive time");
        if (plan.f === "pickup" && confirmationText(paid, "123 Warehouse Rd").indexOf("123 Warehouse Rd") < 0) problems.push("pickup address not sent after payment");
        transcript.push(`BOT (after payment): ${confirmationText(paid, "123 Warehouse Rd")}`);
        transcript.push(`CALENDAR: ${ev.title} on ${ev.date} ${ev.time}`);
      }
    }
  }
  return { id: s.id, kind: s.kind, ok: problems.length === 0, problems, transcript };
}

async function main() {
  const N = 1000;
  const results: Result[] = [];
  for (let i = 0; i < N; i++) results.push(await run(makeScenario(i)));
  const byKind = new Map<string, { n: number; pass: number }>();
  for (const r of results) {
    const k = byKind.get(r.kind) ?? { n: 0, pass: 0 };
    k.n++;
    if (r.ok) k.pass++;
    byKind.set(r.kind, k);
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`${passed}/${N} passed\n`);
  for (const [k, v] of byKind) console.log(`${v.pass === v.n ? "✅" : "❌"} ${k.padEnd(22)} ${v.pass}/${v.n}`);
  const problems = new Map<string, number>();
  for (const r of results) for (const p of r.problems) problems.set(p.replace(/\$\d+|\d{4}-\d{2}-\d{2}|\d+:\d+ [AP]M/g, "#"), (problems.get(p.replace(/\$\d+|\d{4}-\d{2}-\d{2}|\d+:\d+ [AP]M/g, "#")) ?? 0) + 1);
  if (problems.size) {
    console.log("\nProblems found:");
    for (const [p, n] of [...problems].sort((a, b) => b[1] - a[1])) console.log(`  ${n}x ${p}`);
    const first = results.find((r) => !r.ok)!;
    console.log(`\nExample failure #${first.id} (${first.kind}):\n  ${first.problems.join("\n  ")}\n  ${first.transcript.join("\n  ")}`);
  }
  const out = process.argv.indexOf("--json");
  if (out > 0) writeFileSync(process.argv[out + 1], JSON.stringify(results, null, 1));
  if (passed !== N) process.exitCode = 1;
}

void main();
