import type { OrderTools, ReplyEngine } from "./ai.js";
import type { KeywordRule } from "./config.js";
import type { Notifier } from "./handoff.js";
import { splitMessage, type InstagramApi } from "./instagram.js";
import { isBareKeyword, matchKeyword } from "./keywords.js";
import { freebiesOf } from "./catalog.js";
import { describeQuote, quoteOrder, type PricingConfig, type Quote } from "./pricing.js";
import { matchCustomers } from "./customers.js";
import type { ChatImage, Customer, OrderLabel, Store } from "./store.js";
import { addDays, deliveryProblem, etParts, pickupProblem, scheduleText, SHIP_CUTOFF_MIN, type BusyBlock } from "./schedule.js";
import { HOLD_MINUTES } from "./stripe.js";
import type { OrderDesk } from "./desk.js";
import type { ShipTo } from "./store.js";
import type { CheckoutApi } from "./stripe.js";
import { to24h, type Crm } from "./crm.js";
import { crmContextText } from "./crmsync.js";
import type { CalendarEditor } from "./orders.js";

export interface BotDeps {
  ig: InstagramApi;
  agent: ReplyEngine;
  store: Store;
  notify: Notifier;
  getInventory: () => Promise<string>;
  accountName: string;
  keywords: KeywordRule[];
  publicCommentReplies: string[];
  humanPauseHours: number;
  /** Master switch. When it returns false the bot sends nothing (no replies, comment DMs, follow-ups or blasts). Default on. */
  enabled?: () => boolean;
  /** Wait this long for more messages before replying, so 3 quick texts get 1 answer. */
  debounceMs?: number;
  /** Human-like reply timing. When set it replaces debounceMs (see ReplyTiming). */
  replyTiming?: ReplyTiming;
  /** Price list for exact quotes. Without it the bot can't quote or sell. */
  pricing?: PricingConfig;
  /** Live stock + prices from the warehouse sheet. When set, it replaces getInventory and pricing on every reply. */
  getCatalog?: () => Promise<{ pricing: PricingConfig; text: string }>;
  /**
   * Stock read fresh from BOT STOCK (no cache), used right before an order is locked in. Unpaid bookings don't hold
   * stock (pieces are reserved when paid), so the count must be current before the bot agrees to a sale.
   */
  freshCatalog?: () => Promise<{ pricing: PricingConfig }>;
  /** A buyer who got a quote and then went quiet gets ONE nudge after this many minutes (default 90). 0 = off. */
  quietNudgeMinutes?: number;
  /** Josh has the chat but a buyer's message sits unanswered this long: the bot steps back in. 0 = never. Default 5. */
  takeoverMinutes?: number;
  /** Stripe. Without it the bot quotes but hands off to the team to take payment. */
  checkout?: CheckoutApi;
  /** Downloads a DM picture so the AI can see it. Defaults to a plain fetch. */
  fetchImage?: (url: string) => Promise<ChatImage | undefined>;
  /** Taken times from Josh's calendar. Without it every time from 10 AM to 10 PM is open. */
  getBusy?: () => Promise<BusyBlock[]>;
  /** Stock off the sheet, calendar, alerts and the sales tracker for locked-in orders. Without it orders only get a label. */
  desk?: Pick<OrderDesk, "booked" | "stripePaid"> & Partial<Pick<OrderDesk, "cancel">>;
  /** The Triangle CRM (reschedules, cancels and "I paid" go there too). Bookings are created by the desk. */
  crm?: Crm;
  /** Moves / deletes the Google Calendar events the bot made (reschedule / cancel). */
  calendarEdit?: CalendarEditor;
  /** What the bot sends buyers to pay. Unset = Josh sends it himself. */
  payInfo?: { zelle?: string; cashApp?: string };
  /** Clock, for tests. */
  now?: () => Date;
}

/**
 * How long the bot waits before answering, so it doesn't look like a bot.
 * Cold message (first DM, or they come back after being gone longer than activeWindowMs): a random
 * coldMin-coldMax wait. Live back-and-forth (they answered within activeWindowMs of the bot's last text):
 * a shorter activeMin-activeMax wait, so the bot stays in the conversation. The clock starts at their
 * FIRST unanswered text; every newer text still gets at least settleMs so a burst of texts gets one answer.
 */
export interface ReplyTiming {
  coldMinMs: number;
  coldMaxMs: number;
  activeMinMs: number;
  activeMaxMs: number;
  activeWindowMs: number;
  settleMs: number;
}

export const DEFAULT_REPLY_TIMING: ReplyTiming = {
  coldMinMs: 42_000,
  coldMaxMs: 58_000,
  activeMinMs: 8_000,
  activeMaxMs: 18_000,
  activeWindowMs: 60_000,
  settleMs: 4_000,
};

/** The wait (ms) before the first reply to a new burst of texts. */
export function pickReplyDelay(t: ReplyTiming, msSinceBotTexted: number | undefined, random: () => number = Math.random): number {
  const active = msSinceBotTexted !== undefined && msSinceBotTexted <= t.activeWindowMs;
  const [lo, hi] = active ? [t.activeMinMs, t.activeMaxMs] : [t.coldMinMs, t.coldMaxMs];
  return Math.round(lo + random() * Math.max(0, hi - lo));
}

const MAX_IMAGE_BYTES = 4_500_000;

/** "Baccarat Rouge (B tier)" -> "Baccarat Rouge": what buyers are told they get free. */
export function giftName(item: string): string {
  return item.replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
}

