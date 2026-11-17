/**
 * Bot reliability: failed Instagram sends, one alert per outage, the "Sorry for the wait!" catch-up after it,
 * the daily health push, and the access-token expiry warning. Channel-agnostic: nothing here knows about Instagram
 * except isRecipientError (which errors are about one buyer, not an outage).
 *
 * Writes go to `bot_send_log` and `notifications` (phone pushes to Josh, Chema and Diego) with the Supabase service
 * key. Everything is best effort: a logging problem never breaks a reply.
 */
import type { Pusher } from "./pushalerts.js";

export type SendLogKind = "send_failed" | "recipient_rejected" | "outage_started" | "outage_ended" | "catch_up_sent";

export interface DayHealth {
  day: string;
  messages_handled: number;
  buyers: number;
  failed_sends: number;
  outages: number;
  handoffs: number;
  /** Section 10 (not tracked yet when missing). */
  hot_buyers?: number;
  payments?: number;
  conversion_intent?: number | null;
  conversion_all?: number | null;
}

export interface HealthDb {
  log(row: { account: string; kind: SendLogKind; ig_user_id?: string; error?: string; is_test?: boolean }): Promise<void>;
  /** When the latest outage started, if it hasn't ended (so a restart doesn't alert twice). */
  openOutageSince(account: string): Promise<number | undefined>;
  dayHealth(day: string, tz: string, account?: string): Promise<DayHealth>;
}

export function supabaseHealthDb(supabaseUrl: string, serviceKey: string, fetchFn: typeof fetch = fetch): HealthDb {
  const base = supabaseUrl.trim().replace(/\/+$/, "").replace(/\/rest\/v1$/i, "").replace(/\/+$/, "") + "/rest/v1";
  const headers = (prefer?: string): Record<string, string> => ({
    apikey: serviceKey,
    ...(serviceKey.startsWith("sb_") ? {} : { Authorization: `Bearer ${serviceKey}` }),
    "Content-Type": "application/json",
    ...(prefer ? { Prefer: prefer } : {}),
  });
  const req = async (path: string, init: RequestInit) => {
    const res = await fetchFn(`${base}${path}`, init);
    if (!res.ok) throw new Error(`health HTTP ${res.status} on ${path.split("?")[0]}`);
    return res;
  };
  return {
    async log(row) {
      await req("/bot_send_log", { method: "POST", headers: headers("return=minimal"), body: JSON.stringify({ ...row, error: row.error?.slice(0, 500) }) }).catch((err) =>
        console.error("[health] send log failed:", (err as Error).message ?? err),
      );
    },
    async openOutageSince(account) {
      try {
        const res = await req(
          `/bot_send_log?account=eq.${encodeURIComponent(account)}&kind=in.(outage_started,outage_ended)&is_test=eq.false&select=kind,created_at&order=created_at.desc&limit=1`,
          { method: "GET", headers: headers() },
        );
        const rows = (await res.json()) as { kind: string; created_at: string }[];
        return rows[0]?.kind === "outage_started" ? Date.parse(rows[0].created_at) : undefined;
      } catch (err) {
        console.error("[health] reading the last outage failed:", (err as Error).message ?? err);
        return undefined;
      }
    },
    async dayHealth(day, tz, account) {
      const res = await req("/rpc/bot_daily_health", { method: "POST", headers: headers(), body: JSON.stringify({ p_day: day, p_tz: tz, p_account: account ?? null }) });
      return (await res.json()) as DayHealth;
    },
  };
}

/**
 * Instagram errors about ONE buyer, not the bot: outside the 24-hour window (code 10 / subcode 2018278), the user
 * can't be reached (551), or no such user (2018001, 2534014). Those are logged but don't start an outage.
 */
export function isRecipientError(message: string): boolean {
  const code = Number(/"code"\s*:\s*(\d+)/.exec(message)?.[1]);
  const sub = Number(/"error_subcode"\s*:\s*(\d+)/.exec(message)?.[1]);
  return (code === 10 && sub === 2018278) || code === 551 || sub === 2018001 || sub === 2534014 || sub === 1545041;
}

