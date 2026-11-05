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

interface Conversation {
  turns: ChatTurn[];
  pausedUntil: number;
  lastActivity: number;
  recentBotTexts: { text: string; at: number }[];
}

const MAX_TURNS = 20;
const CONVO_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const SEEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * In-memory conversation state. Resets when the server restarts, which is fine:
 * the bot just loses older context and any active pauses.
 */
export class Store {
  private convos = new Map<string, Conversation>();
  private seen = new Map<string, number>();
  private botMessageIds = new Set<string>();

  constructor(private now: () => number = Date.now) {}

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
  }

  isPaused(userId: string): boolean {
    return (this.convos.get(userId)?.pausedUntil ?? 0) > this.now();
  }

  /** Drop old conversations and dedupe ids so memory doesn't grow forever. */
  cleanup(): void {
    const t = this.now();
    for (const [id, c] of this.convos) if (t - c.lastActivity > CONVO_TTL_MS) this.convos.delete(id);
    for (const [id, at] of this.seen) if (t - at > SEEN_TTL_MS) this.seen.delete(id);
    if (this.botMessageIds.size > 5000) this.botMessageIds.clear();
  }
}
