// Pure helpers for the CRM screens (no DOM, no network), so they can be tested.

export const TEAM = ["Josh", "Chema", "Diego"];
export const ACCOUNTS = ["Triangle Resells", "Triangle Scales", "Triangle Sales"];

export const STATUSES = [
  { key: "booked", label: "Booked", tone: "booked" },
  { key: "paid_needs_check", label: "Paid - needs check", tone: "check" },
  { key: "paid", label: "Paid", tone: "paid" },
  { key: "done", label: "Done", tone: "done" },
  { key: "no_show", label: "No-show", tone: "red" },
  { key: "cancelled", label: "Cancelled", tone: "red" },
];
/** The big buttons on each booking (Paid - needs check is set by the bot, a person taps Paid to confirm). */
export const STATUS_BUTTONS = ["booked", "paid", "done", "no_show", "cancelled"];
export const statusOf = (key) => STATUSES.find((s) => s.key === key) ?? STATUSES[0];
export const isRed = (key) => key === "no_show" || key === "cancelled";

export const PAYMENTS = [
  { key: "cash", label: "Cash" },
  { key: "cash_app", label: "Cash App" },
  { key: "zelle", label: "Zelle" },
  { key: "stripe", label: "Stripe" },
  { key: "apple_pay", label: "Apple Pay" },
];
export const FULFILLMENT = [
  { key: "pickup", label: "Warehouse pickup" },
  { key: "delivery", label: "Local delivery" },
  { key: "ship", label: "Ship" },
];
export const SOURCES = [
  { key: "instagram", label: "Instagram" },
  { key: "bot", label: "Bot" },
  { key: "in_person", label: "In person" },
  { key: "text", label: "Text" },
  { key: "referral", label: "Referral" },
  { key: "other", label: "Other" },
];
/** Local delivery fee by drive time (brief): under 20 min $5, 20-30 $10, 30-45 $15, 45+ $20. */
export const DELIVERY_FEES = [
  { label: "Under 20 min", fee: 5 },
  { label: "20-30 min", fee: 10 },
  { label: "30-45 min", fee: 15 },
  { label: "45+ min", fee: 20 },
];

export const labelOf = (list, key) => list.find((x) => x.key === key)?.label ?? key ?? "";

const pad = (n) => String(n).padStart(2, "0");
/** Local date -> "2026-11-14" (no timezone shift). */
export const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseIso = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d, 12);
};

/** The 6x7 (or 5x7) grid of dates for a month view, weeks starting Sunday. */
export function monthGrid(year, month) {
  const first = new Date(year, month, 1, 12);
  const start = new Date(year, month, 1 - first.getDay(), 12);
  const days = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i, 12);
    if (i === 35 && d.getMonth() !== month) break;
    days.push({ iso: isoDate(d), day: d.getDate(), inMonth: d.getMonth() === month });
  }
  return days;
}