/** Sent once to a buyer who got a quote and went quiet, with the free gift as the hook. */
export function quietNudgeText(summary: string, gift?: string): string {
  const order = summary.length > 100 ? `${summary.slice(0, 97)}...` : summary;
  const hook = gift ? ` Just so you know, every order comes with a free ${giftName(gift)}.` : "";
  return `Hey, still got you on the ${order}.${hook} I can lock it in whenever you're ready.`;
}

/** Sent once when a payment link expires unpaid. If they answer, the AI sends a fresh link. */
export function followUpText(summary: string): string {
  const order = summary.length > 120 ? `${summary.slice(0, 117)}...` : summary;
  return `Hey, just following up on your order (${order}). The link timed out, but I can send you a fresh one whenever you're ready.`;
}
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

export async function downloadImage(url: string, fetchFn: typeof fetch = fetch): Promise<ChatImage | undefined> {
  try {
    const res = await fetchFn(url);
    if (!res.ok) return undefined;
    const mediaType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!IMAGE_TYPES.includes(mediaType)) return undefined;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) return undefined;
    return { mediaType, data: buf.toString("base64") };
  } catch (err) {
    console.error("[bot] could not download DM image:", err);
    return undefined;
  }
}

interface MessagingEvent {
  sender?: { id: string };
  recipient?: { id: string };
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    is_deleted?: boolean;
    is_unsupported?: boolean;
    attachments?: { type?: string; payload?: { url?: string } }[];
  };
}

interface CommentValue {
  id?: string;
  text?: string;
  parent_id?: string;
  from?: { id: string; username?: string };
  media?: { id: string };
}

export interface WebhookPayload {
  object?: string;
  entry?: {
    id: string;
    messaging?: MessagingEvent[];
    changes?: { field: string; value: CommentValue }[];
  }[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A second "I paid" in the same chat within this window doesn't alert Josh again. */
export const PAYMENT_ALERT_WINDOW_MS = 6 * 60 * 60_000;
/** The same alert (same item / question) in one chat within this window is sent to Josh only once. */
export const ALERT_REPEAT_WINDOW_MS = 12 * 60 * 60_000;
/** A DM after this long quiet starts a new conversation (for the CRM's DM count). */
export const NEW_CONVERSATION_MS = 6 * 60 * 60_000;

const FILLER = new Set(["the", "a", "an", "for", "in", "of", "to", "and", "or", "is", "it", "they", "them", "customer", "buyer", "asked", "asks", "wants", "want", "about", "item", "not", "stock", "carried", "we", "do", "dont", "have", "size", "if", "on", "with", "their", "this", "that", "question", "any", "our"]);

/** The words that identify what a stock alert is about ("Nike Tech Fleece L"): the first sentence, no (asides), no filler. */
export function alertWords(a: { reason: string; summary: string }): Set<string> {
  const core = a.summary.split(/(?<=[a-z0-9)])[.;]\s|\n/i)[0].replace(/\([^)]*\)/g, " ");
  const words = core
    .toLowerCase()
    .replace(/[^a-z0-9$ ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !FILLER.has(w));
  return new Set(words);
}

/** Two alerts are the same when most of the smaller one's key words are in the other. */
export function sameAlert(a: Set<string>, b: Set<string>): boolean {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  if (small.size === 0) return big.size === 0;
  let shared = 0;
  for (const w of small) if (big.has(w)) shared++;
  return shared / small.size >= 0.7;
}

export class Bot {
  private chains = new Map<string, Promise<void>>();
  private seq = new Map<string, number>();
  /** When the bot will answer the texts it's holding for each chat (Date.now() ms). */
  private replyAt = new Map<string, number>();
  /** Last "says they paid" alert per chat, so "thanks!" after "sent it" doesn't ping Josh again. */
  private paidAlertAt = new Map<string, number>();
  /** Alerts already sent per chat (key words + time), so the same heads-up doesn't ping Josh on every turn. */
  private alertsSent = new Map<string, { words: Set<string>; at: number }[]>();

  constructor(private d: BotDeps) {}

  /** Handles one webhook delivery from Meta. Never throws; errors are logged per event. */
  async handle(payload: WebhookPayload): Promise<void> {
    if (payload.object !== "instagram") return;
    const jobs: Promise<void>[] = [];
    for (const entry of payload.entry ?? []) {
      this.d.ig.setAccountId?.(entry.id);
      for (const ev of entry.messaging ?? []) jobs.push(this.safe(() => this.onMessage(entry.id, ev)));
      for (const ch of entry.changes ?? []) {
        if (ch.field === "comments") jobs.push(this.safe(() => this.onComment(entry.id, ch.value)));
      }
    }
    await Promise.all(jobs);
  }

  private async safe(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      console.error("[bot] event failed:", err);
    }
  }

