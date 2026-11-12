/**
 * CRM -> bot. Every few seconds the bot reads the changes PEOPLE made in the CRM (its own never come back) and makes
 * its side match: the order label, the Google Calendar event and BOT STOCK. With the bot -> CRM writes in desk.ts and
 * bot.ts, the two stay in one loop. The CRM is the source of truth.
 */
import type { Crm, CrmBookingFull, CrmCustomerStats, CrmEvent } from "./crm.js";
import type { OrderDesk, OrderLine } from "./desk.js";
import type { CalendarEditor } from "./orders.js";
import type { Notifier } from "./handoff.js";
import type { OrderLabel, Store } from "./store.js";

/** "16:00:00" -> "4:00 PM". */
export function to12h(t: string | null | undefined): string | undefined {
  const m = t?.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return undefined;
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}

const PAYMENT_WORDS: Record<string, string> = { cash: "cash", cash_app: "cash app", zelle: "zelle", stripe: "stripe", apple_pay: "apple pay" };

export const linesOf = (b: CrmBookingFull): OrderLine[] =>
  b.items.map((i) => ({ name: i.item, variant: i.color ?? undefined, size: i.size, qty: i.qty, unitPrice: i.unit_price ?? undefined }));

export const summaryOf = (b: CrmBookingFull): string =>
  b.items.map((i) => `${i.qty}x ${[i.item, i.color, i.size === "One Size" ? "" : i.size].filter(Boolean).join(" ")}`).join(", ");

const sameLines = (a: OrderLine[] = [], b: OrderLine[]) =>
  a.length === b.length && a.every((x, i) => x.name === b[i].name && (x.variant ?? "") === (b[i].variant ?? "") && (x.size ?? "") === (b[i].size ?? "") && x.qty === b[i].qty);

