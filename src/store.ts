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
  /** Sheet lines of a Stripe link, so stock comes off when it's paid. */
  lines?: { name: string; variant?: string; size?: string; qty: number }[];
}

interface Conversation {
  pendingLink?: PendingLink;
  turns: ChatTurn[];
  pausedUntil: number;
  lastActivity: number;
  recentBotTexts: { text: string; at: number }[];
  /** When the bot last sent a DM in this chat (0 = never). Used to tell a live back-and-forth from a cold message. */
  lastBotAt: number;
}

/**
 * Josh's order labels. Instagram's own DM labels (Paid, Booked...) can't be set through Meta's API,
 * so the bot keeps the same list itself and shows it on the admin page.
 * PAID = paid online (Stripe, or Josh marked the Cash App / Apple Pay as received). BOOKED = locked in, pays on pickup/delivery.
 */
export type OrderLabelKind = "PAID" | "BOOKED";

export interface OrderLabel {
  id: string;
  userId: string;
  username?: string;
  label: OrderLabelKind;
  summary: string;
  total: number;
  /** cash, cash app, apple pay, stripe */
  payment: string;
  /** "pickup 2026-11-14 3:00 PM" etc. */
  when: string;
  createdAt: number;
  /** Exact sheet lines, so stock can go back on the sheet if the order is cancelled. */
  lines?: { name: string; variant?: string; size?: string; qty: number }[];
  fulfillment?: "pickup" | "delivery" | "ship";
  shipTo?: ShipTo;
  deliveryFee?: number;
  /** One-way drive minutes for a local delivery (reschedules re-check the delivery window). */
  deliveryMinutes?: number;
  shipping?: number;
  /** What Josh paid for the items, if the sheet has costs. */
  cost?: number;
  /** Already written to the sales tracker. */
  logged?: boolean;
  /** Buyer said they sent the money (Cash App / Zelle). Josh still has to check. */
  saysPaid?: string;
  /** The matching booking in the Triangle CRM. */
  crmId?: string;
  /**
   * Orders the CRM doesn't own: whether the pieces are off BOT STOCK. false = booked but unpaid, nothing held yet
   * (stock comes off when it's paid or done). Missing = an order from before that rule, when stock came off at booking.
   */
  stockHeld?: boolean;
  /** Google Calendar event id (to move it on a reschedule, delete it on a cancel). */
  calendarId?: string;
}

export interface ShipTo {
  name: string;
  street: string;
  apt?: string;
  city: string;
  state: string;
  zip: string;
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
  labels?: OrderLabel[];
  /** Last CRM change the bot applied (CRM -> bot sync). */
  crmCursor?: number;
  /** Last team notification the bot posted. */
  notifyCursor?: number;
  /** Last day the end-of-day wrap-up was posted. */
  wrapUpDay?: string;
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
  private labels: OrderLabel[] = [];
  /** Last CRM change applied by the bot. undefined = never synced (start from the newest). */
  private cursor: number | undefined;
  private nCursor: number | undefined;
  private wrapDay: string | undefined;
  /** Called after anything worth saving changes (the file saver listens here). */
  onChange?: () => void;

  constructor(private now: () => number = Date.now) {}

  private changed(): void {
    this.onChange?.();
  }

  private get(userId: string): Conversation {
    let c = this.convos.get(userId);
    if (!c) {
      c = { turns: [], pausedUntil: 0, lastActivity: this.now(), recentBotTexts: [], lastBotAt: 0 };
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
      labels: this.labels,
      ...(this.cursor !== undefined ? { crmCursor: this.cursor } : {}),
      ...(this.nCursor !== undefined ? { notifyCursor: this.nCursor } : {}),
      ...(this.wrapDay ? { wrapUpDay: this.wrapDay } : {}),
    };
  }

  crmCursor(): number | undefined {
    return this.cursor;
  }

  wrapUpDay(): string | undefined {
    return this.wrapDay;
  }

  setWrapUpDay(day: string): void {
    this.wrapDay = day;
    this.changed();
  }

  notifyCursor(): number | undefined {
    return this.nCursor;
  }

  setNotifyCursor(n: number): void {
    if (n === this.nCursor) return;
    this.nCursor = n;
    this.changed();
  }

  setCrmCursor(n: number): void {
    if (n === this.cursor) return;
    this.cursor = n;
    this.changed();
  }

