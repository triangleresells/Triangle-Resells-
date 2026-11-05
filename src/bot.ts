import type { OrderTools, ReplyEngine } from "./ai.js";
import type { KeywordRule } from "./config.js";
import type { Notifier } from "./handoff.js";
import { splitMessage, type InstagramApi } from "./instagram.js";
import { isBareKeyword, matchKeyword } from "./keywords.js";
import { describeQuote, quoteOrder, type PricingConfig } from "./pricing.js";
import type { ChatImage, Store } from "./store.js";
import { addDays, deliveryProblem, etParts, pickupProblem, scheduleText, SHIP_CUTOFF_MIN, type BusyBlock } from "./schedule.js";
import { HOLD_MINUTES } from "./stripe.js";
import type { CheckoutApi } from "./stripe.js";

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
  /** Wait this long for more messages before replying, so 3 quick texts get 1 answer. */
  debounceMs?: number;
  /** Price list for exact quotes. Without it the bot can't quote or sell. */
  pricing?: PricingConfig;
  /** Stripe. Without it the bot quotes but hands off to the team to take payment. */
  checkout?: CheckoutApi;
  /** Downloads a DM picture so the AI can see it. Defaults to a plain fetch. */
  fetchImage?: (url: string) => Promise<ChatImage | undefined>;
  /** Taken times from Josh's calendar. Without it every time from 10 AM to 10 PM is open. */
  getBusy?: () => Promise<BusyBlock[]>;
  /** Clock, for tests. */
  now?: () => Date;
}

const MAX_IMAGE_BYTES = 4_500_000;

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

export class Bot {
  private chains = new Map<string, Promise<void>>();
  private seq = new Map<string, number>();

  constructor(private d: BotDeps) {}

  /** Handles one webhook delivery from Meta. Never throws; errors are logged per event. */
  async handle(payload: WebhookPayload): Promise<void> {
    if (payload.object !== "instagram") return;
    const jobs: Promise<void>[] = [];
    for (const entry of payload.entry ?? []) {
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
      console.log(`[bot] team replied to ${userId}; bot paused ${this.d.humanPauseHours}h`);
      return;
    }

    const userId = ev.sender.id;
    if (userId === ownId) return;

    const text = msg.text?.trim() || describeAttachments(msg);
    const images = await this.picturesFrom(msg);
    const caption = images.length && msg.text?.trim() ? `${text}\n[Customer sent ${images.length} picture(s)]` : text;
    this.d.store.addTurn(userId, { role: "user", text: caption, ...(images.length ? { images } : {}) });
    if (this.d.store.isPaused(userId)) return;

    const mySeq = (this.seq.get(userId) ?? 0) + 1;
    this.seq.set(userId, mySeq);
    if (this.d.debounceMs) await sleep(this.d.debounceMs);
    if (this.seq.get(userId) !== mySeq) return; // a newer message will get the reply

    await this.inOrder(userId, () => this.replyTo(userId, text));
  }