/**
 * Watches every send. First failure after a working send = an outage: logged, ONE push to the team. More failures in
 * the same outage are logged only. The first success after it ends the outage and returns the buyers whose replies
 * were dropped, so the bot can answer them (inside the 24h window) with "Sorry for the wait!".
 */
export class SendWatch {
  private outageSince?: number;
  private dropped = new Map<string, number>();
  private restored?: Promise<void>;

  constructor(private d: { account: string; db?: HealthDb; push?: Pusher; now?: () => number }) {}

  private now(): number {
    return this.d.now ? this.d.now() : Date.now();
  }

  /** After a restart: an outage still open in the log stays open (no second alert). */
  private restore(): Promise<void> {
    this.restored ??= (async () => {
      const since = await this.d.db?.openOutageSince(this.d.account);
      if (since !== undefined && this.outageSince === undefined) this.outageSince = since;
    })();
    return this.restored;
  }

  inOutage(): boolean {
    return this.outageSince !== undefined;
  }

  /** Buyers whose reply was dropped in the current outage, most recent first. */
  droppedBuyers(): string[] {
    return [...this.dropped].sort((a, b) => b[1] - a[1]).map(([u]) => u);
  }

  async failed(userId: string, err: unknown, isTest = false): Promise<void> {
    await this.restore();
    const error = String((err as Error)?.message ?? err).slice(0, 500);
    if (isRecipientError(error)) {
      await this.d.db?.log({ account: this.d.account, kind: "recipient_rejected", ig_user_id: userId, error, is_test: isTest });
      return;
    }
    await this.d.db?.log({ account: this.d.account, kind: "send_failed", ig_user_id: userId, error, is_test: isTest });
    if (isTest) return; // test buyers never start a real outage
    this.dropped.set(userId, this.now());
    if (this.outageSince !== undefined) return; // already alerted for this outage
    this.outageSince = this.now();
    await this.d.db?.log({ account: this.d.account, kind: "outage_started", ig_user_id: userId, error });
    await this.d.push?.({
      type: "bot_outage",
      title: `🚨 @${this.d.account}: Instagram is rejecting the bot's replies`,
      body: `Buyers aren't getting answers. Instagram said: ${error.slice(0, 220)}\nUsually the access token: check it in Meta, then update IG_ACCESS_TOKEN on Render. You get this once per outage.`,
      priority: "urgent",
      dedupe_key: `outage:${this.d.account}:${this.outageSince}`,
    }).catch((e) => console.error("[health] outage push failed:", (e as Error).message ?? e));
  }

  /** A send worked. Ends an open outage and returns the buyers to catch up on ([] when there was no outage). */
  async succeeded(): Promise<string[]> {
    await this.restore();
    if (this.outageSince === undefined) return [];
    const since = this.outageSince;
    this.outageSince = undefined;
    const back = this.droppedBuyers();
    this.dropped.clear();
    const mins = Math.round((this.now() - since) / 60_000);
    await this.d.db?.log({ account: this.d.account, kind: "outage_ended", error: `lasted ${mins} min, ${back.length} buyer(s) to catch up` });
    await this.d.push?.({
      type: "bot_outage",
      title: `✅ @${this.d.account}: the bot can send again`,
      body: `Down about ${mins} min. ${back.length ? `Answering ${back.length} buyer(s) still inside Instagram's 24h window.` : ""} Check Chats for anyone older than 24h: only you can reach them.`,
      priority: "normal",
      dedupe_key: `outage-end:${this.d.account}:${since}`,
    }).catch((e) => console.error("[health] recovery push failed:", (e as Error).message ?? e));
    return back;
  }

  async caughtUp(userId: string): Promise<void> {
    await this.d.db?.log({ account: this.d.account, kind: "catch_up_sent", ig_user_id: userId });
  }
}