/** What the AI is told about the buyer before it answers: their history, and their bookings (the CRM wins over the chat). */
export function crmContextText(bookings: CrmBookingFull[], customer?: CrmCustomerStats | null): string {
  const history =
    customer && customer.orders > 0
      ? `\n\nREPEAT BUYER: ${customer.orders} past order${customer.orders === 1 ? "" : "s"}, $${customer.total_spent} total${customer.last_order ? `, last on ${customer.last_order}` : ""}. Treat them like a regular (warm, no need to explain how it works again).`
      : "";
  if (!bookings.length) return history;
  const rows = bookings.map((b) => {
    const day = new Date(`${b.date}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    const status = b.status === "paid_needs_check" ? "says they paid, Josh checking" : b.status;
    return `- ${day}${b.time ? ` ${to12h(b.time)}` : ""}, ${b.fulfillment}, ${summaryOf(b)}, $${b.sale_price}, ${status}`;
  });
  return history + `\n\nTHIS BUYER'S BOOKINGS IN THE CRM (the team's system, always current: if the chat says something different, the team changed it and the CRM is right):\n${rows.join("\n")}`;
}

export interface CrmSyncDeps {
  crm: Crm;
  store: Store;
  desk: Pick<OrderDesk, "adopt" | "cancel" | "markPaid" | "done" | "replaceLines">;
  calendarEdit?: CalendarEditor;
  /** Apply changes to TEST bookings too (tests only: never touch real stock for test data). */
  includeTest?: boolean;
  /** DMs the buyer (the bot's messageBuyer). "window_closed": Instagram's 24h rule, a person has to send it. */
  tellBuyer?: (igUserId: string, text: string) => Promise<"sent" | "window_closed" | "off">;
  /** Heads-up to Josh when the bot couldn't do something itself. */
  notify?: Notifier;
  accountName?: string;
}

export class CrmSync {
  private running = false;
  constructor(private d: CrmSyncDeps) {}

  /** Applies every new CRM change in order. Returns how many it read. Never throws. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const cursor = this.d.store.crmCursor();
      if (cursor === undefined) {
        // First run: start from now. Older bookings were already handled by whoever made them.
        const { latest } = await this.d.crm.events(null);
        this.d.store.setCrmCursor(latest);
        return 0;
      }
      const { events } = await this.d.crm.events(cursor);
      for (const e of events) {
        try {
          if (!e.is_test || this.d.includeTest) await this.apply(e);
        } catch (err) {
          console.error(`[crm-sync] change #${e.id} (${e.kind} by ${e.actor}) failed:`, err);
        }
        this.d.store.setCrmCursor(e.id);
      }
      return events.length;
    } catch (err) {
      console.error("[crm-sync] can't reach the CRM:", (err as Error).message ?? err);
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async sendTracking(b: CrmBookingFull, tracking: string, igUserId: string): Promise<void> {
    const text = `Your order shipped 📦 UPS tracking: ${tracking}\nhttps://www.ups.com/track?tracknum=${encodeURIComponent(tracking)}`;
    const result = this.d.tellBuyer ? await this.d.tellBuyer(igUserId, text).catch(() => "off" as const) : "off";
    if (result === "sent") {
      console.log(`[crm-sync] sent tracking ${tracking} to ${igUserId}`);
      return;
    }
    await this.d.notify?.({
      account: this.d.accountName ?? "",
      userId: igUserId,
      username: b.customer?.ig_handle ?? undefined,
      route: "josh",
      paused: false,
      reason: "📦 Send the tracking number by hand",
      summary: `${result === "window_closed" ? "Instagram only lets the bot message someone within 24 hours of their last DM" : "The bot is off"}. Tracking ${tracking} for ${summaryOf(b)}.`,
    }).catch(() => {});
  }

  private labelFor(crmId: string): OrderLabel | undefined {
    return this.d.store.allLabels().find((l) => l.crmId === crmId);
  }

  private async apply(e: CrmEvent): Promise<void> {
    const b = e.booking;
    const label = this.labelFor(b.id);

    // Cancelled, no-show, or deleted: stock back, calendar event gone, order closed.
    if (e.kind === "deleted" || b.status === "cancelled" || b.status === "no_show") {
      if (!label) return;
      if (label.calendarId) await this.d.calendarEdit?.remove(label.calendarId);
      await this.d.desk.cancel(label.id);
      console.log(`[crm-sync] ${e.actor} ${b.status === "no_show" ? "marked a no-show" : "cancelled"}: ${label.summary}`);
      return;
    }

    // Tracking number added (or changed) on a shipped order: the buyer gets it in the DMs.
    const tracking = b.tracking_number?.trim();
    const before = e.previous?.tracking_number?.trim() ?? "";
    if (b.fulfillment === "ship" && tracking && tracking !== before && b.customer?.ig_user_id) {
      await this.sendTracking(b, tracking, b.customer.ig_user_id);
    }

    // A booking the bot doesn't have yet (a person added it in the CRM, or undid a cancel): take it on.
    if (!label) {
      const adopted = await this.d.desk.adopt({
        crmId: b.id,
        userId: b.customer?.ig_user_id ?? `crm:${b.id}`,
        username: b.customer?.ig_handle ?? undefined,
        lines: linesOf(b),
        summary: summaryOf(b),
        total: Number(b.sale_price) + Number(b.delivery_fee) + Number(b.shipping_fee),
        payment: PAYMENT_WORDS[b.payment_method] ?? b.payment_method,
        paid: b.status === "paid" || b.status === "done",
        fulfillment: b.fulfillment,
        date: b.date,
        time: to12h(b.time),
        location: b.location ?? undefined,
        deliveryFee: Number(b.delivery_fee) || undefined,
        shipping: Number(b.shipping_fee) || undefined,
      });
      if (b.status === "done") await this.d.desk.done(adopted.id);
      console.log(`[crm-sync] ${e.actor} added a booking: ${adopted.summary}`);
      return;
    }

    // Day or time changed: move the order and its calendar event.
    const time = to12h(b.time);
    const area = label.when.match(/\(([^)]+)\)\s*$/)?.[1];
    const when = [b.fulfillment, b.date, time, b.fulfillment === "delivery" && area ? `(${area})` : ""].filter(Boolean).join(" ");
    const moved = e.previous ? e.previous.date !== b.date || e.previous.time !== b.time : !label.when.includes(b.date);
    if (moved || label.when !== when) {
      this.d.store.updateLabel(label.id, { when, fulfillment: b.fulfillment });
      if (moved && label.calendarId) await this.d.calendarEdit?.move(label.calendarId, b.date, b.fulfillment === "ship" ? "" : (time ?? ""), 30);
    }

    // Items edited: swap the stock and the label.
    const lines = linesOf(b);
    if (!sameLines(label.lines, lines)) {
      await this.d.desk.replaceLines(label.id, lines, summaryOf(b), Number(b.sale_price) + Number(b.delivery_fee) + Number(b.shipping_fee));
    }

    // Paid (a person confirmed) -> PAID and logged; Done -> logged and closed.
    if (b.status === "paid" && label.label !== "PAID") await this.d.desk.markPaid(label.id);
    if (b.status === "done") await this.d.desk.done(label.id);
  }
}
