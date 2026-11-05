import type { Notifier } from "./handoff.js";
import type { PaidOrder } from "./stripe.js";

export interface CalendarEvent {
  title: string;
  /** YYYY-MM-DD */
  date: string;
  /** "3:00 PM", or empty for an all-day event. */
  time: string;
  durationMinutes: number;
  timeZone: string;
  location: string;
  description: string;
}

export type CalendarPoster = (event: CalendarEvent) => Promise<void>;

export function calendarEventFor(o: PaidOrder, warehouseAddress: string): CalendarEvent {
  const who = o.buyerName || "IG buyer";
  const pickup = o.fulfillment === "pickup";
  const delivery = o.fulfillment === "delivery";
  // "DELIVERY 35min" lets the bot read routes back and keep the farthest drop first.
  const kind = pickup
    ? "🔺 PICKUP"
    : delivery
      ? `🚗 DELIVERY ${o.deliveryMinutes ?? "?"}min ${o.deliveryArea ?? ""}`.trim()
      : "📦 SHIP";
  const title = `${o.test ? "[TEST] " : ""}${kind}: ${who} – $${o.total}`;
  const description = [
    `Items: ${o.summary}`,
    `Paid: $${o.total} via Stripe (session ${o.sessionId})`,
    `Buyer: ${who}${o.buyerEmail ? `, ${o.buyerEmail}` : ""}${o.buyerPhone ? `, ${o.buyerPhone}` : ""}`,
    `Instagram user id: ${o.igUserId} (${o.account})`,
    pickup
      ? "Hold these items until pickup. Already paid."
      : delivery
        ? `Deliver to the address in the location field (~${o.deliveryMinutes ?? "?"} min drive). Already paid. Farthest drops go first.`
        : o.buyerLabel ? "10+ pieces: wait for the buyer's label, then ship." : "Ship via UPS before 7pm ET and send tracking.",
  ].join("\n");
  return {
    title,
    date: o.fulfillDate,
    time: pickup || delivery ? o.fulfillTime : "",
    durationMinutes: 30,
    timeZone: "America/New_York",
    location: pickup ? warehouseAddress || "Warehouse" : o.shipTo || "Ship (address in Stripe)",
    description,
  };
}

/** Posts the event to a Google Apps Script web app (see README) that writes it to Google Calendar. */
export function webhookCalendar(url: string, fetchFn: typeof fetch = fetch): CalendarPoster {
  return async (event) => {
    if (!url) {
      console.log(`[calendar] (no CALENDAR_WEBHOOK_URL set) ${event.title} on ${event.date} ${event.time}`);
      return;
    }
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
      redirect: "follow",
    });
    if (!res.ok) console.error(`[calendar] webhook failed: HTTP ${res.status}`);
  };
}

export interface OrderHandlerDeps {
  sendDm: (igUserId: string, text: string) => Promise<void>;
  calendar: CalendarPoster;
  notify: Notifier;
  warehouseAddress: string;
  accountName: string;
}

export function confirmationText(o: PaidOrder, warehouseAddress: string): string {
  const when = [o.fulfillDate && formatDate(o.fulfillDate), o.fulfillTime].filter(Boolean).join(" at ");
  if (o.fulfillment === "delivery") {
    return `paid ✅ appreciate you! your delivery is set${when ? ` for ${when}` : ""}. I'll message you here when I'm on the way.`;
  }
  if (o.fulfillment === "ship") {
    return o.buyerLabel
      ? `paid ✅ appreciate you! send your UPS label here and we'll get it shipped${when ? ` ${when}` : ""}.`
      : `paid ✅ appreciate you! it ships${when ? ` ${when}` : " today or tomorrow"} via UPS, tracking coming once it's out.`;
  }
  const where = warehouseAddress ? ` pull up to ${warehouseAddress}` : " I'll send the address shortly";
  return `paid ✅ appreciate you! your order's held for you${when ? ` for ${when}` : ""}.${where}.`;
}

function formatDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

/** What happens after Stripe says a bot order is paid. Each step runs even if another fails. */
export async function handlePaidOrder(o: PaidOrder, d: OrderHandlerDeps): Promise<void> {
  const steps: [string, () => Promise<void>][] = [
    ["dm", () => d.sendDm(o.igUserId, confirmationText(o, d.warehouseAddress))],
    ["calendar", () => d.calendar(calendarEventFor(o, d.warehouseAddress))],
    [
      "team alert",
      () =>
        d.notify({
          account: d.accountName,
          userId: o.igUserId,
          route: "team",
          paused: false,
          reason: `PAID $${o.total} – ${o.fulfillment} ${o.fulfillDate} ${o.fulfillTime}`.trim(),
          summary: `${o.summary}. Buyer: ${o.buyerName ?? "?"}${o.shipTo ? `. Ship to: ${o.shipTo}` : ""}. Log the sale and take these off the stock sheet.`,
        }),
    ],
  ];
  for (const [name, run] of steps) {
    try {
      await run();
    } catch (err) {
      console.error(`[orders] ${name} failed for ${o.sessionId}:`, err);
    }
  }
}
