export type Fulfillment = "pickup" | "ship";

export interface PricingConfig {
  tables: Record<string, Record<string, number>>;
  products: { key: string; name: string; table?: string; flat?: number }[];
  shipping: { flat: number; buyerLabelAtPieces: number };
}

export interface OrderItem {
  /** Product key from config/pricing.json, e.g. "alo_hoodie". */
  product: string;
  /** Colorway or scent, e.g. "Gray" or "Bleu de Chanel". */
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
  total: number;
  /** Items the bot can't price (unknown product or bad quantity). Hand these to the team. */
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

export function quoteOrder(cfg: PricingConfig, items: OrderItem[], fulfillment: Fulfillment): Quote {
  const problems: string[] = [];
  const byKey = new Map(cfg.products.map((p) => [p.key, p]));
  const valid = items.filter((it) => {
    if (!byKey.has(it.product)) {
      problems.push(`No price listed for "${it.product}"`);
      return false;
    }
    if (!Number.isInteger(it.qty) || it.qty < 1) {
      problems.push(`Bad quantity for ${it.product}: ${it.qty}`);
      return false;
    }
    return true;
  });

  // Price per product: every size and colorway of that product counts toward its tier.
  const pieces = new Map<string, number>();
  for (const it of valid) pieces.set(it.product, (pieces.get(it.product) ?? 0) + it.qty);
  const unit = new Map<string, number>();
  for (const [key, count] of pieces) {
    const p = byKey.get(key)!;
    const price = p.flat ?? (p.table && cfg.tables[p.table] ? tierPrice(cfg.tables[p.table], count) : NaN);
    if (!Number.isFinite(price)) problems.push(`Pricing table missing for ${key}`);
    unit.set(key, price);
  }

  const lines: QuoteLine[] = valid
    .filter((it) => Number.isFinite(unit.get(it.product)))
    .map((it) => {
      const unitPrice = unit.get(it.product)!;
      return {
        product: it.product,
        name: byKey.get(it.product)!.name,
        variant: it.variant?.trim() || undefined,
        size: it.size?.trim() || undefined,
        qty: it.qty,
        unitPrice,
        lineTotal: unitPrice * it.qty,
      };
    });

  const groups = [...pieces.entries()]
    .filter(([key]) => Number.isFinite(unit.get(key)))
    .map(([key, count]) => ({
      product: key,
      name: byKey.get(key)!.name,
      pieces: count,
      unitPrice: unit.get(key)!,
      total: unit.get(key)! * count,
    }));

  const totalPieces = lines.reduce((s, l) => s + l.qty, 0);
  const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  const buyerProvidesLabel = fulfillment === "ship" && totalPieces >= cfg.shipping.buyerLabelAtPieces;
  const shipping = fulfillment === "ship" && !buyerProvidesLabel && totalPieces > 0 ? cfg.shipping.flat : 0;

  return {
    lines,
    groups,
    pieces: totalPieces,
    subtotal,
    fulfillment,
    shipping,
    buyerProvidesLabel,
    total: subtotal + shipping,
    problems,
  };
}

export function lineLabel(l: Pick<QuoteLine, "name" | "variant" | "size">): string {
  return [l.name, l.variant, l.size].filter(Boolean).join(" - ");
}

/** Short plain-text version for the AI and for team alerts. */
export function describeQuote(q: Quote): string {
  const parts = q.groups.map((g) => `${g.pieces}x ${g.name} @ $${g.unitPrice} = $${g.total}`);
  const ship = q.fulfillment === "pickup"
    ? "warehouse pickup (free)"
    : q.buyerProvidesLabel
      ? "shipping: buyer sends their own label (10+ pieces)"
      : `UPS shipping $${q.shipping}`;
  return `${parts.join("; ")}; ${ship}; TOTAL $${q.total}`;
}
