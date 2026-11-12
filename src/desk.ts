import { rowMatches, type StockRow } from "./catalog.js";
import type { Notifier } from "./handoff.js";
import type { CalendarPoster } from "./orders.js";
import { STOCK_TAB } from "./sheet.js";
import type { OrderLabel, ShipTo, Store } from "./store.js";

/**
 * What happens to an order after the bot locks it in:
 * stock comes off BOT STOCK right away (so nobody else can buy it), it goes on Josh's calendar,
 * Josh gets an alert, and the sale is written to the sales tracker once it's paid.
 * BOOKED = not paid yet (cash, or Cash App / Zelle Josh hasn't confirmed). PAID = money confirmed.
 */

export interface OrderLine {
  name: string;
  variant?: string;
  size?: string;
  qty: number;
}

export interface SheetIO {
  tabs(tabs: string[]): Promise<string[][][]>;
  ranges(ranges: string[], sheetId?: string): Promise<string[][][]>;
  write(data: { range: string; values: (string | number)[][] }[], sheetId?: string): Promise<void>;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const colLetter = (i: number) => {
  let n = i + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
};

/** Takes sold pieces off the BOT STOCK tab (sign -1) or puts them back after a cancel (sign +1). One change at a time. */
export class StockKeeper {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private io: Pick<SheetIO, "tabs" | "write">,
    private onChange?: () => void,
  ) {}

  adjust(lines: OrderLine[], sign: 1 | -1): Promise<string[]> {
    const run = this.chain.then(() => this.doAdjust(lines, sign));
    this.chain = run.catch(() => {});
    return run;
  }

  private async doAdjust(lines: OrderLine[], sign: 1 | -1): Promise<string[]> {
    const [rows] = await this.io.tabs([STOCK_TAB]);
    const at = rows.findIndex((r) => r.some((c) => norm(c ?? "") === "item") && r.some((c) => norm(c ?? "") === "qty"));
    if (at < 0) return [`no Item/Qty header on ${STOCK_TAB}`];
    const head = rows[at].map((c) => norm(c ?? ""));
    const col = (n: string) => head.indexOf(n);
    const [ci, cc, cs, cq, cst] = [col("item"), col("color"), col("size"), col("qty"), col("status")];
    const qtyOf = (r: string[]) => {
      const m = String(r[cq] ?? "").replace(/,/g, "").match(/\d+/);
      return m ? Number(m[0]) : 0;
    };
    const problems: string[] = [];
    const writes: { range: string; values: number[][] }[] = [];
    const pending = new Map<number, number>();
    for (const line of lines) {
      const candidates: number[] = [];
      for (let i = at + 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r?.[ci]) continue;
        if (norm(r[cst] ?? "") !== "for sale") continue;
        if (rowMatches({ item: r[ci] ?? "", color: r[cc] ?? "", size: r[cs] ?? "" }, line)) candidates.push(i);
      }
      if (!candidates.length) {
        problems.push(`not found on ${STOCK_TAB}: ${[line.name, line.variant, line.size].filter(Boolean).join(" ")}`);
        continue;
      }
      let left = line.qty;
      for (const i of candidates) {
        if (!left) break;
        const now = pending.get(i) ?? qtyOf(rows[i]);
        const change = sign < 0 ? Math.min(now, left) : left;
        if (!change) continue;
        pending.set(i, now + sign * change);
        left -= change;
      }
      if (left && sign < 0) problems.push(`only part of ${line.qty}x ${line.name} was on ${STOCK_TAB}`);
    }
    for (const [i, q] of pending) writes.push({ range: `'${STOCK_TAB}'!${colLetter(cq)}${i + 1}`, values: [[q]] });
    await this.io.write(writes);
    this.onChange?.();
    return problems;
  }
}

export interface Sale {
  date: Date;
  username?: string;
  products: string;
  cost?: number;
  /** Item total, without delivery fee or shipping. */
  itemsTotal: number;
  payment: string;
  fulfillment: "pickup" | "delivery" | "ship";
  notes: string;
  shipTo?: ShipTo;
  shipping?: number;
}

/** "Nov 2026" in New York time. */
export function trackerTab(d: Date): string {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", year: "numeric" }).formatToParts(d);
  return `${p.find((x) => x.type === "month")!.value} ${p.find((x) => x.type === "year")!.value}`;
}

const mdy = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "numeric", day: "numeric", year: "numeric" }).format(d);

/** Writes sales into Josh's tracker (one tab per month; local table AD-AN, shipped table A-AA). Never writes the Profit columns. */
export class SalesLog {
  constructor(
    private io: Pick<SheetIO, "ranges" | "write">,
    private trackerId: string,
  ) {}

