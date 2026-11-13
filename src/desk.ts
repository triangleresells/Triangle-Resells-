import { rowMatches, type StockRow } from "./catalog.js";
import type { Notifier } from "./handoff.js";
import type { CalendarPoster } from "./orders.js";
import { CrmError, crmPayment, to24h, type Crm, type StockNewRow, type StockWrite } from "./crm.js";

/** End-to-end test buyers: ids starting "e2e-test-". Real Instagram ids are only digits, so a real buyer never matches. */
export const isTestBuyer = (userId: string) => userId.startsWith("e2e-test-");

/** The words BOT STOCK uses in its Status column. */
export const SHEET_STATUS: Record<string, string> = { for_sale: "FOR SALE", incoming: "INCOMING", freebie: "FREEBIE", not_for_sale: "NOT FOR SALE" };
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
  /** Per-piece price the buyer pays (from quote_order), for the CRM. */
  unitPrice?: number;
}

export interface SheetIO {
  tabs(tabs: string[]): Promise<string[][][]>;
  ranges(ranges: string[], sheetId?: string): Promise<string[][][]>;
  write(data: { range: string; values: (string | number)[][] }[], sheetId?: string): Promise<void>;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** Same key as the CRM's crm_stock_key(): item|color|size, blank size = One Size. */
export const stockKey = (item?: string | null, color?: string | null, size?: string | null) => {
  const sz = norm(size ?? "");
  return `${norm(item ?? "")}|${norm(color ?? "")}|${sz === "one size" || sz === "os" ? "" : sz}`;
};
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

  /**
   * Sets exact Qty values on a tab (the CRM's stock sync says what the sheet should show). Rows are matched like the
   * CRM matches them: item + color + size, and which repeat when the same item, color and size appear twice.
   */
  setQty(writes: StockWrite[], tab = STOCK_TAB, addRows: StockNewRow[] = []): Promise<string[]> {
    const run = this.chain.then(() => this.doSet(writes, tab, addRows));
    this.chain = run.catch(() => {});
    return run;
  }

