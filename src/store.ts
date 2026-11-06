export interface ChatImage {
  /** e.g. image/jpeg */
  mediaType: string;
  /** base64. Downloaded when the DM arrives, because Instagram's image links expire. */
  data: string;
}

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  images?: ChatImage[];
}

export interface PendingLink {
  url: string;
  summary: string;
  createdAt: number;
  followedUp?: boolean;
}

interface Conversation {
  pendingLink?: PendingLink;
  turns: ChatTurn[];
  pausedUntil: number;
  lastActivity: number;
  recentBotTexts: { text: string; at: number }[];
}

/** Everything the bot remembers about one buyer, kept forever so Josh can reach them on a restock. */
export interface Customer {
  userId: string;
  username?: string;
  firstSeen: number;
  /** Last time THEY messaged. Instagram only lets the bot DM someone within 24 hours of this. */
  lastMessageAt: number;
  /** What they asked for or want on restock, newest last. */
  interests: { item: string; at: number }[];
  orders: { summary: string; total: number; at: number }[];
}

/** What gets saved to disk. Pictures are left out (they're big and only matter for a few minutes). */
export interface StoreSnapshot {
  version: 1;
  convos: { userId: string; turns: ChatTurn[]; pausedUntil: number; lastActivity: number; pendingLink?: PendingLink }[];
  customers: Customer[];
}