  async log(s: Sale): Promise<void> {
    const tab = trackerTab(s.date);
    const ship = s.fulfillment === "ship";
    const keyCol = ship ? "A" : "AD";
    const [col] = await this.io.ranges([`'${tab}'!${keyCol}6:${keyCol}600`], this.trackerId);
    let idx = col.findIndex((r) => !String(r?.[0] ?? "").trim());
    if (idx < 0) idx = col.length;
    const row = 6 + idx;
    const who = s.username ? `@${s.username}` : "";
    const cost = s.cost ?? "";
    if (ship) {
      const a = s.shipTo;
      await this.io.write(
        [
          { range: `'${tab}'!A${row}:H${row}`, values: [[mdy(s.date), "Instagram", who, s.products, cost, s.itemsTotal + (s.shipping ?? 0), "", s.shipping ? 10 : ""]] },
          { range: `'${tab}'!J${row}:S${row}`, values: [[s.payment, "", a?.name ?? "", "", a?.street ?? "", a?.apt ?? "", a?.city ?? "", a?.state ?? "", "USA", a?.zip ?? ""]] },
          { range: `'${tab}'!AA${row}`, values: [[`Closer: Bot. ${s.notes}`]] },
        ],
        this.trackerId,
      );
      return;
    }
    await this.io.write(
      [
        { range: `'${tab}'!AD${row}:AI${row}`, values: [[mdy(s.date), "Bot", who, s.products, cost, s.itemsTotal]] },
        { range: `'${tab}'!AK${row}:AN${row}`, values: [[s.payment, "", "", s.notes]] },
      ],
      this.trackerId,
    );
  }
}

export interface Booking {
  userId: string;
  username?: string;
  lines: OrderLine[];
  /** "2x Alo Hoodie Gray M, 1x ..." */
  items: string;
  itemsTotal: number;
  total: number;
  payment: string;
  fulfillment: "pickup" | "delivery" | "ship";
  fulfillDate: string;
  fulfillTime?: string;
  deliveryArea?: string;
  deliveryMinutes?: number;
  deliveryFee?: number;
  shipping?: number;
  shipTo?: ShipTo;
  freebies: string[];
}

export interface DeskDeps {
  store: Store;
  notify: Notifier;
  accountName: string;
  stock?: StockKeeper;
  sales?: SalesLog;
  calendar?: CalendarPoster;
  /** Current sheet rows, for costs. */
  stockRows?: () => Promise<StockRow[]>;
  now?: () => Date;
}

export const shipToText = (a?: ShipTo) => (a ? [a.name, a.street, a.apt, `${a.city}, ${a.state} ${a.zip}`].filter(Boolean).join(", ") : "");

export class OrderDesk {
  constructor(private d: DeskDeps) {}

  private now(): Date {
    return this.d.now?.() ?? new Date();
  }

  private async costOf(lines: OrderLine[]): Promise<number | undefined> {
    if (!this.d.stockRows) return undefined;
    const rows = await this.d.stockRows().catch(() => [] as StockRow[]);
    let total = 0;
    for (const l of lines) {
      const r = rows.find((x) => rowMatches(x, l));
      if (r?.cost === undefined) return undefined;
      total += r.cost * l.qty;
    }
    return Math.round(total * 100) / 100;
  }

  private async takeStock(lines: OrderLine[], sign: 1 | -1, who: string): Promise<void> {
    if (!this.d.stock || !lines.length) return;
    try {
      const problems = await this.d.stock.adjust(lines, sign);
      if (problems.length) throw new Error(problems.join("; "));
    } catch (err) {
      console.error("[desk] stock update failed:", err);
      await this.d
        .notify({
          account: this.d.accountName,
          userId: who,
          route: "josh",
          paused: false,
          reason: `Couldn't ${sign < 0 ? "take" : "put"} stock ${sign < 0 ? "off" : "back on"} the sheet`,
          summary: `${String(err).slice(0, 300)}. Fix BOT STOCK by hand.`,
        })
        .catch(() => {});
    }
  }

