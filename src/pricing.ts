import { findTable, freebiesFor, matchStock, type StockRow } from "./catalog.js";

export type Fulfillment = "pickup" | "ship" | "delivery";

export interface PricingConfig {
  /** BOT PRICES tab: price list name -> pieces -> price each. */
  tables: Record<string, Record<string, number>>;
  /** BOT STOCK tab. Only FOR SALE rows can be sold. */
  stock?: StockRow[];
  shipping: { flat: number; buyerLabelAtPieces: number };
  delivery?: DeliveryConfig;
}

export interface DeliveryConfig {
  /** Fee by one-way drive time from the warehouse, e.g. up to 20 min = $5. */
  bands: { maxMinutes: number; fee: number }[];
  /** No delivery past this; offer shipping or meeting halfway instead. */
  maxMinutes: number;
  /** Town or area -> one-way drive minutes from the warehouse. */
  areas: Record<string, number>;
}

export type DeliveryInfo =
  | { ok: true; area: string; minutes: number; fee: number }
  | { ok: false; reason: "unknown_area" | "too_far" | "not_set_up"; area?: string; minutes?: number };

const clean = (s: string) =>
  s.toLowerCase().replace(/,?\s*(nc|north carolina)\b/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** Drive time and fee for a town or area. Unknown towns are never guessed. */
export function deliveryFor(cfg: PricingConfig, area: string | undefined): DeliveryInfo {
  const d = cfg.delivery;
  if (!d) return { ok: false, reason: "not_set_up" };
  const wanted = clean(area ?? "");
  if (!wanted) return { ok: false, reason: "unknown_area" };
  // Exact name first, then the longest known area named inside what they typed ("north raleigh" -> raleigh).
  const keys = Object.keys(d.areas).sort((a, b) => b.length - a.length);
  const key = keys.find((k) => clean(k) === wanted) ?? keys.find((k) => ` ${wanted} `.includes(` ${clean(k)} `));
  if (!key) return { ok: false, reason: "unknown_area", area: area?.trim() };
  const minutes = d.areas[key];
  if (minutes > d.maxMinutes) return { ok: false, reason: "too_far", area: key, minutes };
  const band = [...d.bands].sort((a, b) => a.maxMinutes - b.maxMinutes).find((b) => minutes <= b.maxMinutes);
  if (!band) return { ok: false, reason: "too_far", area: key, minutes };
  return { ok: true, area: key, minutes, fee: band.fee };
}

export interface OrderItem {
  /** Item name exactly as on the stock sheet, e.g. "Alo Hoodie". */
  product: string;
  /** Color from the stock sheet, e.g. "Gray". */
  variant?: string;
  size?: string;
  qty: number;
}

export interface QuoteLine {
  product: string;
  name: string;
  variant?: string;
  size?: string;
  qty: number;
  unitPrice: number;
  lineTotal: number;
}

export interface Quote {
  lines: QuoteLine[];
  /** One entry per product: how many pieces and the per-piece rate they earned. */
  groups: { product: string; name: string; pieces: number; unitPrice: number; total: number }[];
  pieces: number;
  subtotal: number;
  fulfillment: Fulfillment;
  shipping: number;
  /** True when a shipped order is big enough that the buyer sends their own label. */
  buyerProvidesLabel: boolean;
  /** Local delivery: area, one-way drive minutes, and fee. */
  delivery?: { area: string; minutes: number; fee: number };
  total: number;
  /** Gifts added to every order (Baccarat) and 5+ piece orders (G-Shock). Never charged. */
  freebies: string[];
  /** Items the bot can't sell or price (not in stock, not for sale, no price). */
  problems: string[];
}

/** Per-piece price for a quantity: the highest tier the quantity reaches. */
export function tierPrice(table: Record<string, number>, qty: number): number {
  const tiers = Object.keys(table)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  let price = table[String(tiers[0])];
  for (const t of tiers) if (qty >= t) price = table[String(t)];
  return price;
}

export function quoteOrder(cfg: PricingConfig, items: OrderItem[], fulfillment: Fulfillment, deliveryArea?: string): Quote {
  const problems: string[] = [];
  let delivery: Quote["delivery"];
  if (fulfillment === "delivery") {
    const d = deliveryFor(cfg, deliveryArea);
    if (d.ok) delivery = { area: d.area, minutes: d.minutes, fee: d.fee };
    else if (d.reason === "too_far") {
      problems.push(`Too far to deliver: ${d.area} is about ${d.minutes} min away (max ${cfg.delivery?.maxMinutes} min). Offer UPS shipping or meeting halfway`);
    } else if (d.reason === "unknown_area") {
      problems.push(`Delivery area not on the list: "${deliveryArea ?? ""}". Ask which town, or alert Josh to confirm the fee`);
    } else problems.push("Delivery isn't set up");
  }
  const stock = cfg.stock ?? [];
  type Valid = OrderItem & { name: string; list: string };
  const valid: Valid[] = [];
  for (const it of items) {
    if (!Number.isInteger(it.qty) || it.qty < 1) {
      problems.push(`Bad quantity for ${it.product}: ${it.qty}`);
      continue;
    }
    // The same item/color/size listed twice counts toward the stock check together.
    const sameBefore = valid
      .filter((v) => v.product.toLowerCase() === it.product.toLowerCase() && (v.variant ?? "") === (it.variant ?? "") && (v.size ?? "") === (it.size ?? ""))
      .reduce((n, v) => n + v.qty, 0);
    const m = matchStock(stock, cfg.tables, it.product, it.variant, it.size, it.qty + sameBefore);
    if (!m.ok) {
      problems.push(m.problem);
      continue;
    }
    const row = m.rows[0];
    const one = m.rows.length === 1;
    valid.push({
      ...it,
      name: row.item,
      variant: it.variant || (one ? row.color : undefined),
      size: it.size || (one && row.size.toLowerCase() !== "one size" ? row.size : undefined),
      list: row.priceList,
    });
  }

  // The tier is counted per price list: every size, color and item on the same list counts together.
  const pieces = new Map<string, number>();
  for (const it of valid) pieces.set(it.list, (pieces.get(it.list) ?? 0) + it.qty);
  const unit = new Map<string, number>();
  for (const [list, count] of pieces) {
    const t = findTable(cfg.tables, list);
    const price = t ? tierPrice(t, count) : NaN;
    if (!Number.isFinite(price)) problems.push(`No prices for price list ${list}. Hand off to josh`);
    unit.set(list, price);
  }

  const lines: QuoteLine[] = valid
    .filter((it) => Number.isFinite(unit.get(it.list)))
    .map((it) => {
      const unitPrice = unit.get(it.list)!;
      return {
        product: it.list,
        name: it.name,
        variant: it.variant?.trim() || undefined,
        size: it.size?.trim() || undefined,
        qty: it.qty,
        unitPrice,
        lineTotal: unitPrice * it.qty,
      };
    });

  const groups = [...pieces.entries()]
    .filter(([list]) => Number.isFinite(unit.get(list)))
    .map(([list, count]) => ({
      product: list,
      name: list,
      pieces: count,
      unitPrice: unit.get(list)!,
      total: unit.get(list)! * count,
    }));

  const totalPieces = lines.reduce((s, l) => s + l.qty, 0);
  const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  const buyerProvidesLabel = fulfillment === "ship" && totalPieces >= cfg.shipping.buyerLabelAtPieces;
  const shipping = fulfillment === "ship" && !buyerProvidesLabel && totalPieces > 0 ? cfg.shipping.flat : 0;
  const deliveryFee = delivery && totalPieces > 0 ? delivery.fee : 0;

  return {
    lines,
    groups,
    pieces: totalPieces,
    subtotal,
    fulfillment,
    shipping,
    buyerProvidesLabel,
    delivery,
    total: subtotal + shipping + deliveryFee,
    freebies: freebiesFor(stock, totalPieces),
    problems,
  };
}

export function lineLabel(l: Pick<QuoteLine, "name" | "variant" | "size">): string {
  return [l.name, l.variant, l.size].filter(Boolean).join(" - ");
}

/** Short plain-text version for the AI and for team alerts. */
export function describeQuote(q: Quote): string {
  const parts = q.lines.map((l) => `${l.qty}x ${lineLabel(l)} @ $${l.unitPrice} = $${l.lineTotal}`);
  const free = q.freebies.length ? `; FREE: ${q.freebies.join(", ")}` : "";
  const ship = q.fulfillment === "pickup"
    ? "warehouse pickup (free)"
    : q.fulfillment === "delivery"
      ? q.delivery
        ? `delivery to ${q.delivery.area} (~${q.delivery.minutes} min drive) $${q.delivery.fee}`
        : "delivery (area not priced)"
      : q.buyerProvidesLabel
      ? "shipping: buyer sends their own label (10+ pieces)"
      : `UPS shipping $${q.shipping}`;
  return `${parts.join("; ")}${free}; ${ship}; TOTAL $${q.total}`;
}