const MAX_TURNS = 20;
const MAX_INTERESTS = 30;
const CONVO_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const SEEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Conversation state and the customer list. Lives in memory; src/persist.ts saves it to a file
 * (on Render's disk) so two-day buyers, follow-ups and the customer list survive a redeploy.
 */
export class Store {
  private convos = new Map<string, Conversation>();
  private seen = new Map<string, number>();
  private botMessageIds = new Set<string>();
  private customers = new Map<string, Customer>();
  /** Called after anything worth saving changes (the file saver listens here). */
  onChange?: () => void;

  constructor(private now: () => number = Date.now) {}

  private changed(): void {
    this.onChange?.();
  }

  private get(userId: string): Conversation {
    let c = this.convos.get(userId);
    if (!c) {
      c = { turns: [], pausedUntil: 0, lastActivity: this.now(), recentBotTexts: [] };
      this.convos.set(userId, c);
    }
    c.lastActivity = this.now();
    return c;
  }

  /** Returns true the first time an event id is seen, false for Meta's duplicate deliveries. */
  firstTime(eventId: string): boolean {
    if (this.seen.has(eventId)) return false;
    this.seen.set(eventId, this.now());
    return true;
  }

  history(userId: string): ChatTurn[] {
    return [...this.get(userId).turns];
  }

  addTurn(userId: string, turn: ChatTurn): void {
    const c = this.get(userId);
    c.turns.push(turn);
    if (c.turns.length > MAX_TURNS) c.turns.splice(0, c.turns.length - MAX_TURNS);
    if (turn.role === "user") this.customer(userId).lastMessageAt = this.now();
    this.changed();
  }

  // ---- customer list (for restock blasts) ----

  customer(userId: string): Customer {
    let c = this.customers.get(userId);
    if (!c) {
      c = { userId, firstSeen: this.now(), lastMessageAt: 0, interests: [], orders: [] };
      this.customers.set(userId, c);
    }
    return c;
  }

  setUsername(userId: string, username: string | undefined): void {
    if (!username) return;
    this.customer(userId).username = username;
    this.changed();
  }

  addInterest(userId: string, item: string): void {
    const text = item.trim().slice(0, 200);
    if (!text) return;
    const c = this.customer(userId);
    c.interests = c.interests.filter((i) => i.item.toLowerCase() !== text.toLowerCase());
    c.interests.push({ item: text, at: this.now() });
    if (c.interests.length > MAX_INTERESTS) c.interests.splice(0, c.interests.length - MAX_INTERESTS);
    this.changed();
  }

  addOrder(userId: string, summary: string, total: number): void {
    this.customer(userId).orders.push({ summary: summary.slice(0, 300), total, at: this.now() });
    this.changed();
  }

  allCustomers(): Customer[] {
    return [...this.customers.values()];
  }

  /** True if Instagram still allows the bot to DM them (they messaged in the last 24 hours). */
  canMessage(userId: string): boolean {
    const c = this.customers.get(userId);
    return !!c && this.now() - c.lastMessageAt < 24 * 60 * 60 * 1000;
  }

  // ---- saving to disk ----

  snapshot(): StoreSnapshot {
    return {
      version: 1,
      convos: [...this.convos].map(([userId, c]) => ({
        userId,
        turns: c.turns.map(({ role, text, images }) => ({ role, text: images?.length ? `${text} (picture not saved)` : text })),
        pausedUntil: c.pausedUntil,
        lastActivity: c.lastActivity,
        ...(c.pendingLink ? { pendingLink: c.pendingLink } : {}),
      })),
      customers: this.allCustomers(),
    };
  }

  restore(snap: StoreSnapshot | undefined): void {
    if (!snap || snap.version !== 1) return;
    for (const c of snap.convos ?? []) {
      this.convos.set(c.userId, { turns: c.turns ?? [], pausedUntil: c.pausedUntil ?? 0, lastActivity: c.lastActivity ?? this.now(), recentBotTexts: [], pendingLink: c.pendingLink });
    }
    for (const c of snap.customers ?? []) {
      this.customers.set(c.userId, {
        ...c,
        interests: c.interests ?? [],
        orders: c.orders ?? [],
        lastMessageAt: c.lastMessageAt ?? 0,
        firstSeen: c.firstSeen ?? this.now(),
      });
    }
  }

  /** Remember what the bot just sent so its own echo isn't mistaken for a team member typing. */
  recordBotMessage(userId: string, text: string, messageId?: string): void {
    if (messageId) this.botMessageIds.add(messageId);
    const c = this.get(userId);
    c.recentBotTexts.push({ text, at: this.now() });
    c.recentBotTexts = c.recentBotTexts.filter((t) => this.now() - t.at < 5 * 60 * 1000);
  }

  isBotEcho(userId: string, text: string, messageId?: string): boolean {
    if (messageId && this.botMessageIds.has(messageId)) return true;
    return this.get(userId).recentBotTexts.some((t) => t.text.trim() === text.trim());
  }

  pause(userId: string, hours: number): void {
    this.get(userId).pausedUntil = this.now() + hours * 60 * 60 * 1000;
    this.changed();
  }

  pausedUntil(userId: string): number {
    return this.convos.get(userId)?.pausedUntil ?? 0;
  }

  /** Paused chats right now (for startup logs and the admin page). */
  pausedChats(): string[] {
    return [...this.convos].filter(([, c]) => c.pausedUntil > this.now()).map(([id]) => id);
  }

  unpauseAll(): number {
    const ids = this.pausedChats();
    for (const id of ids) this.convos.get(id)!.pausedUntil = 0;
    if (ids.length) this.changed();
    return ids.length;
  }

  isPaused(userId: string): boolean {
    return (this.convos.get(userId)?.pausedUntil ?? 0) > this.now();
  }

  /** The latest unpaid payment link in a chat. A new link replaces the old one. */
  setPendingLink(userId: string, link: PendingLink): void {
    this.get(userId).pendingLink = { ...link, followedUp: false };
    this.changed();
  }

  clearPendingLink(userId: string): void {
    const c = this.convos.get(userId);
    if (c?.pendingLink) {
      c.pendingLink = undefined;
      this.changed();
    }
  }

  markFollowedUp(userId: string): void {
    const l = this.convos.get(userId)?.pendingLink;
    if (l) {
      l.followedUp = true;
      this.changed();
    }
  }

  /** Unpaid links made before `createdBefore` that haven't been followed up yet. */
  duePendingLinks(createdBefore: number): { userId: string; link: PendingLink }[] {
    const out: { userId: string; link: PendingLink }[] = [];
    for (const [userId, c] of this.convos) {
      if (c.pendingLink && !c.pendingLink.followedUp && c.pendingLink.createdAt <= createdBefore) out.push({ userId, link: c.pendingLink });
    }
    return out;
  }

  /** Drop old conversations and dedupe ids so memory doesn't grow forever. */
  cleanup(): void {
    const t = this.now();
    for (const [id, c] of this.convos) if (t - c.lastActivity > CONVO_TTL_MS) this.convos.delete(id);
    for (const [id, at] of this.seen) if (t - at > SEEN_TTL_MS) this.seen.delete(id);
    if (this.botMessageIds.size > 5000) this.botMessageIds.clear();
  }
}