/** Local date (YYYY-MM-DD) and minutes after midnight in a time zone. */
export function localClock(at: number, tz: string): { date: string; minutes: number } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(at))
      .map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "00:00" / "9:30" -> minutes after midnight. */
export function parseClock(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`Not a time (HH:MM): "${hhmm}"`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function healthText(account: string, h: DayHealth): string {
  const day = new Date(`${h.day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  const pct = (x: number | null | undefined) => (x === null || x === undefined ? "not tracked yet" : `${(x * 100).toFixed(1)}%`);
  const n = (x: number | undefined) => (x === undefined ? "not tracked yet" : String(x));
  return [
    `@${account}, ${day}`,
    `Messages handled: ${h.messages_handled} from ${h.buyers} buyer(s)`,
    `Failed sends: ${h.failed_sends}${h.outages ? ` (${h.outages} outage${h.outages > 1 ? "s" : ""})` : ""}`,
    `Handoffs to the team: ${h.handoffs}`,
    `Hot buyers flagged: ${n(h.hot_buyers)}`,
    `Payments through the bot: ${n(h.payments)}`,
    `Payment conversion: ${pct(h.conversion_intent)} of buyers who showed intent, ${pct(h.conversion_all)} of all new chats`,
  ].join("\n");
}

export interface HealthClockDeps {
  account: string;
  db: HealthDb;
  push: Pusher;
  /** Time zone for the summary and token alerts (default America/New_York). */
  tz: string;
  /** When the daily summary goes out, HH:MM local (default 00:00). Before noon it covers the day that just ended. */
  summaryAt: string;
  /** The access token's expiry date (YYYY-MM-DD), from config or read from Meta. Undefined = never expires / unknown. */
  tokenExpiry: () => Promise<string | undefined>;
  /** Alert times (HH:MM local) on the day 3 days before expiry. */
  tokenAlertTimes: string[];
  now?: () => number;
}

/** Runs every minute: the daily health push and the token-expiry warnings. Each push has a dedupe key (no repeats). */
export class HealthClock {
  private summaryDone = "";
  private tokenDone = new Set<string>();

  constructor(private d: HealthClockDeps) {
    parseClock(d.summaryAt);
    d.tokenAlertTimes.forEach(parseClock);
  }

  async tick(): Promise<void> {
    const now = this.d.now ? this.d.now() : Date.now();
    const { date, minutes } = localClock(now, this.d.tz);
    await this.summary(date, minutes).catch((err) => console.error("[health] daily summary failed:", (err as Error).message ?? err));
    await this.token(date, minutes).catch((err) => console.error("[health] token check failed:", (err as Error).message ?? err));
  }

  private async summary(date: string, minutes: number): Promise<void> {
    const at = parseClock(this.d.summaryAt);
    if (minutes < at) return;
    const day = at < 12 * 60 ? addDays(date, -1) : date;
    if (this.summaryDone === day) return;
    const h = await this.d.db.dayHealth(day, this.d.tz, this.d.account);
    await this.d.push({ type: "bot_health", title: "📊 Bot daily health", body: healthText(this.d.account, h), priority: "normal", dedupe_key: `bot-health:${this.d.account}:${day}` });
    this.summaryDone = day;
  }

  private async token(date: string, minutes: number): Promise<void> {
    const expiry = await this.d.tokenExpiry();
    if (!expiry || addDays(expiry, -3) !== date) return;
    for (const slot of this.d.tokenAlertTimes) {
      const key = `token-expiry:${this.d.account}:${expiry}:${slot}`;
      if (minutes < parseClock(slot) || this.tokenDone.has(key)) continue;
      await this.d.push({
        type: "token_expiry",
        title: `⚠️ @${this.d.account}: Instagram token expires in 3 days`,
        body: `It expires ${expiry}. After that the bot can't reply to anyone. Make a new token in Meta, put it in IG_ACCESS_TOKEN on Render and redeploy (and update IG_TOKEN_EXPIRES_ON).`,
        priority: "high",
        dedupe_key: key,
      });
      this.tokenDone.add(key);
    }
  }
}