  private async replyTo(userId: string, latestText: string): Promise<void> {
    if (this.d.store.isPaused(userId)) return;

    const rule = matchKeyword(latestText, this.d.keywords);
    if (rule && isBareKeyword(latestText, rule)) {
      await this.send(userId, rule.reply);
      return;
    }

    const [inventory, busy] = await Promise.all([this.d.getInventory(), this.busy()]);
    const schedule = scheduleText(busy, this.now());
    const result = await this.d.agent.reply(this.d.store.history(userId), inventory, this.orderTools(userId), schedule);
    let text = result.text;
    if (result.checkoutUrl && !text.includes(result.checkoutUrl)) text = `${text}\n${result.checkoutUrl}`;
    await this.send(userId, text);
    if (result.cancelFollowUp || result.handoff) this.d.store.clearPendingLink(userId);

    if (result.alerts?.length) {
      const username = await this.d.ig.getUsername(userId);
      for (const a of result.alerts) {
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

  /** Quote and checkout actions for one customer. Prices always come from the price list, never the AI. */
  private orderTools(userId: string): OrderTools | undefined {
    const pricing = this.d.pricing;
    if (!pricing) return undefined;
    return {
      quote: (items, fulfillment, deliveryArea) => {
        const q = quoteOrder(pricing, items, fulfillment, deliveryArea);
        const issues = q.problems.length ? ` PROBLEMS (hand these to the team): ${q.problems.join("; ")}` : "";
        return q.lines.length ? describeQuote(q) + issues : `Nothing could be priced.${issues}`;
      },
      checkout: async (items, fulfillment, fulfillDate, fulfillTime, deliveryArea) => {
        if (!this.d.checkout) return { ok: false, error: "card checkout isn't set up yet" };
        const q = quoteOrder(pricing, items, fulfillment, deliveryArea);
        if (q.problems.length) {
          // Too far or unknown town: the AI can fix it (ship, meet halfway, or ask the town).
          const fixable = q.problems.every((p) => p.startsWith("Too far") || p.startsWith("Delivery area"));
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
        const summary = describeQuote(q);
        const itemList = q.lines.map((l) => `${l.qty}x ${[l.name, l.variant, l.size].filter(Boolean).join(" ")}`).join(", ");
        try {
          const link = await this.d.checkout.create(q, {
            igUserId: userId,
            account: this.d.accountName,
            fulfillDate,
            fulfillTime: fulfillTime?.trim() || undefined,
            summary: itemList,
          });
          this.d.store.setPendingLink(userId, { url: link.url, summary: itemList, createdAt: now.getTime() });
          return { ok: true, url: link.url, total: q.total, summary, note };
        } catch (err) {
          console.error("[bot] checkout failed:", err);
          return { ok: false, error: "payment link failed" };
        }
      },
    };
  }

  private now(): Date {
    return this.d.now?.() ?? new Date();
  }

  private async busy(): Promise<BusyBlock[]> {
    return this.d.getBusy ? this.d.getBusy().catch(() => []) : [];
  }

  /**
   * One follow-up per unpaid link, once it has expired (call this every minute).
   * Skipped if the chat is paused for a human or the customer said they don't want it.
   */
  async followUpUnpaid(): Promise<number> {
    const due = this.d.store.duePendingLinks(this.now().getTime() - HOLD_MINUTES * 60 * 1000);
    let sent = 0;
    for (const { userId, link } of due) {
      this.d.store.markFollowedUp(userId);
      if (this.d.store.isPaused(userId)) continue;
      await this.inOrder(userId, () => this.send(userId, followUpText(link.summary))).catch((err) =>
        console.error("[bot] follow-up failed:", err),
      );
      sent++;
    }
    return sent;
  }

  /** Stripe says they paid: no follow-up for that link. */
  markPaid(userId: string): void {
    this.d.store.clearPendingLink(userId);
  }

  /** DMs a customer from outside a conversation (e.g. a payment confirmation). */
  async sendDm(userId: string, text: string): Promise<void> {
    await this.inOrder(userId, () => this.send(userId, text));
  }

  private async send(userId: string, text: string): Promise<void> {
    // Record before sending: Instagram's echo of this message can arrive before the send call returns.
    for (const part of splitMessage(text)) this.d.store.recordBotMessage(userId, part);
    const id = await this.d.ig.sendText(userId, text);
    this.d.store.recordBotMessage(userId, text, id);
    this.d.store.addTurn(userId, { role: "assistant", text });
  }

  private async onComment(ownId: string, c: CommentValue): Promise<void> {
    if (!c.id || !c.from || !c.text) return;
    if (c.from.id === ownId) return;
    if (!this.d.store.firstTime(`comment:${c.id}`)) return;

    const rule = matchKeyword(c.text, this.d.keywords);
    if (!rule) return;

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

function describeAttachments(msg: NonNullable<MessagingEvent["message"]>): string {
  const types = (msg.attachments ?? []).map((a) => a.type ?? "attachment");
  if (types.length) return `[Customer sent: ${types.join(", ")}]`;
  if (msg.is_unsupported) return "[Customer sent a message type the bot can't read]";
  return "[Customer sent an empty message]";
}
