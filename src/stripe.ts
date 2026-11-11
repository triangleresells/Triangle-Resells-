import { createHmac, timingSafeEqual } from "node:crypto";
import { lineLabel, type Quote } from "./pricing.js";
import { shipDateFor } from "./schedule.js";
import type { ShipTo } from "./store.js";

/** One sheet line of an order (what comes off BOT STOCK when it's paid). */
export interface PaidLine {
  name: string;
  variant?: string;
  size?: string;
  qty: number;
}

/** Stripe metadata values max out at 500 chars, so the order lines are spread over order_lines_0, _1, ... */
const LINES_CHUNK = 450;

export function linesToMetadata(lines: PaidLine[]): Record<string, string> {
  const json = JSON.stringify(lines.map((l) => [l.name, l.variant ?? "", l.size ?? "", l.qty]));
  const out: Record<string, string> = {};
  for (let i = 0; i * LINES_CHUNK < json.length; i++) out[`order_lines_${i}`] = json.slice(i * LINES_CHUNK, (i + 1) * LINES_CHUNK);
  return out;
}

export function linesFromMetadata(m: Record<string, string | undefined>): PaidLine[] | undefined {
  let json = "";
  for (let i = 0; m[`order_lines_${i}`] !== undefined; i++) json += m[`order_lines_${i}`];
  if (!json) return undefined;
  try {
    return (JSON.parse(json) as [string, string, string, number][]).map(([name, variant, size, qty]) => ({
      name,
      ...(variant ? { variant } : {}),
      ...(size ? { size } : {}),
      qty: Number(qty) || 0,
    }));
  } catch {
    return undefined;
  }
}

export interface OrderDetails {
  igUserId: string;
  account: string;
  /** YYYY-MM-DD the order is handed over or shipped. Can be days after payment (paid now, held until then). */
  fulfillDate: string;
  /** e.g. "3:00 PM". Pickups only. */
  fulfillTime?: string;
  summary: string;
  /** Sheet lines, carried in the session metadata so the paid items (not the chat's latest link) come off stock. */
  lines?: PaidLine[];
  /** Marks a test checkout (metadata test_order=true). Set automatically for Stripe test-mode keys. */
  testOrder?: boolean;
}

/** Stripe test-mode keys start with sk_test_ or rk_test_. */
export function isTestKey(key: string): boolean {
  return /^(sk|rk)_test_/.test(key);
}

/** What happened to an old link we tried to cancel. "paid" = the buyer already paid it, so don't make a new one. */
export type ExpireResult = "expired" | "paid";

export interface CheckoutLink {
  id: string;
  url: string;
  expiresAt: number;
}

export interface CheckoutApi {
  create(quote: Quote, order: OrderDetails): Promise<CheckoutLink>;
  /** Kills an unpaid link so it can't be paid any more (used when the order changes). */
  expire?(sessionId: string): Promise<ExpireResult>;
}

/** Brand look for every checkout page: black background, gold buttons. */
export const BRANDING = {
  background_color: "#0B0B0B",
  button_color: "#D4A017",
  display_name: "Triangle Resells",
  border_style: "rounded",
  font_family: "montserrat",
};

/** Stripe needs a checkout link to stay open at least 30 minutes. */
export const HOLD_MINUTES = 31;

/** Turns nested objects into Stripe's form encoding: a[b][0][c]=x. */
export function toForm(obj: Record<string, unknown>, prefix = "", out = new URLSearchParams()): URLSearchParams {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === "object" ? toForm(item, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(item))));
    else if (typeof v === "object") toForm(v as Record<string, unknown>, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export function checkoutParams(quote: Quote, order: OrderDetails, successUrl: string, now = Date.now()): Record<string, unknown> {
  const line_items: Record<string, unknown>[] = quote.lines.map((l) => ({
    quantity: l.qty,
    price_data: { currency: "usd", unit_amount: Math.round(l.unitPrice * 100), product_data: { name: lineLabel(l) } },
  }));
  if (quote.shipping > 0) {
    line_items.push({
      quantity: 1,
      price_data: { currency: "usd", unit_amount: Math.round(quote.shipping * 100), product_data: { name: "UPS Shipping" } },
    });
  }
  if (quote.delivery && quote.delivery.fee > 0) {
    line_items.push({
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: Math.round(quote.delivery.fee * 100),
        product_data: { name: `Local Delivery (${quote.delivery.area})` },
      },
    });
  }
  const pickup = quote.fulfillment === "pickup";
  const message = pickup
    ? "All sales final. Pickup address sent after payment."
    : quote.fulfillment === "delivery"
      ? "All sales final. Enter the delivery address. We'll confirm your drop-off in DMs."
      : quote.buyerProvidesLabel
      ? "All sales final. Send us your shipping label after payment and we'll ship it."
      : "All sales final. Ships via UPS, tracking sent once it ships.";
  return {
    mode: "payment",
    success_url: successUrl,
    expires_at: Math.floor(now / 1000) + HOLD_MINUTES * 60,
    line_items,
    branding_settings: BRANDING,
    custom_text: { submit: { message } },
    phone_number_collection: { enabled: true },
    ...(pickup ? {} : { shipping_address_collection: { allowed_countries: ["US"] } }),
    metadata: {
      source: "ai_dm_bot",
      ig_user_id: order.igUserId,
      account: order.account,
      fulfillment: quote.fulfillment,
      fulfill_date: order.fulfillDate,
      fulfill_time: order.fulfillTime ?? "",
      buyer_label: String(quote.buyerProvidesLabel),
      ...(quote.delivery ? { delivery_area: quote.delivery.area, delivery_minutes: String(quote.delivery.minutes) } : {}),
      order_summary: order.summary.slice(0, 500),
      ...(quote.shipping > 0 ? { shipping: String(quote.shipping) } : {}),
      ...(quote.delivery && quote.delivery.fee > 0 ? { delivery_fee: String(quote.delivery.fee) } : {}),
      ...(order.lines ? linesToMetadata(order.lines) : {}),
      ...(order.testOrder ? { test_order: "true" } : {}),
    },
  };
}