  private async onMessage(ownId: string, ev: MessagingEvent): Promise<void> {
    const msg = ev.message;
    if (!msg || msg.is_deleted || !ev.sender || !ev.recipient) return;
    if (msg.mid && !this.d.store.firstTime(msg.mid)) return;

    // Messages sent from our account come back as "echoes".
    if (msg.is_echo) {
      const userId = ev.recipient.id;
      const text = msg.text ?? "";
      if (this.d.store.isBotEcho(userId, text, msg.mid)) return;
      // A team member typed in the Instagram inbox: step back and let them handle it.
      this.d.store.addTurn(userId, { role: "assistant", text: `[Team member replied] ${text}` });
      this.d.store.pause(userId, this.d.humanPauseHours);
      console.log(`[bot] team replied to ${userId} from the inbox; bot paused ${Math.round(this.d.humanPauseHours * 60)} min in that chat`);
      return;
    }

    const userId = ev.sender.id;
    if (userId === ownId) return;

    const text = msg.text?.trim() || describeAttachments(msg);
    const images = await this.picturesFrom(msg);
    const caption = images.length && msg.text?.trim() ? `${text}\n[Customer sent ${images.length} picture(s)]` : text;
    // A new conversation (first DM, or back after 6+ hours): counts toward "most active in DMs" in the CRM.
    const lastFromThem = this.d.store.customer(userId).lastMessageAt;
    if (this.d.crm && (!lastFromThem || this.now().getTime() - lastFromThem > NEW_CONVERSATION_MS)) {
      void this.d.crm.recordDm(userId, this.d.store.customer(userId).username).catch((err) => console.error("[bot] CRM DM count failed:", (err as Error).message ?? err));
    }
    this.d.store.addTurn(userId, { role: "user", text: caption, ...(images.length ? { images } : {}) });
    console.log(`[bot] DM from ${userId}${this.d.store.isPaused(userId) ? ` (bot is PAUSED in this chat until ${new Date(this.d.store.pausedUntil(userId)).toISOString()}, not replying)` : ""}`);
    if (!this.d.store.customer(userId).username) {
      void this.d.ig.getUsername(userId).then((u) => this.d.store.setUsername(userId, u)).catch(() => {});
    }
    if (this.d.store.isPaused(userId)) return;

    const mySeq = (this.seq.get(userId) ?? 0) + 1;
    this.seq.set(userId, mySeq);
    const timing = this.d.replyTiming;
    if (timing) {
      let at = this.replyAt.get(userId);
      if (at === undefined) {
        const lastBot = this.d.store.lastBotAt(userId);
        at = Date.now() + pickReplyDelay(timing, lastBot ? Date.now() - lastBot : undefined);
        this.replyAt.set(userId, at);
      }
      await sleep(Math.max(at - Date.now(), timing.settleMs));
    } else if (this.d.debounceMs) {
      await sleep(this.d.debounceMs);
    }
    if (this.seq.get(userId) !== mySeq) return; // a newer message will get the reply
    this.replyAt.delete(userId);

    await this.inOrder(userId, () => this.replyTo(userId, text));
  }

  private async replyTo(userId: string, latestText: string): Promise<void> {
    if (this.d.store.isPaused(userId)) return;
    if (!this.isOn()) {
      console.log(`[bot] OFF (BOT_ENABLED isn't true): saved the DM from ${userId}, not replying`);
      return;
    }

    const rule = matchKeyword(latestText, this.d.keywords);
    if (rule && isBareKeyword(latestText, rule)) {
      await this.send(userId, rule.reply);
      return;
    }

    // "typing..." while the AI writes, like a person. Best effort.
    void this.d.ig.typingOn?.(userId).catch(() => {});
    const [catalog, busy, crmNote] = await Promise.all([this.catalog(), this.busy(), this.crmContext(userId)]);
    const schedule = scheduleText(busy, this.now()) + crmNote;
    const started = Date.now();
    const result = await this.d.agent.reply(this.d.store.history(userId), catalog.text, this.orderTools(userId, catalog.pricing), schedule);
    console.log(`[bot] AI answered ${userId} in ${Date.now() - started}ms${result.handoff ? ` (handoff: ${result.handoff.reason})` : ""}`);
    let text = result.text;
    if (result.checkoutUrl && !text.includes(result.checkoutUrl)) text = `${text}\n${result.checkoutUrl}`;
    await this.send(userId, text);
    if (result.cancelFollowUp || result.handoff) this.d.store.clearPendingLink(userId);
    // Customer list: whatever they asked about or wanted, for restock blasts later.
    for (const item of [...(result.interests ?? []), ...(result.alerts ?? []).map((a) => a.summary)]) this.d.store.addInterest(userId, item);

    // The AI can't see its earlier tool calls, so it re-sends the same alert on later turns. Josh gets each one once.
    const nowMs = this.now().getTime();
    const sentBefore = (this.alertsSent.get(userId) ?? []).filter((s) => nowMs - s.at < ALERT_REPEAT_WINDOW_MS);
    const fresh = (result.alerts ?? []).filter((a) => {
      if (a.kind === "question") return true; // the buyer is waiting on this one: always send it
      const words = alertWords(a);
      if (sentBefore.some((s) => sameAlert(s.words, words))) return false;
      sentBefore.push({ words, at: nowMs });
      return true;
    });
    this.alertsSent.set(userId, sentBefore);
    if (fresh.length) {
      const username = await this.d.ig.getUsername(userId);
      for (const a of fresh) {
        await this.d
          .notify({ account: this.d.accountName, userId, username, route: "josh", paused: false, ...a })
          .catch((err) => console.error("[bot] alert failed:", err));
      }
    }

    if (result.handoff) {
      this.d.store.pause(userId, this.d.humanPauseHours);
      const username = await this.d.ig.getUsername(userId);
      await this.d.notify({ account: this.d.accountName, userId, username, ...result.handoff });
    }
  }

  private async picturesFrom(msg: NonNullable<MessagingEvent["message"]>): Promise<ChatImage[]> {
    const urls = (msg.attachments ?? [])
      .filter((a) => a.type === "image" && a.payload?.url)
      .map((a) => a.payload!.url!)
      .slice(0, 4);
    const fetchImage = this.d.fetchImage ?? ((u: string) => downloadImage(u));
    const got = await Promise.all(urls.map((u) => fetchImage(u)));
    return got.filter((g): g is ChatImage => !!g);
  }

