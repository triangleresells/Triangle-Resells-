import type { ReplyEngine } from "./ai.js";
import type { KeywordRule } from "./config.js";
import type { Notifier } from "./handoff.js";
import { splitMessage, type InstagramApi } from "./instagram.js";
import { isBareKeyword, matchKeyword } from "./keywords.js";
import type { Store } from "./store.js";

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
    attachments?: { type?: string }[];
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
    this.d.store.addTurn(userId, { role: "user", text });
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

    const inventory = await this.d.getInventory();
    const result = await this.d.agent.reply(this.d.store.history(userId), inventory);
    await this.send(userId, result.text);

    if (result.handoff) {
      this.d.store.pause(userId, this.d.humanPauseHours);
      const username = await this.d.ig.getUsername(userId);
      await this.d.notify({ account: this.d.accountName, userId, username, ...result.handoff });
    }
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