  /** submit_order: cash, Cash App, Zelle (or Apple Pay with no Stripe). Stock comes off now, label BOOKED. */
  async booked(b: Booking): Promise<OrderLabel> {
    await this.takeStock(b.lines, -1, b.userId);
    const when = [b.fulfillment, b.fulfillDate, b.fulfillTime, b.deliveryArea && `(${b.deliveryArea})`].filter(Boolean).join(" ");
    const label = this.d.store.addLabel({
      userId: b.userId,
      label: "BOOKED",
      summary: b.items,
      total: b.total,
      payment: b.payment,
      when,
      lines: b.lines,
      fulfillment: b.fulfillment,
      shipTo: b.shipTo,
      deliveryFee: b.deliveryFee,
      shipping: b.shipping,
      cost: await this.costOf(b.lines),
    });
    const who = b.username ? `@${b.username}` : "IG buyer";
    const steps: [string, () => Promise<void>][] = [];
    if (this.d.calendar) {
      const kind = b.fulfillment === "pickup" ? "🔺 PICKUP" : b.fulfillment === "delivery" ? `🚗 DELIVERY ${b.deliveryMinutes ?? "?"}min ${b.deliveryArea ?? ""}`.trim() : "📦 SHIP";
      steps.push([
        "calendar",
        () =>
          this.d.calendar!({
            title: `🟡 BOOKED ${kind}: ${who} – $${b.total} (${b.payment})`,
            date: b.fulfillDate,
            time: b.fulfillment === "ship" ? "" : (b.fulfillTime ?? ""),
            durationMinutes: 30,
            timeZone: "America/New_York",
            location: b.fulfillment === "ship" ? shipToText(b.shipTo) : b.fulfillment === "delivery" ? (b.deliveryArea ?? "") : "Warehouse",
            description: [
              `Items: ${b.items}`,
              b.freebies.length ? `Free: ${b.freebies.join(", ")}` : "",
              `Total: $${b.total} by ${b.payment}${b.payment === "cash" ? " (collect at pickup)" : " (NOT confirmed yet: check your app, then Mark paid on /admin)"}`,
              b.shipTo ? `Ship to: ${shipToText(b.shipTo)}` : "",
              `Instagram: ${who} (user ${b.userId})`,
            ]
              .filter(Boolean)
              .join("\n"),
          }),
      ]);
    }
    steps.push([
      "alert",
      () =>
        this.d.notify({
          account: this.d.accountName,
          userId: b.userId,
          username: b.username,
          route: "josh",
          paused: false,
          reason: `🟡 BOOKED $${b.total} – ${when}, pays by ${b.payment}`,
          summary: `${b.items}${b.freebies.length ? ` + ${b.freebies.join(", ")}` : ""}${b.shipTo ? `. Ship to: ${shipToText(b.shipTo)}` : ""}. Already taken off BOT STOCK.${b.payment === "cash" ? "" : " Mark it paid on /admin once the money shows up."}`,
        }),
    ]);
    for (const [name, run] of steps) await run().catch((err) => console.error(`[desk] ${name} failed:`, err));
    return label;
  }

  /** Stripe said it's paid: stock off, PAID label, logged as a sale. (Calendar + alert happen in handlePaidOrder.) */
  async stripePaid(userId: string, lines: OrderLine[], summary: string, total: number, when: string, fulfillment: "pickup" | "delivery" | "ship" = "pickup"): Promise<OrderLabel> {
    await this.takeStock(lines, -1, userId);
    const label = this.d.store.addLabel({ userId, label: "PAID", summary, total, payment: "stripe", when, lines, fulfillment, cost: await this.costOf(lines) });
    await this.logSale(label);
    return label;
  }

  /** Josh saw the Cash App / Zelle money (or got the cash): PAID + logged. */
  async markPaid(id: string): Promise<boolean> {
    if (!this.d.store.markLabelPaid(id)) return false;
    await this.logSale(this.d.store.getLabel(id)!);
    return true;
  }

  /** Order fulfilled: log it if it wasn't yet (cash), then clear the label. */
  async done(id: string): Promise<boolean> {
    const l = this.d.store.getLabel(id);
    if (!l) return false;
    await this.logSale(l);
    return this.d.store.clearLabel(id);
  }

  async doneAll(): Promise<number> {
    let n = 0;
    for (const l of this.d.store.allLabels()) if (await this.done(l.id)) n++;
    return n;
  }

  /** No-show or changed their mind: pieces go back on BOT STOCK, label removed. */
  async cancel(id: string): Promise<{ ok: boolean; wasLogged?: boolean }> {
    const l = this.d.store.getLabel(id);
    if (!l) return { ok: false };
    await this.takeStock(l.lines ?? [], 1, l.userId);
    this.d.store.clearLabel(id);
    return { ok: true, wasLogged: !!l.logged };
  }

  private async logSale(l: OrderLabel): Promise<void> {
    if (l.logged || !this.d.sales) return;
    const fee = l.deliveryFee ? ` - $${l.deliveryFee} delivery fee` : "";
    const itemsTotal = l.total - (l.deliveryFee ?? 0) - (l.shipping ?? 0);
    try {
      await this.d.sales.log({
        date: this.now(),
        username: l.username,
        products: l.summary,
        cost: l.cost,
        itemsTotal,
        payment: l.payment,
        fulfillment: l.fulfillment ?? "pickup",
        shipTo: l.shipTo,
        shipping: l.shipping,
        notes: `Bot order: ${l.when}${fee}${l.cost === undefined ? " - COST TBD" : ""}`,
      });
      this.d.store.updateLabel(l.id, { logged: true });
    } catch (err) {
      console.error("[desk] sales log failed:", err);
      await this.d
        .notify({ account: this.d.accountName, userId: l.userId, route: "josh", paused: false, reason: "Couldn't log a sale in the tracker", summary: `${l.summary} $${l.total}. ${String(err).slice(0, 200)}` })
        .catch(() => {});
    }
  }
}