export function money(n) {
  const v = Number(n) || 0;
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

/** "16:00:00" -> "4:00 PM". */
export function fmtTime(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}:${pad(m)} ${h < 12 ? "AM" : "PM"}`;
}

export function customerName(c) {
  if (!c) return "No customer";
  return c.name || (c.ig_handle ? "@" + c.ig_handle : c.phone || "No name");
}

export function itemLine(i) {
  return `${i.qty}x ${[i.brand && !i.item.toLowerCase().startsWith(i.brand.toLowerCase()) ? i.brand : "", i.item, i.color, i.size].filter(Boolean).join(" ")}`;
}

/** Per day: how many still to fulfill, done, and red (cancelled / no-show). */
export function dayCounts(bookings) {
  const c = { open: 0, done: 0, red: 0 };
  for (const b of bookings) {
    if (isRed(b.status)) c.red++;
    else if (b.status === "done") c.done++;
    else c.open++;
  }
  return c;
}

export function groupByDate(bookings) {
  const out = {};
  for (const b of bookings) (out[b.date] ??= []).push(b);
  return out;
}

/**
 * Booking form -> the payload create_booking / update_booking expect. Returns {payload} or {error}.
 * f: {date, time, ig_handle, name, phone, items: [{brand,item,color,size,qty,unit_price}], sale_price, payment_method,
 *     fulfillment, delivery_fee, shipping_fee, label_cost, location, assignee, source, source_account, tracking_number, notes}
 */
export function bookingPayload(f) {
  const s = (v) => (v == null ? "" : String(v).trim());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s(f.date))) return { error: "Pick a date." };
  const items = (f.items ?? [])
    .filter((i) => s(i.item))
    .map((i, n) => ({ n: n + 1, brand: s(i.brand) || null, item: s(i.item), color: s(i.color) || null, size: s(i.size), qty: Number(i.qty), unit_price: s(i.unit_price) === "" ? null : Number(i.unit_price) }));
  if (!items.length) return { error: "Add at least one item." };
  for (const i of items) {
    if (!i.size) return { error: `Item ${i.n} (${i.item}) needs a size. Use "One Size" if it has none.` };
    if (!Number.isInteger(i.qty) || i.qty < 1) return { error: `Item ${i.n} (${i.item}) needs a quantity of 1 or more.` };
    if (i.unit_price != null && !(i.unit_price >= 0)) return { error: `Item ${i.n} (${i.item}) has a bad price.` };
  }
  const salePrice = s(f.sale_price) === "" ? null : Number(f.sale_price);
  if (salePrice != null && !(salePrice >= 0)) return { error: "Sale price must be a number." };
  if (salePrice == null && items.some((i) => i.unit_price == null)) return { error: "Enter the total sale price, or a price on every item." };
  if (!s(f.ig_handle) && !s(f.name) && !s(f.phone)) return { error: "Add the buyer: IG handle, name or phone." };
  if (f.payment_method === "cash" && f.fulfillment !== "pickup") return { error: "Cash is pickup only. Local delivery and shipping are paid up front." };
  const num = (v) => (s(v) === "" ? 0 : Number(v));
  const payload = {
    date: s(f.date),
    time: s(f.time) || null,
    customer: { ig_handle: s(f.ig_handle) || null, name: s(f.name) || null, phone: s(f.phone) || null },
    items: items.map(({ n, ...i }) => i),
    payment_method: f.payment_method,
    fulfillment: f.fulfillment,
    delivery_fee: f.fulfillment === "delivery" ? num(f.delivery_fee) : 0,
    shipping_fee: f.fulfillment === "ship" ? num(f.shipping_fee) : 0,
    label_cost: f.fulfillment === "ship" ? num(f.label_cost) : 0,
    location: s(f.location) || null,
    assignee: s(f.assignee) || null,
    source: f.source || "other",
    source_account: s(f.source_account) || null,
    tracking_number: f.fulfillment === "ship" ? s(f.tracking_number) || null : null,
    notes: s(f.notes) || null,
  };
  if (salePrice != null) payload.sale_price = salePrice;
  return { payload };
}

/** Plain-words line for an activity-log row. */
export function activityLine(a) {
  if (a.summary) return a.summary;
  const what = a.entity === "booking_items" ? "an item" : a.entity === "customers" ? "a customer" : "the booking";
  return `${a.actor} ${a.action === "create" ? "added" : a.action === "delete" ? "removed" : "changed"} ${what}`;
}

// ---------- money / reports ----------
/** "2026-11" -> ["2026-11-01", "2026-11-30"]. */
export function monthRange(ym) {
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(y, m, 0, 12).getDate();
  return [`${ym}-01`, `${ym}-${String(last).padStart(2, "0")}`];
}
/** "2026-11" -> "November 2026" (short: "Nov '26"). */
export function monthLabel(ym, short = false) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1, 1, 12);
  return short ? `${d.toLocaleDateString("en-US", { month: "short" })} '${String(y).slice(2)}` : d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}
export const thisMonth = (d = new Date()) => isoDate(d).slice(0, 7);

/** Bar chart (SVG string) of revenue + profit per month. Colors come from CSS variables, so it follows dark / light. */
export function monthChart(months, current) {
  const W = Math.max(560, months.length * 56), H = 240, L = 54, R = 10, T = 18, B = 30;
  const max = Math.max(1, ...months.map((m) => Math.max(Number(m.revenue), Number(m.profit))));
  const p = 10 ** Math.floor(Math.log10(max));
  const top = [1, 2, 2.5, 5, 10].map((f) => f * p).find((v) => v >= max) ?? 10 * p;
  const y = (v) => T + (H - T - B) * (1 - Math.max(0, v) / top);
  const cw = (W - L - R) / months.length, bw = Math.min(16, cw * 0.32);
  let g = "";
  for (let i = 0; i <= 4; i++) {
    const v = (top * i) / 4;
    g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${money(v)}</text>`;
  }
  months.forEach((m, i) => {
    const x = L + cw * i + cw / 2;
    const cur = m.month === current;
    const rev = Number(m.revenue), prof = Number(m.profit);
    g += `<g data-month="${m.month}" style="cursor:pointer"><rect x="${x - cw / 2}" y="${T}" width="${cw}" height="${H - T - B}" fill="transparent"/>`;
    g += `<rect x="${x - bw - 1}" y="${y(rev)}" width="${bw}" height="${H - B - y(rev)}" rx="2" fill="var(--gold)" opacity="${cur ? 1 : 0.6}"><title>${monthLabel(m.month)} revenue ${money(rev)}</title></rect>`;
    g += `<rect x="${x + 1}" y="${y(prof)}" width="${bw}" height="${H - B - y(prof)}" rx="2" fill="var(--done)" opacity="${cur ? 1 : 0.6}"><title>${monthLabel(m.month)} profit ${money(prof)}</title></rect>`;
    g += `<text x="${x}" y="${H - 10}" text-anchor="middle" font-size="11" fill="${cur ? "var(--fg)" : "var(--muted)"}">${monthLabel(m.month, true)}</text></g>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Revenue and profit by month" style="min-width:${W}px;width:100%;height:auto">${g}</svg>`;
}

export const CUSTOMER_SORTS = [
  { key: "top_spenders", label: "Top spenders" },
  { key: "repeat_buyers", label: "Repeat buyers" },
  { key: "most_dms", label: "Most active in DMs" },
  { key: "lowest_spenders", label: "Lowest spenders" },
  { key: "recent", label: "Most recent" },
];
