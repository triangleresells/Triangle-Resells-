/**
 * End of day (10 PM Eastern): one post to the team's Discord / Slack with what got done today and what's still open,
 * so nothing gets forgotten. It never marks anything Done itself: the team tells the assistant what was fulfilled
 * (and approves), and only then it goes in revenue and the sales tracker.
 */
import type { CrmBookingFull } from "../crm.js";
import type { TextPoster } from "../handoff.js";
import type { Store } from "../store.js";
import { summaryOf, to12h } from "../crmsync.js";

const money = (n: number) => `$${Number(n).toFixed(2).replace(/\.00$/, "")}`;

export function wrapUpText(day: string, bookings: CrmBookingFull[]): string | null {
  const real = bookings.filter((b) => !b.is_test && b.date === day);
  if (!real.length) return null;
  const done = real.filter((b) => b.status === "done");
  const open = real.filter((b) => ["booked", "paid", "paid_needs_check"].includes(b.status));
  const red = real.filter((b) => b.status === "cancelled" || b.status === "no_show");
  const label = new Date(`${day}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const who = (b: CrmBookingFull) => (b.customer?.ig_handle ? `@${b.customer.ig_handle}` : (b.customer?.name ?? "buyer"));
  const lines = [`🌙 Wrap-up for ${label}: ${done.length} sale${done.length === 1 ? "" : "s"} done, ${money(done.reduce((t, b) => t + Number(b.sale_price), 0))}.`];
  if (open.length) {
    lines.push(`Still open (${open.length}): tell the assistant which were fulfilled so they go in revenue and the tracker, or mark them No-show:`);
    for (const b of open) lines.push(`- ${who(b)}${b.time ? ` ${to12h(b.time)}` : ""} ${b.fulfillment}, ${summaryOf(b)}, ${money(Number(b.sale_price))}${b.assignee ? ` (${b.assignee})` : ""}`);
  } else {
    lines.push("Nothing left open for today.");
  }
  if (red.length) lines.push(`Cancelled / no-show: ${red.length}.`);
  return lines.join("\n");
}

export class WrapUp {
  constructor(private d: { crm: { bookingsBetween(from: string, to: string): Promise<CrmBookingFull[]> }; store: Store; post: TextPoster; now?: () => Date }) {}

  /** Posts today's wrap-up once, at or after 10 PM Eastern. Returns true if it posted. Never throws. */
  async tick(): Promise<boolean> {
    const now = this.d.now?.() ?? new Date();
    const et = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
    const part = (t: string) => et.find((p) => p.type === t)!.value;
    const day = `${part("year")}-${part("month")}-${part("day")}`;
    const minutes = (Number(part("hour")) % 24) * 60 + Number(part("minute"));
    if (minutes < 22 * 60 || this.d.store.wrapUpDay() === day) return false;
    try {
      const text = wrapUpText(day, await this.d.crm.bookingsBetween(day, day));
      if (text) await this.d.post(text);
      this.d.store.setWrapUpDay(day);
      return !!text;
    } catch (err) {
      console.error("[wrap-up] failed, will retry:", (err as Error).message ?? err);
      return false;
    }
  }
}