  private async doSet(list: StockWrite[], tab: string, addRows: StockNewRow[] = []): Promise<string[]> {
    if (!list.length && !addRows.length) return [];
    const [rows] = await this.io.tabs([tab]);
    const at = rows.findIndex((r) => r.some((c) => norm(c ?? "") === "item") && r.some((c) => norm(c ?? "") === "qty"));
    if (at < 0) return [`no Item/Qty header on ${tab}`];
    const head = rows[at].map((c) => norm(c ?? ""));
    const [ci, cc, cs, cq, cst] = ["item", "color", "size", "qty", "status"].map((n) => head.indexOf(n));
    const where = new Map<string, number>();
    const seen = new Map<string, number>();
    for (let i = at + 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r?.[ci]?.trim()) continue;
      const k = stockKey(r[ci], r[cc], r[cs]);
      const n = (seen.get(k) ?? 0) + 1;
      seen.set(k, n);
      where.set(`${k}#${n}`, i);
    }
    const problems: string[] = [];
    const writes: { range: string; values: (string | number)[][] }[] = [];
    for (const w of list) {
      const i = where.get(`${stockKey(w.item, w.color, w.size)}#${w.occurrence}`);
      if (i === undefined) problems.push(`not found on ${tab}: ${[w.item, w.color, w.size].filter(Boolean).join(" ")}`);
      else {
        writes.push({ range: `'${tab}'!${colLetter(cq)}${i + 1}`, values: [[w.qty]] });
        if (w.status && cst >= 0) writes.push({ range: `'${tab}'!${colLetter(cst)}${i + 1}`, values: [[SHEET_STATUS[w.status] ?? w.status]] });
      }
    }
    // New items from a restock: one row each, after the last row, under the sheet's own column headers.
    let next = rows.length + 1;
    for (const r of addRows) {
      const cells: Record<string, string | number> = {
        category: r.category ?? "", brand: r.brand ?? "", item: r.item, color: r.color ?? "", size: r.size ?? "", qty: r.qty,
        "price list": r.price_list ?? "", status: SHEET_STATUS[r.status] ?? r.status, notes: "Added from a restock in the CRM", cost: r.cost ?? "",
      };
      const row = head.map((h) => cells[h] ?? "");
      writes.push({ range: `'${tab}'!A${next}:${colLetter(head.length - 1)}${next}`, values: [row] });
      next++;
    }
    if (writes.length) await this.io.write(writes);
    this.onChange?.();
    return problems;
  }

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
  /** The Triangle CRM: every booked order also becomes a CRM booking (logged there as "Bot"). */
  crm?: Crm;
  /** Who the CRM booking is assigned to (default Chema). */
  crmAssignee?: string;
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
  /**
   * submit_order. With the CRM on, the CRM booking comes first: it reserves the stock, and if the pieces are gone it
   * refuses and nothing is booked ({refused}). If the CRM can't be reached, stock comes off the sheet here instead and
   * Josh is told to add the booking by hand.
   */
  async booked(b: Booking): Promise<OrderLabel | { refused: string }> {
    let crmId: string | undefined;
    let crmFailed: string | undefined;
    if (this.d.crm) {
      const r = await this.bookInCrm(b);
      if (r.refused) return { refused: r.refused };
      crmId = r.id;
      crmFailed = r.failed;
    }
    if (!crmId) await this.takeStock(b.lines, -1, b.userId);
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
      deliveryMinutes: b.deliveryMinutes,
      cost: await this.costOf(b.lines),
      ...(crmId ? { crmId } : {}),
    });
    const who = b.username ? `@${b.username}` : "IG buyer";
    const steps: [string, () => Promise<void>][] = [];
    if (this.d.calendar) {
      const kind = b.fulfillment === "pickup" ? "🔺 PICKUP" : b.fulfillment === "delivery" ? `🚗 DELIVERY ${b.deliveryMinutes ?? "?"}min ${b.deliveryArea ?? ""}`.trim() : "📦 SHIP";
      steps.push([
        "calendar",
        async () => {
          const id = await this.d.calendar!({
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
          });
          // Kept so a reschedule can move this event and a cancel can delete it.
          if (id) this.d.store.updateLabel(label.id, { calendarId: id });
        },
      ]);
    }
    if (crmFailed) {
      steps.push([
        "crm alert",
        () =>
          this.d.notify({
            account: this.d.accountName,
            userId: b.userId,
            username: b.username,
            route: "josh",
            paused: false,
            reason: "⚠️ Order NOT saved in the CRM: add it by hand",
            summary: `${b.items}, ${b.fulfillment} ${b.fulfillDate} ${b.fulfillTime ?? ""}, $${b.total} by ${b.payment}. ${crmFailed}. Stock was taken off BOT STOCK directly.`,
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

  /** The CRM booking (it reserves the stock). {refused}: the CRM said no (e.g. sold out). {failed}: couldn't reach it. */
  private async bookInCrm(b: Booking): Promise<{ id?: string; refused?: string; failed?: string }> {
    const rows = this.d.stockRows ? await this.d.stockRows().catch(() => [] as StockRow[]) : [];
    try {
      const booking = await this.d.crm!.createBooking({
        date: b.fulfillDate,
        time: b.fulfillment === "ship" ? null : to24h(b.fulfillTime),
        customer: { ig_user_id: b.userId, ig_handle: b.username ?? null, name: b.shipTo?.name ?? null },
        items: b.lines.map((l) => {
          const r = rows.find((x) => rowMatches(x, l));
          return { brand: r?.brand || undefined, item: l.name, color: l.variant, size: l.size || r?.size || "One Size", qty: l.qty, unit_price: l.unitPrice, unit_cost: r?.cost };
        }),
        payment_method: crmPayment(b.payment),
        fulfillment: b.fulfillment,
        sale_price: b.itemsTotal,
        delivery_fee: b.fulfillment === "delivery" ? (b.deliveryFee ?? 0) : 0,
        shipping_fee: b.fulfillment === "ship" ? (b.shipping ?? 0) : 0,
        location: b.fulfillment === "ship" ? shipToText(b.shipTo) : b.fulfillment === "delivery" ? (b.deliveryArea ?? null) : "Warehouse",
        assignee: this.d.crmAssignee ?? "Chema",
        source: "instagram",
        source_account: this.d.accountName,
        notes: b.freebies.length ? `Free: ${b.freebies.join(", ")}` : null,
        // End-to-end test buyers (never a real Instagram id, those are numbers) only ever touch TEST stock.
        ...(isTestBuyer(b.userId) ? { is_test: true } : {}),
      });
      return { id: booking.id };
    } catch (err) {
      if (err instanceof CrmError && err.status && err.status < 500) return { refused: err.message };
      console.error("[desk] CRM booking failed:", err);
      return { failed: String((err as Error).message ?? err).slice(0, 200) };
    }
  }

  /**
   * A booking a team member made in the CRM: the bot takes it on like its own order (an order label linked to the CRM
   * booking, and a calendar event; the CRM already reserved the stock). No alert: the team made it. No CRM write: it came from there.
   */
  async adopt(a: {
    crmId: string;
    userId: string;
    username?: string;
    lines: OrderLine[];
    summary: string;
    total: number;
    payment: string;
    paid: boolean;
    fulfillment: "pickup" | "delivery" | "ship";
    date: string;
    /** "3:00 PM", or undefined for shipped / no time. */
    time?: string;
    location?: string;
    deliveryFee?: number;
    shipping?: number;
  }): Promise<OrderLabel> {
    // No stock change here: the CRM already reserved these pieces when the booking was made.
    const when = [a.fulfillment, a.date, a.time].filter(Boolean).join(" ");
    const label = this.d.store.addLabel({
      userId: a.userId,
      label: a.paid ? "PAID" : "BOOKED",
      summary: a.summary,
      total: a.total,
      payment: a.payment,
      when,
      lines: a.lines,
      fulfillment: a.fulfillment,
      deliveryFee: a.deliveryFee,
      shipping: a.shipping,
      cost: await this.costOf(a.lines),
      crmId: a.crmId,
    });
    if (a.username && !label.username) this.d.store.updateLabel(label.id, { username: a.username });
    if (this.d.calendar) {
      const kind = a.fulfillment === "pickup" ? "🔺 PICKUP" : a.fulfillment === "delivery" ? "🚗 DELIVERY" : "📦 SHIP";
      const who = a.username ? `@${a.username}` : "buyer";
      try {
        const id = await this.d.calendar({
          title: `${a.paid ? "🟢 PAID" : "🟡 BOOKED"} ${kind}: ${who} – $${a.total} (${a.payment})`,
          date: a.date,
          time: a.fulfillment === "ship" ? "" : (a.time ?? ""),
          durationMinutes: 30,
          timeZone: "America/New_York",
          location: a.location ?? (a.fulfillment === "pickup" ? "Warehouse" : ""),
          description: `Items: ${a.summary}\nTotal: $${a.total} by ${a.payment}\nAdded in the CRM.`,
        });
        if (id) this.d.store.updateLabel(label.id, { calendarId: id });
      } catch (err) {
        console.error("[desk] calendar for a CRM booking failed:", err);
      }
    }
    return label;
  }

  /** Items edited in the CRM: the label follows (the CRM moved the stock). Orders the CRM doesn't know: the sheet too. */
  async replaceLines(id: string, lines: OrderLine[], summary: string, total: number): Promise<void> {
    const l = this.d.store.getLabel(id);
    if (!l) return;
    if (!l.crmId) {
      await this.takeStock(l.lines ?? [], 1, l.userId);
      await this.takeStock(lines, -1, l.userId);
    }
    this.d.store.updateLabel(id, { lines, summary, total, cost: await this.costOf(lines) });
  }

  /** Stripe said it's paid: stock off, PAID label, logged as a sale. (Calendar + alert happen in handlePaidOrder.) */
  async stripePaid(userId: string, lines: OrderLine[], summary: string, total: number, when: string, fulfillment: "pickup" | "delivery" | "ship" = "pickup"): Promise<OrderLabel> {
    await this.takeStock(lines, -1, userId);
    // Paid is not fulfilled: it goes in the sales tracker when it's Done (Josh approves that).
    return this.d.store.addLabel({ userId, label: "PAID", summary, total, payment: "stripe", when, lines, fulfillment, cost: await this.costOf(lines) });
  }

  /** Josh saw the Cash App / Zelle money (or got the cash): PAID + logged. */
  async markPaid(id: string): Promise<boolean> {
    // Only marks it paid. The sale goes in the tracker when it's Done (fulfilled, and Josh approved).
    return this.d.store.markLabelPaid(id);
  }

  /** Order fulfilled: log it if it wasn't yet (cash), then clear the label. */
  async done(id: string): Promise<boolean> {
    const l = this.d.store.getLabel(id);
    if (!l) return false;
    await this.logSale(l);
    return this.d.store.clearLabel(id);
  }

  /** End of day on /admin: closes PAID orders only. Unpaid ones (maybe no-shows) are never logged as sales, and
   *  orders the CRM owns are closed in the CRM. */
  async doneAll(): Promise<number> {
    let n = 0;
    for (const l of this.d.store.allLabels()) if (l.label === "PAID" && !l.crmId && (await this.done(l.id))) n++;
    return n;
  }

  /** No-show or changed their mind: pieces go back on BOT STOCK, label removed. */
  async cancel(id: string): Promise<{ ok: boolean; wasLogged?: boolean }> {
    const l = this.d.store.getLabel(id);
    if (!l) return { ok: false };
    // Orders the CRM knows about get their stock back in the CRM (its cancel); only the others go back on the sheet here.
    if (!l.crmId) await this.takeStock(l.lines ?? [], 1, l.userId);
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