  private async catalog(): Promise<{ pricing?: PricingConfig; text: string }> {
    if (this.d.getCatalog) {
      try {
        return await this.d.getCatalog();
      } catch (err) {
        console.error("[bot] catalog failed, using the saved price list:", err);
      }
    }
    return { pricing: this.d.pricing, text: await this.d.getInventory() };
  }

  /** Checks an order is sellable and the day/time works. Shared by Stripe links and cash/Cash App/Apple Pay orders. */
  private async settle(
    pricing: PricingConfig,
    items: Parameters<OrderTools["quote"]>[0],
    fulfillment: Parameters<OrderTools["quote"]>[1],
    fulfillDate: string,
    fulfillTime: string | undefined,
    deliveryArea: string | undefined,
  ): Promise<{ ok: false; error: string; fixable?: boolean } | { ok: true; q: Quote; fulfillDate: string; fulfillTime?: string; note?: string }> {
    const q = quoteOrder(pricing, items, fulfillment, deliveryArea);
    if (q.problems.length) {
      // Too far or unknown town: the AI can fix it (ship, meet halfway, or ask the town).
      const fixable = q.problems.every((p) => p.startsWith("Too far") || p.startsWith("Delivery area") || /not in stock|Only \d+ of|sold out/.test(p));
      return { ok: false, error: q.problems.join("; "), fixable };
    }
    if (!q.lines.length) return { ok: false, error: "no items" };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fulfillDate ?? "")) return { ok: false, error: "fulfill_date must be YYYY-MM-DD", fixable: true };
    const now = this.now();
    const today = etParts(now);
    let note: string | undefined;
    if (fulfillment === "pickup") {
      const problem = pickupProblem(fulfillDate, fulfillTime, await this.busy(), now);
      if (problem) return { ok: false, error: problem, fixable: true };
    } else if (fulfillment === "delivery") {
      const problem = deliveryProblem(fulfillDate, fulfillTime, q.delivery!.minutes, await this.busy(), now);
      if (problem) return { ok: false, error: problem, fixable: true };
    } else {
      // Ships the day it's paid before 7pm ET, otherwise the next day.
      const earliest = today.minutes < SHIP_CUTOFF_MIN ? today.date : addDays(today.date, 1);
      if (fulfillDate < earliest) {
        fulfillDate = earliest;
        note = `It's past 7pm ET, so this ships ${earliest} (tell the customer it ships tomorrow).`;
      }
      fulfillTime = undefined;
    }
    return { ok: true, q, fulfillDate, fulfillTime, note };
  }

  /** The buyer's order from the last 24 hours with the same items, total and fulfillment, if there is one. */
  private recentSameOrder(userId: string, q: Quote, fulfillment: string): OrderLabel | undefined {
    if (!q.lines.length) return undefined;
    const last = this.d.store.latestLabelFor(userId);
    if (!last || this.now().getTime() - last.createdAt > 24 * 3_600_000) return undefined;
    return last.summary === itemList(q) && last.total === q.total && last.fulfillment === fulfillment ? last : undefined;
  }

  /** Quote and order actions for one customer. Prices always come from the price list, never the AI. */
  private orderTools(userId: string, pricing = this.d.pricing): OrderTools | undefined {
    if (!pricing) return undefined;
    const tools: OrderTools = {
      quote: (items, fulfillment, deliveryArea) => {
        const q = quoteOrder(pricing, items, fulfillment, deliveryArea);
        const issues = q.problems.length ? ` PROBLEMS: ${q.problems.join("; ")}` : "";
        if (q.lines.length && !this.d.checkout) {
          // Remember the quote so a buyer who goes quiet gets one nudge (with the free gift).
          this.d.store.setPendingLink(userId, { url: "", summary: itemList(q), createdAt: this.now().getTime() });
        }
        return q.lines.length ? describeQuote(q) + issues : `Nothing could be priced.${issues}`;
      },
    };
    // Right before locking in, re-read stock so "only N left" is checked against the live sheet, not a copy from minutes ago.
    const livePricing = async (): Promise<PricingConfig> => {
      if (!this.d.freshCatalog) return pricing;
      try {
        return (await this.d.freshCatalog()).pricing;
      } catch (err) {
        console.error("[bot] fresh stock read failed, using the last copy:", err);
        return pricing;
      }
    };
    tools.submitOrder = async (items, fulfillment, fulfillDate, fulfillTime, deliveryArea, payment, shipTo) => {
      // Payment rules first, so the AI can fix them with the buyer.
      if (payment === "apple_pay" && this.d.checkout) {
        return { ok: false, error: "Card and Apple Pay go through the payment link: use create_checkout_link instead", fixable: true };
      }
      if (payment === "cash" && fulfillment === "ship") {
        return { ok: false, error: "Shipped orders are paid up front (Cash App, Zelle or the card link), not cash", fixable: true };
      }
      if (payment === "cash" && fulfillment === "delivery") {
        return { ok: false, error: "Cash orders are pickup at the warehouse. If they can pick up, switch to pickup. If they have no ride, Josh handles cash deliveries himself", handoff: true };
      }
      if (fulfillment === "ship") {
        const missing = (["name", "street", "city", "state", "zip"] as const).filter((k) => !String(shipTo?.[k] ?? "").trim());
        if (missing.length) return { ok: false, error: `Need the buyer's shipping info first: ${missing.join(", ")}`, fixable: true };
      }
      // We don't hold unpaid items: cash is paid in person, so cash is for a pickup TODAY only. A later day is paid first.
      if (payment === "cash" && /^\d{4}-\d{2}-\d{2}$/.test(fulfillDate ?? "") && fulfillDate > etParts(this.now()).date) {
        return {
          ok: false,
          error: "Cash is only for a pickup today. For a later day they pay first (Cash App or Zelle) and we hold it once Josh confirms the payment. Or they can come today with cash",
          fixable: true,
        };
      }
      const pricingNow = await livePricing();
      // The AI only sees chat text from earlier turns, not its tool calls, so it can try to lock in the same
      // order twice. A repeat would take stock off twice and double-book Josh: answer from the first booking.
      const dupe = this.recentSameOrder(userId, quoteOrder(pricingNow, items, fulfillment, deliveryArea), fulfillment);
      if (dupe) {
        return {
          ok: true,
          total: dupe.total,
          summary: dupe.summary,
          freebies: [],
          alreadyBooked: true,
        };
      }
      const r = await this.settle(pricingNow, items, fulfillment, fulfillDate, fulfillTime, deliveryArea);
      if (!r.ok) return r;
      this.d.store.clearPendingLink(userId);
      this.d.store.addInterest(userId, itemList(r.q));
      const when = r.fulfillTime ? `${r.fulfillDate} ${r.fulfillTime}` : r.fulfillDate;
      const pay = payment.replace("_", " ");
      const summary = `${describeQuote(r.q)}; ${fulfillment} ${when}${r.q.delivery ? ` (${r.q.delivery.area})` : ""}; pays by ${pay}`;
      const lines = r.q.lines.map((l) => ({ name: l.name, variant: l.variant, size: l.size, qty: l.qty, unitPrice: l.unitPrice }));
      const itemsTotal = r.q.lines.reduce((t, l) => t + l.lineTotal, 0);
      const ship: ShipTo | undefined = fulfillment === "ship" && shipTo ? shipTo : undefined;
      if (this.d.desk) {
        const booked = await this.d.desk.booked({
          userId,
          username: this.d.store.customer(userId).username,
          lines,
          items: itemList(r.q),
          itemsTotal,
          total: r.q.total,
          payment: pay,
          fulfillment,
          fulfillDate: r.fulfillDate,
          fulfillTime: r.fulfillTime,
          deliveryArea: r.q.delivery?.area,
          deliveryMinutes: r.q.delivery?.minutes,
          deliveryFee: r.q.delivery?.fee,
          shipping: r.q.shipping || undefined,
          shipTo: ship,
          freebies: r.q.freebies,
        });
        // The CRM said no (the piece just sold, or it's not sellable): nothing was booked.
        if ("refused" in booked) return { ok: false, error: booked.refused, fixable: true };
      } else {
        this.d.store.addLabel({
          userId,
          label: "BOOKED",
          summary: itemList(r.q),
          total: r.q.total,
          payment: pay,
          when: `${fulfillment} ${when}${r.q.delivery ? ` (${r.q.delivery.area})` : ""}`,
          lines,
          fulfillment,
          shipTo: ship,
          deliveryFee: r.q.delivery?.fee,
          shipping: r.q.shipping || undefined,
        });
      }
      return { ok: true, total: r.q.total, summary, freebies: r.q.freebies, note: r.note, payText: payTextFor(payment, r.q.total, this.d.payInfo) };
    };
    tools.paymentSent = async (method, note) => {
      // The AI can't see its earlier tool calls, so it calls payment_sent again on every "thanks". One alert per chat
      // per PAYMENT_ALERT_WINDOW_MS is enough: Josh checks his app once.
      const nowMs = this.now().getTime();
      const last = this.paidAlertAt.get(userId);
      if (last !== undefined && nowMs - last < PAYMENT_ALERT_WINDOW_MS) {
        return "Josh was ALREADY told about this payment. Don't call payment_sent again in this chat. If they're just saying thanks, say thanks back. Never say the payment is confirmed or received.";
      }
      this.paidAlertAt.set(userId, nowMs);
      const label = this.d.store.latestLabelFor(userId);
      if (label) this.d.store.updateLabel(label.id, { saysPaid: `${method.replace("_", " ")}: ${note}`.slice(0, 200) });
      const username = await this.d.ig.getUsername(userId).catch(() => undefined);
      await this.d
        .notify({
          account: this.d.accountName,
          userId,
          username,
          route: "josh",
          paused: false,
          reason: `💸 Says they paid${label ? ` $${label.total}` : ""} by ${method.replace("_", " ")}: CHECK YOUR APP`,
          summary: `${note}${label ? `. Order: ${label.summary}` : ""}. Screenshots can be faked: only mark it paid (in the CRM, or /admin if the CRM is off) once the money is actually in.`,
        })
        .catch((err) => console.error("[bot] payment alert failed:", err));
      // CRM: the bot's "paid" on Zelle / Cash App becomes "Paid - needs check" there (only a person confirms).
      if (label?.crmId && this.d.crm) {
        await this.d.crm.setStatus(label.crmId, "paid").catch((err) => console.error("[bot] CRM paid status failed:", err));
      }
      return "Josh was told to check his app. Tell the buyer: got it, Josh will confirm as soon as it shows on his end. Never say the payment is confirmed or received.";
    };
    tools.rescheduleOrder = async (date, time) => {
      const label = this.d.store.latestLabelFor(userId);
      if (!label) return "This buyer has no locked-in order to move. If they want a new order, go through submit_order.";
      if (label.fulfillment === "ship") return "Shipped orders go out the day they're paid (before 7pm ET) or the next day; there's no day to move. Tell them that.";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "Could not move it: the date must be YYYY-MM-DD. Ask which day.";
      const now = this.now();
      const busy = await this.busy();
      const problem =
        label.fulfillment === "delivery"
          ? deliveryProblem(date, time, label.deliveryMinutes ?? 30, busy, now)
          : pickupProblem(date, time, busy, now);
      if (problem) return `Could not move it: ${problem}. Offer the closest open times and try again once they pick.`;
      const area = label.when.match(/\(([^)]+)\)\s*$/)?.[1];
      const when = [label.fulfillment ?? "pickup", date, time, area && `(${area})`].filter(Boolean).join(" ");
      const before = label.when;
      this.d.store.updateLabel(label.id, { when });
      let crmNote = "";
      if (label.crmId && this.d.crm) {
        await this.d.crm.reschedule(label.crmId, date, to24h(time)).catch((err) => {
          console.error("[bot] CRM reschedule failed:", err);
          crmNote = " (NOT updated in the CRM: move it there by hand)";
        });
      }
      // Google Calendar: move the event the bot made. Older events (made before the calendar script update) have no id.
      const calMoved = !!(label.calendarId && this.d.calendarEdit && (await this.d.calendarEdit.move(label.calendarId, date, time ?? "", 30)));
      const username = await this.d.ig.getUsername(userId).catch(() => undefined);
      await this.d
        .notify({ account: this.d.accountName, userId, username, route: "josh", paused: false, reason: `🔁 Rescheduled: ${when}${crmNote}`, summary: `${label.summary}. Was: ${before}. ${calMoved ? "Calendar event moved." : "Move the calendar event by hand (the bot couldn't)."}` })
        .catch((err) => console.error("[bot] reschedule alert failed:", err));
      return `Moved to ${when}. Tell the buyer the new day and time in one short text. Don't resend the order summary or payment info.`;
    };
    tools.cancelOrder = async (reason) => {
      const label = this.d.store.latestLabelFor(userId);
      if (!label) return "This buyer has no locked-in order to cancel. Say no problem and leave the door open.";
      if (label.label === "PAID" || label.saysPaid) {
        return "This order is already paid (or they said they sent the money): don't cancel it. All sales are final; call handoff_to_team (josh) with what they want.";
      }
      if (this.d.desk?.cancel) await this.d.desk.cancel(label.id);
      else this.d.store.clearLabel(label.id);
      this.d.store.clearPendingLink(userId);
      let crmNote = "";
      if (label.crmId && this.d.crm) {
        await this.d.crm.setStatus(label.crmId, "cancelled", reason).catch((err) => {
          console.error("[bot] CRM cancel failed:", err);
          crmNote = " (NOT cancelled in the CRM: do it by hand)";
        });
      }
      // Deleting the event also frees that time for other buyers.
      const calDeleted = !!(label.calendarId && this.d.calendarEdit && (await this.d.calendarEdit.remove(label.calendarId)));
      const username = await this.d.ig.getUsername(userId).catch(() => undefined);
      await this.d
        .notify({ account: this.d.accountName, userId, username, route: "josh", paused: false, reason: `❌ Cancelled: ${label.summary}${crmNote}`, summary: `${reason}. Was ${label.when}, $${label.total}. Stock went back on BOT STOCK. ${calDeleted ? "Calendar event deleted." : "Delete the calendar event by hand (the bot couldn't)."}` })
        .catch((err) => console.error("[bot] cancel alert failed:", err));
      return "Cancelled, and the pieces are back in stock. Tell them no problem in one short text and leave the door open. Don't call cancel_follow_up too.";
    };
    if (!this.d.checkout) return tools;
    tools.checkout = async (items, fulfillment, fulfillDateIn, fulfillTimeIn, deliveryArea) => {
        if (!this.d.checkout) return { ok: false, error: "card checkout isn't set up yet" };
        const r = await this.settle(await livePricing(), items, fulfillment, fulfillDateIn, fulfillTimeIn, deliveryArea);
        if (!r.ok) return r;
        const { q, fulfillDate, fulfillTime, note } = r;
        const now = this.now();
        const summary = describeQuote(q);
        const list = itemList(q);
        try {
          const link = await this.d.checkout.create(q, {
            igUserId: userId,
            account: this.d.accountName,
            fulfillDate,
            fulfillTime: fulfillTime?.trim() || undefined,
            summary: list,
          });
          this.d.store.setPendingLink(userId, {
            url: link.url,
            summary: list,
            createdAt: now.getTime(),
            lines: q.lines.map((l) => ({ name: l.name, variant: l.variant, size: l.size, qty: l.qty })),
          });
          this.d.store.addInterest(userId, list);
          return { ok: true, url: link.url, total: q.total, summary, note };
        } catch (err) {
          console.error("[bot] checkout failed:", err);
          return { ok: false, error: "payment link failed" };
        }
    };
    return tools;
  }

  private now(): Date {
    return this.d.now?.() ?? new Date();
  }

  /** The buyer's open CRM bookings for the AI (the CRM wins over the chat). Gives up after 3s: a slow CRM never holds a reply. */
  private notesCache: { at: number; text: string } | undefined;

  /** The team's notes for the bot (from the CRM assistant), refreshed at most once a minute. */
  private async teamNotes(): Promise<string> {
    if (!this.d.crm) return "";
    if (this.notesCache && Date.now() - this.notesCache.at < 60_000) return this.notesCache.text;
    try {
      const notes = await this.d.crm.notes();
      const text = notes.length
        ? `\n\nTEAM NOTES (from Josh, Chema and Diego, newest first; these are newer than the knowledge base and win when they disagree):\n${notes.map((n) => `- ${n.note}`).join("\n")}`
        : "";
      this.notesCache = { at: Date.now(), text };
      return text;
    } catch (err) {
      console.error("[bot] CRM notes failed:", (err as Error).message ?? err);
      return this.notesCache?.text ?? "";
    }
  }

  private async crmContext(userId: string): Promise<string> {
    if (!this.d.crm) return "";
    const timeout = new Promise<string>((r) => setTimeout(() => r(""), 3000).unref?.());
    const lookup = this.d.crm.buyerContext(userId).then((c) => crmContextText(c.bookings, c.customer)).catch((err) => {
      console.error("[bot] CRM lookup failed:", (err as Error).message ?? err);
      return "";
    });
    const notes = Promise.race([this.teamNotes(), new Promise<string>((r) => setTimeout(() => r(this.notesCache?.text ?? ""), 3000).unref?.())]);
    const [buyer, team] = await Promise.all([Promise.race([lookup, timeout]), notes]);
    return team + buyer;
  }

  /**
   * A message to a buyer from outside the chat (e.g. their tracking number, added in the CRM). Instagram only allows it
   * within 24 hours of the buyer's last message: "window_closed" means a person has to send it.
   */
  async messageBuyer(userId: string, text: string): Promise<"sent" | "window_closed" | "off"> {
    if (!this.isOn()) return "off";
    if (!this.d.store.canMessage(userId)) return "window_closed";
    await this.inOrder(userId, () => this.send(userId, text));
    return "sent";
  }

  private async busy(): Promise<BusyBlock[]> {
    return this.d.getBusy ? this.d.getBusy().catch(() => []) : [];
  }

  /**
   * Josh has a chat (he typed in the inbox, or the bot handed off), but the buyer's latest message has gone
   * unanswered for takeoverMinutes: the bot takes the chat back and answers. If Josh replies first, his message is the
   * last one and the bot stays out. Call this every 30 seconds.
   */
  async takeOverStalled(): Promise<number> {
    if (!this.isOn()) return 0;
    const minutes = this.d.takeoverMinutes ?? 5;
    if (minutes <= 0) return 0;
    const now = this.now().getTime();
    let taken = 0;
    for (const userId of this.d.store.pausedChats()) {
      const last = this.d.store.history(userId).at(-1);
      if (last?.role !== "user") continue;
      const at = this.d.store.customer(userId).lastMessageAt;
      if (!at || now - at < minutes * 60_000) continue;
      this.d.store.unpause(userId);
      console.log(`[bot] no reply from the team in ${minutes} min: bot is back in the chat with ${userId}`);
      await this.inOrder(userId, () => this.replyTo(userId, last.text)).catch((err) => console.error("[bot] takeover reply failed:", err));
      taken++;
    }
    return taken;
  }

  /**
   * One follow-up per unpaid link, once it has expired (call this every minute).
   * Skipped if the chat is paused for a human or the customer said they don't want it.
   */
  async followUpUnpaid(): Promise<number> {
    if (!this.isOn()) return 0;
    const now = this.now().getTime();
    const quietMin = this.d.quietNudgeMinutes ?? 90;
    const linkDue = this.d.store.duePendingLinks(now - HOLD_MINUTES * 60 * 1000).filter((d) => d.link.url);
    const quietDue = quietMin > 0 ? this.d.store.duePendingLinks(now - quietMin * 60 * 1000).filter((d) => !d.link.url) : [];
    let gift: string | undefined;
    if (quietDue.length) {
      const { pricing } = await this.catalog();
      gift = freebiesOf(pricing?.stock ?? []).find((f) => f.minPieces <= 1)?.item;
    }
    let sent = 0;
    for (const { userId, link } of [...linkDue, ...quietDue]) {
      // Quiet nudge: only if our message was the last one (they never answered) and Instagram's 24h window is open.
      if (!link.url) {
        const last = this.d.store.history(userId).at(-1);
        if (last?.role !== "assistant") continue;
        this.d.store.markFollowedUp(userId);
        if (this.d.store.isPaused(userId) || !this.d.store.canMessage(userId)) continue;
      } else {
        this.d.store.markFollowedUp(userId);
        if (this.d.store.isPaused(userId)) continue;
      }
      const text = link.url ? followUpText(link.summary) : quietNudgeText(link.summary, gift);
      await this.inOrder(userId, () => this.send(userId, text)).catch((err) =>
        console.error("[bot] follow-up failed:", err),
      );
      sent++;
    }
    return sent;
  }

  /** Stripe says they paid: no follow-up for that link, and it goes on their customer record. */
  async markPaid(userId: string, summary = "", total = 0, when = "", fulfillment: "pickup" | "delivery" | "ship" = "pickup"): Promise<void> {
    const lines = this.d.store.pendingLink(userId)?.lines ?? [];
    this.d.store.clearPendingLink(userId);
    if (summary || total) this.d.store.addOrder(userId, summary, total);
    if (this.d.desk) await this.d.desk.stripePaid(userId, lines, summary, total, when, fulfillment);
    else this.d.store.addLabel({ userId, label: "PAID", summary, total, payment: "stripe", when, lines, fulfillment });
  }

  /**
   * Restock blast: DMs everyone on the list who wants `search` and messaged in the last 24 hours
   * (Instagram's rule). Returns the rest so Josh can DM them himself from the app.
   */
  async blast(message: string, search: string): Promise<{ sent: Customer[]; manual: Customer[] }> {
    const sent: Customer[] = [];
    const manual: Customer[] = [];
    if (!this.isOn()) return { sent, manual: matchCustomers(this.d.store.allCustomers(), search) };
    for (const c of matchCustomers(this.d.store.allCustomers(), search)) {
      if (!this.d.store.canMessage(c.userId)) {
        manual.push(c);
        continue;
      }
      try {
        await this.inOrder(c.userId, () => this.send(c.userId, message));
        sent.push(c);
      } catch (err) {
        console.error(`[bot] blast to ${c.userId} failed:`, err);
        manual.push(c);
      }
    }
    return { sent, manual };
  }

  /** DMs a customer from outside a conversation (e.g. a payment confirmation). */
  async sendDm(userId: string, text: string): Promise<void> {
    await this.inOrder(userId, () => this.send(userId, text));
  }

  private isOn(): boolean {
    return this.d.enabled ? this.d.enabled() : true;
  }

  private async send(userId: string, text: string): Promise<void> {
    if (!this.isOn()) {
      console.log(`[bot] OFF: did not send a message to ${userId}`);
      return;
    }
    // A blank line in the reply means "send as a separate text", like a person sending two quick DMs.
    const bubbles = toBubbles(text);
    // Record before sending: Instagram's echo of this message can arrive before the send call returns.
    for (const b of bubbles) for (const part of splitMessage(b)) this.d.store.recordBotMessage(userId, part);
    for (const b of bubbles) {
      const id = await this.d.ig.sendText(userId, b);
      this.d.store.recordBotMessage(userId, b, id);
    }
    console.log(`[bot] sent reply to ${userId} (${bubbles.length} message${bubbles.length > 1 ? "s" : ""}, ${text.length} chars)`);
    this.d.store.addTurn(userId, { role: "assistant", text: bubbles.join("\n\n") });
    // The quiet-buyer clock starts at our last message.
    this.d.store.touchQuote(userId, this.now().getTime());
  }

  private async onComment(ownId: string, c: CommentValue): Promise<void> {
    if (!c.id || !c.from || !c.text) return;
    if (c.from.id === ownId) return;
    if (!this.d.store.firstTime(`comment:${c.id}`)) return;

    const rule = matchKeyword(c.text, this.d.keywords);
    if (!rule) return;
    if (!this.isOn()) {
      console.log(`[bot] OFF: comment keyword ${rule.keyword} from @${c.from.username ?? c.from.id}, no DM sent`);
      return;
    }

    const userId = c.from.id;
    this.d.store.addTurn(userId, { role: "user", text: `[Commented "${c.text}" on a post]` });
    this.d.store.recordBotMessage(userId, rule.reply);
    const id = await this.d.ig.sendPrivateReply(c.id, rule.reply);
    this.d.store.recordBotMessage(userId, rule.reply, id);
    this.d.store.addTurn(userId, { role: "assistant", text: rule.reply });
    console.log(`[bot] comment keyword ${rule.keyword} from @${c.from.username ?? userId} → DM sent`);

    const pub = this.d.publicCommentReplies;
    if (pub.length && !c.parent_id) {
      const line = pub[Math.floor(Math.random() * pub.length)];
      await this.d.ig.replyToComment(c.id, line).catch((err) => console.error("[bot] public reply failed:", err));
    }
  }

  /** Runs replies for one customer one at a time, in order. */
  private inOrder(userId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(userId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(
      userId,
      next.catch(() => {}),
    );
    return next;
  }
}

