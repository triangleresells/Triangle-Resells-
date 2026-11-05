import { createHmac, timingSafeEqual } from "node:crypto";
import { lineLabel, type Quote } from "./pricing.js";

export interface OrderDetails {
  igUserId: string;
  account: string;
  /** YYYY-MM-DD the order is handed over or shipped. Can be days after payment (paid now, held until then). */
  fulfillDate: string;
  /** e.g. "3:00 PM". Pickups only. */
  fulfillTime?: string;
  summary: string;
}

export interface CheckoutLink {
  id: string;
  url: string;
  expiresAt: number;
}

export interface CheckoutApi {
  create(quote: Quote, order: OrderDetails): Promise<CheckoutLink>;
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
  const pickup = quote.fulfillment === "pickup";
  const message = pickup
    ? "All sales final. Pickup address sent after payment."
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
      order_summary: order.summary.slice(0, 500),
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
      body: toForm(checkoutParams(quote, order, this.successUrl)).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; url?: string; expires_at?: number; error?: unknown };
    if (!res.ok || !body.url || !body.id) throw new Error(`Stripe ${res.status}: ${JSON.stringify(body.error ?? body)}`);
    return { id: body.id, url: body.url, expiresAt: body.expires_at ?? 0 };
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
  fulfillment: "pickup" | "ship";
  fulfillDate: string;
  fulfillTime: string;
  buyerLabel: boolean;
  summary: string;
  total: number;
  buyerName?: string;
  buyerEmail?: string;
  buyerPhone?: string;
  shipTo?: string;
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
  return {
    sessionId: s.id,
    igUserId: m.ig_user_id,
    account: m.account ?? "",
    fulfillment: m.fulfillment === "ship" ? "ship" : "pickup",
    fulfillDate: m.fulfill_date ?? "",
    fulfillTime: m.fulfill_time ?? "",
    buyerLabel: m.buyer_label === "true",
    summary: m.order_summary ?? "",
    total: (s.amount_total ?? 0) / 100,
    buyerName: s.customer_details?.name ?? undefined,
    buyerEmail: s.customer_details?.email ?? undefined,
    buyerPhone: s.customer_details?.phone ?? undefined,
    shipTo,
  };
}