export class StripeCheckout implements CheckoutApi {
  constructor(
    private secretKey: string,
    private successUrl: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  async create(quote: Quote, order: OrderDetails): Promise<CheckoutLink> {
    const res = await this.fetchFn("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: toForm(checkoutParams(quote, { ...order, testOrder: order.testOrder || isTestKey(this.secretKey) }, this.successUrl)).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; url?: string; expires_at?: number; error?: unknown };
    if (!res.ok || !body.url || !body.id) throw new Error(`Stripe ${res.status}: ${JSON.stringify(body.error ?? body)}`);
    return { id: body.id, url: body.url, expiresAt: body.expires_at ?? 0 };
  }

  async expire(sessionId: string): Promise<ExpireResult> {
    const auth = { Authorization: `Bearer ${this.secretKey}` };
    const url = `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`;
    const res = await this.fetchFn(`${url}/expire`, { method: "POST", headers: auth });
    if (res.ok) return "expired";
    // Stripe refuses to expire a session that's already paid or already expired: look at which one it is.
    const look = await this.fetchFn(url, { headers: auth });
    const body = (await look.json().catch(() => ({}))) as { status?: string };
    if (body.status === "complete") return "paid";
    if (body.status === "expired") return "expired";
    throw new Error(`Stripe couldn't cancel ${sessionId}: HTTP ${res.status}, status ${body.status ?? "unknown"}`);
  }
}

/** Checks the Stripe-Signature header ("t=...,v1=...") against the raw body. */
export function isValidStripeSignature(raw: Buffer, header: string | undefined, secret: string, now = Date.now(), toleranceSec = 300): boolean {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]).filter((p) => p.length === 2));
  const t = Number(parts.t);
  const sigs = header.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!t || !sigs.length || Math.abs(now / 1000 - t) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${raw.toString("utf8")}`).digest("hex");
  return sigs.some((s) => s.length === expected.length && timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

export interface PaidOrder {
  sessionId: string;
  igUserId: string;
  account: string;
  fulfillment: "pickup" | "ship" | "delivery";
  fulfillDate: string;
  deliveryArea?: string;
  deliveryMinutes?: number;
  fulfillTime: string;
  buyerLabel: boolean;
  summary: string;
  total: number;
  /** A test checkout (metadata test_order=true). */
  test?: boolean;
  buyerName?: string;
  buyerEmail?: string;
  buyerPhone?: string;
  shipTo?: string;
  /** The same address, split up for the sales tracker. */
  shipAddress?: ShipTo;
  /** Sheet lines from the session metadata. Undefined for links made before lines were sent to Stripe. */
  lines?: PaidLine[];
  shipping?: number;
  deliveryFee?: number;
}

/** Pulls a paid bot order out of a checkout.session.completed event. Returns undefined for anything else. */
export function paidOrderFromEvent(event: any): PaidOrder | undefined {
  if (event?.type !== "checkout.session.completed") return undefined;
  const s = event.data?.object;
  const m = s?.metadata ?? {};
  if (m.source !== "ai_dm_bot" || !m.ig_user_id || s.payment_status !== "paid") return undefined;
  const addr = s.collected_information?.shipping_details?.address ?? s.shipping_details?.address;
  const shipTo = addr
    ? [s.collected_information?.shipping_details?.name ?? s.shipping_details?.name, addr.line1, addr.line2, `${addr.city}, ${addr.state} ${addr.postal_code}`]
        .filter(Boolean)
        .join(", ")
    : undefined;
  const shipName = s.collected_information?.shipping_details?.name ?? s.shipping_details?.name ?? s.customer_details?.name ?? "";
  const shipAddress: ShipTo | undefined = addr
    ? { name: shipName, street: addr.line1 ?? "", ...(addr.line2 ? { apt: addr.line2 } : {}), city: addr.city ?? "", state: addr.state ?? "", zip: addr.postal_code ?? "" }
    : undefined;
  const ship = m.fulfillment === "ship";
  const paidAt = new Date(Number(event.created) > 0 ? Number(event.created) * 1000 : Date.now());
  return {
    sessionId: s.id,
    igUserId: m.ig_user_id,
    account: m.account ?? "",
    fulfillment: ship ? "ship" : m.fulfillment === "delivery" ? "delivery" : "pickup",
    ...(m.fulfillment === "delivery" ? { deliveryArea: m.delivery_area ?? "", deliveryMinutes: Number(m.delivery_minutes) || undefined } : {}),
    // Paid after 7pm ET ships the next day, so the calendar shows the real ship day.
    fulfillDate: ship ? shipDateFor(m.fulfill_date ?? "", paidAt) : (m.fulfill_date ?? ""),
    test: m.test_order === "true",
    fulfillTime: m.fulfill_time ?? "",
    buyerLabel: m.buyer_label === "true",
    summary: m.order_summary ?? "",
    total: (s.amount_total ?? 0) / 100,
    buyerName: s.customer_details?.name ?? undefined,
    buyerEmail: s.customer_details?.email ?? undefined,
    buyerPhone: s.customer_details?.phone ?? undefined,
    shipTo,
    ...(shipAddress ? { shipAddress } : {}),
    lines: linesFromMetadata(m),
    ...(Number(m.shipping) > 0 ? { shipping: Number(m.shipping) } : {}),
    ...(Number(m.delivery_fee) > 0 ? { deliveryFee: Number(m.delivery_fee) } : {}),
  };
}