/** What the bot tells the buyer right after an order is locked in. */
export function payTextFor(payment: string, total: number, info?: { zelle?: string; cashApp?: string }): string {
  if (payment === "cash") return "Write ONE short text: it's booked, cash at pickup, and Josh will send the pickup spot before the day. Don't give out any address.";
  if (payment === "zelle" && info?.zelle) return `Write ONE short text with the payment info exactly: "Zelle $${total} to ${info.zelle}". Ask them to send a screenshot here once it's sent. Never say it's paid until Josh confirms.`;
  if (payment === "cash_app" && info?.cashApp) return `Write ONE short text with the payment info exactly: "Cash App $${total} to ${info.cashApp}". Ask them to send a screenshot here once it's sent. Never say it's paid until Josh confirms.`;
  return `Write ONE short text: Josh will send the ${payment.replace("_", " ")} info right here to lock it in.`;
}

function describeAttachments(msg: NonNullable<MessagingEvent["message"]>): string {
  const types = (msg.attachments ?? []).map((a) => a.type ?? "attachment");
  if (types.length) return `[Customer sent: ${types.join(", ")}]`;
  if (msg.is_unsupported) return "[Customer sent a message type the bot can't read]";
  return "[Customer sent an empty message]";
}

function itemList(q: Quote): string {
  return q.lines.map((l) => `${l.qty}x ${[l.name, l.variant, l.size].filter(Boolean).join(" ")}`).join(", ");
}

/** Most texts a single reply is sent as. Anything past this is joined onto the last one. */
export const MAX_BUBBLES = 3;

/** Splits a reply on blank lines into separate DMs (max MAX_BUBBLES). */
export function toBubbles(text: string): string[] {
  const parts = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (parts.length <= MAX_BUBBLES) return parts.length ? parts : [text.trim()];
  return [...parts.slice(0, MAX_BUBBLES - 1), parts.slice(MAX_BUBBLES - 1).join("\n")];
}