  restore(snap: StoreSnapshot | undefined): void {
    if (!snap || snap.version !== 1) return;
    if (typeof snap.crmCursor === "number") this.cursor = snap.crmCursor;
    if (typeof snap.notifyCursor === "number") this.nCursor = snap.notifyCursor;
    if (typeof snap.wrapUpDay === "string") this.wrapDay = snap.wrapUpDay;
    for (const c of snap.convos ?? []) {
      this.convos.set(c.userId, { turns: c.turns ?? [], pausedUntil: c.pausedUntil ?? 0, lastActivity: c.lastActivity ?? this.now(), recentBotTexts: [], lastBotAt: 0, pendingLink: c.pendingLink });
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
    this.labels = (snap.labels ?? []).filter((l) => l && l.id && (l.label === "PAID" || l.label === "BOOKED"));
  }

  // ---- order labels (PAID / BOOKED) ----

  getLabel(id: string): OrderLabel | undefined {
    return this.labels.find((l) => l.id === id);
  }

  updateLabel(id: string, patch: Partial<OrderLabel>): void {
    const l = this.labels.find((x) => x.id === id);
    if (!l) return;
    Object.assign(l, patch);
    this.changed();
  }

  /** The newest open label for a buyer (for "I sent it" messages). */
  latestLabelFor(userId: string): OrderLabel | undefined {
    return this.allLabels().find((l) => l.userId === userId);
  }

  pendingLink(userId: string): PendingLink | undefined {
    return this.convos.get(userId)?.pendingLink;
  }

  addLabel(l: Omit<OrderLabel, "id" | "createdAt" | "username">): OrderLabel {
    const createdAt = this.now();
    const label: OrderLabel = { ...l, id: `${l.userId}-${createdAt}-${this.labels.length}`, createdAt, username: this.customers.get(l.userId)?.username };
    this.labels.push(label);
    this.changed();
    return label;
  }

  /** Newest first. Usernames are filled in late (the lookup runs in the background). */
  allLabels(): OrderLabel[] {
    return [...this.labels]
      .map((l) => ({ ...l, username: l.username ?? this.customers.get(l.userId)?.username }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** BOOKED -> PAID once Josh has the money. */
  markLabelPaid(id: string): boolean {
    const l = this.labels.find((x) => x.id === id);
    if (!l || l.label === "PAID") return false;
    l.label = "PAID";
    this.changed();
    return true;
  }

  /** Order fulfilled: take the label off. */
  clearLabel(id: string): boolean {
    const before = this.labels.length;
    this.labels = this.labels.filter((l) => l.id !== id);
    if (this.labels.length !== before) this.changed();
    return this.labels.length !== before;
  }

  clearAllLabels(): number {
    const n = this.labels.length;
    this.labels = [];
    if (n) this.changed();
    return n;
  }

  /** Remember what the bot just sent so its own echo isn't mistaken for a team member typing. */
  recordBotMessage(userId: string, text: string, messageId?: string): void {
    if (messageId) this.botMessageIds.add(messageId);
    const c = this.get(userId);
    c.lastBotAt = this.now();
    c.recentBotTexts.push({ text, at: this.now() });
    c.recentBotTexts = c.recentBotTexts.filter((t) => this.now() - t.at < 5 * 60 * 1000);
  }

  /** When the bot last DM'd this person (0 = never, or not since a restart). */
  lastBotAt(userId: string): number {
    return this.convos.get(userId)?.lastBotAt ?? 0;
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

  /** After the pause length is shortened, cut any longer pause that's still running down to the new length. */
  capPauses(hours: number): number {
    const max = this.now() + hours * 60 * 60 * 1000;
    let n = 0;
    for (const c of this.convos.values()) {
      if (c.pausedUntil > max) {
        c.pausedUntil = max;
        n++;
      }
    }
    if (n) this.changed();
    return n;
  }

  unpauseAll(): number {
    const ids = this.pausedChats();
    for (const id of ids) this.convos.get(id)!.pausedUntil = 0;
    if (ids.length) this.changed();
    return ids.length;
  }

  /** The bot is back on in this chat. */
  unpause(userId: string): void {
    const c = this.convos.get(userId);
    if (c && c.pausedUntil) {
      c.pausedUntil = 0;
      this.changed();
    }
  }

  isPaused(userId: string): boolean {
    return (this.convos.get(userId)?.pausedUntil ?? 0) > this.now();
  }

  /** The latest unpaid payment link in a chat. A new link replaces the old one. */
  setPendingLink(userId: string, link: PendingLink): void {
    this.get(userId).pendingLink = { ...link, followedUp: false };
    this.changed();
  }

  /** A quoted buyer's "went quiet" clock restarts every time the bot messages them. */
  touchQuote(userId: string, at: number): void {
    const l = this.convos.get(userId)?.pendingLink;
    if (l && !l.url && !l.followedUp) {
      l.createdAt = at;
      this.changed();
    }
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
