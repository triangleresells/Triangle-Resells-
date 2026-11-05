/**
 * Pickup hours, taken pickup times, and the 7pm ET ship cutoff.
 * Taken times come from Josh's Google Calendar (the same Apps Script web app that saves paid orders):
 * any timed event on that calendar blocks those pickup times. An all-day event with "closed" in its title closes the day.
 */

export const TIME_ZONE = "America/New_York";
export const PICKUP_OPEN_MIN = 10 * 60; // 10:00 AM
export const PICKUP_CLOSE_MIN = 22 * 60; // 10:00 PM
export const PICKUP_SLOT_MIN = 30;
export const SHIP_CUTOFF_MIN = 19 * 60; // 7:00 PM

export interface BusyBlock {
  /** ISO timestamps. */
  start: string;
  end: string;
  allDay?: boolean;
  title?: string;
}

/** Date (YYYY-MM-DD) and minutes after midnight in North Carolina for a moment in time. */
export function etParts(at: Date): { date: string; minutes: number } {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (t: string) => f.find((p) => p.type === t)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

/** The moment that is `minutes` after midnight on `date` in North Carolina. */
export function etToDate(date: string, minutes: number): Date {
  const [y, m, d] = date.split("-").map(Number);
  let guess = Date.UTC(y, m - 1, d, 0, minutes);
  for (let i = 0; i < 2; i++) {
    const p = etParts(new Date(guess));
    const diff = (Date.UTC(y, m - 1, d, 0, minutes) - Date.UTC(...ymd(p.date), 0, p.minutes)) / 60000;
    guess += diff * 60000;
  }
  return new Date(guess);
}

function ymd(date: string): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number);
  return [y, m - 1, d];
}

export function addDays(date: string, days: number): string {
  const t = new Date(Date.UTC(...ymd(date)) + days * 86_400_000);
  return t.toISOString().slice(0, 10);
}

/** "3pm", "3:30 PM", "15:00" → minutes after midnight. A bare 1-9 means PM. */
export function parseTime(s: string | undefined): number | undefined {
  const t = (s ?? "").trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?$/);
  if (!t) return undefined;
  let h = Number(t[1]);
  const min = Number(t[2] ?? 0);
  if (h > 23 || min > 59) return undefined;
  const ap = t[3]?.[0];
  if (ap === "p" && h < 12) h += 12;
  if (ap === "a" && h === 12) h = 0;
  if (!ap && h >= 1 && h < 10) h += 12; // pickups run 10 AM to 10 PM, so a bare "9" is 9 PM
  return h * 60 + min;
}

export function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

function formatDay(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

/** Taken pickup windows on one day, as minute ranges. A "closed" all-day event closes the whole day. */
function takenOn(date: string, busy: BusyBlock[]): { closed: boolean; ranges: [number, number][] } {
  const dayStart = etToDate(date, 0).getTime();
  const dayEnd = etToDate(addDays(date, 1), 0).getTime();
  let closed = false;
  const ranges: [number, number][] = [];
  for (const b of busy) {
    const s = new Date(b.start).getTime();
    const e = new Date(b.end).getTime();
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= dayStart || s >= dayEnd) continue;
    if (b.allDay) {
      if (/closed/i.test(b.title ?? "")) closed = true;
      continue; // ship-day events and reminders don't block pickups
    }
    ranges.push([Math.max(0, (s - dayStart) / 60000), Math.min(24 * 60, (e - dayStart) / 60000)]);
  }
  return { closed, ranges: ranges.sort((a, b) => a[0] - b[0]) };
}

/** Why a pickup can't happen at this date and time, or undefined if it's open. */
export function pickupProblem(date: string, time: string | undefined, busy: BusyBlock[], now = new Date()): string | undefined {
  const minutes = parseTime(time);
  if (minutes === undefined) return "pickups need a time like 3:00 PM";
  if (minutes < PICKUP_OPEN_MIN || minutes > PICKUP_CLOSE_MIN - PICKUP_SLOT_MIN) {
    return `pickups are 10 AM to 10 PM (last pickup ${formatTime(PICKUP_CLOSE_MIN - PICKUP_SLOT_MIN)})`;
  }
  const today = etParts(now);
  if (date < today.date || (date === today.date && minutes < today.minutes)) return "that time already passed";
  const day = takenOn(date, busy);
  if (day.closed) return `pickups are closed on ${formatDay(date)}`;
  const end = minutes + PICKUP_SLOT_MIN;
  if (day.ranges.some(([s, e]) => minutes < e && end > s)) return `${formatTime(minutes)} on ${formatDay(date)} is already taken`;
  return undefined;
}

/** The pickup schedule as text for the AI: hours plus taken times for the next week. */
export function scheduleText(busy: BusyBlock[], now = new Date(), days = 7): string {
  const today = etParts(now).date;
  const lines = [
    "Pickups: every day 10:00 AM to 10:00 PM ET, 30 minutes each (last pickup 9:30 PM). Only offer open times. Never offer or accept a time listed as taken.",
  ];
  const taken: string[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(today, i);
    const day = takenOn(date, busy);
    if (day.closed) taken.push(`${formatDay(date)} (${date}): CLOSED, no pickups`);
    else if (day.ranges.length) {
      taken.push(`${formatDay(date)} (${date}): ${day.ranges.map(([s, e]) => `${formatTime(s)}-${formatTime(e)}`).join(", ")}`);
    }
  }
  lines.push(taken.length ? `Taken times:\n${taken.join("\n")}` : "Taken times: none yet.");
  return lines.join("\n");
}

/** Shipped orders go out the day they're paid if paid before 7pm ET, otherwise the next day (never before the date picked). */
export function shipDateFor(fulfillDate: string, paidAt: Date): string {
  const p = etParts(paidAt);
  const earliest = p.minutes < SHIP_CUTOFF_MIN ? p.date : addDays(p.date, 1);
  return fulfillDate && fulfillDate > earliest ? fulfillDate : earliest;
}

/** Reads taken times from the Google Apps Script web app (GET), cached for 5 minutes. */
export class BusyCalendar {
  private cached: BusyBlock[] = [];
  private fetchedAt = 0;

  constructor(
    private url: string,
    private fetchFn: typeof fetch = fetch,
    private cacheMs = 5 * 60 * 1000,
  ) {}

  async get(): Promise<BusyBlock[]> {
    if (!this.url) return [];
    if (Date.now() - this.fetchedAt < this.cacheMs) return this.cached;
    try {
      const res = await this.fetchFn(`${this.url}${this.url.includes("?") ? "&" : "?"}busy=14`, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { busy?: BusyBlock[] };
      this.cached = Array.isArray(body.busy) ? body.busy : [];
      this.fetchedAt = Date.now();
    } catch (err) {
      console.error("[schedule] could not load taken times, using last copy:", err);
    }
    return this.cached;
  }
}
