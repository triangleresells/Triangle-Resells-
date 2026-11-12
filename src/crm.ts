/**
 * The bot's connection to the Triangle CRM (crm/ in this repo, hosted on Netlify). Every call is logged in the CRM
 * as "Bot". Off unless CRM_API_URL and CRM_BOT_API_KEY are set.
 */

export interface CrmItem {
  brand?: string;
  item: string;
  color?: string;
  size: string;
  qty: number;
  unit_price?: number;
  unit_cost?: number;
}

export interface CrmBookingInput {
  date: string;
  time?: string | null;
  customer: { ig_user_id?: string; ig_handle?: string | null; name?: string | null; phone?: string | null };
  items: CrmItem[];
  payment_method: "cash" | "cash_app" | "zelle" | "stripe" | "apple_pay";
  fulfillment: "pickup" | "delivery" | "ship";
  sale_price: number;
  delivery_fee?: number;
  shipping_fee?: number;
  location?: string | null;
  assignee?: string | null;
  source: "instagram" | "bot";
  source_account?: string | null;
  notes?: string | null;
  status?: "booked" | "paid";
  is_test?: boolean;
}

export interface CrmBooking {
  id: string;
  date: string;
  time: string | null;
  status: string;
}

/** A booking as the CRM returns it in full (customer and items included). */
export interface CrmBookingFull extends CrmBooking {
  payment_method: string;
  fulfillment: "pickup" | "delivery" | "ship";
  sale_price: number;
  delivery_fee: number;
  shipping_fee: number;
  location: string | null;
  assignee: string | null;
  is_test: boolean;
  customer: { id: string; ig_user_id: string | null; ig_handle: string | null; name: string | null } | null;
  items: { brand: string | null; item: string; color: string | null; size: string; qty: number; unit_price: number | null }[];
}

/** One change a person made in the CRM (the bot's own changes never show up here). */
export interface CrmEvent {
  id: number;
  kind: "created" | "updated" | "deleted";
  actor: string;
  booking: CrmBookingFull;
  previous: { date: string; time: string | null; status: string } | null;
  is_test: boolean;
}

export interface Crm {
  createBooking(b: CrmBookingInput): Promise<CrmBooking>;
  reschedule(id: string, date: string, time?: string | null): Promise<CrmBooking>;
  setStatus(id: string, status: "paid" | "done" | "cancelled" | "no_show", reason?: string): Promise<CrmBooking>;
  /** Changes people made after event `after` (null = none yet, just where to start). */
  events(after: number | null): Promise<{ events: CrmEvent[]; latest: number }>;
  /** This Instagram buyer's bookings that aren't finished. */
  openBookings(igUserId: string): Promise<CrmBookingFull[]>;
  /** Sends what BOT STOCK says; gets back the counts to write on the sheet. */
  syncStock(rows: CrmStockRow[], isTest: boolean): Promise<{ sheet_edits_applied: number; writes: StockWrite[] }>;
}

/** One BOT STOCK row as the CRM wants it. */
export interface CrmStockRow {
  category: string;
  brand: string;
  item: string;
  color: string;
  size: string;
  qty: string;
  price_list: string;
  status: "for_sale" | "freebie" | "not_for_sale" | "incoming" | "other";
  notes: string;
  cost: string;
}

/** "Set this row's Qty to N" (occurrence: 2 = the second row with the same item, color and size). */
export interface StockWrite {
  item: string;
  color: string | null;
  size: string | null;
  occurrence: number;
  qty: number;
}

/** status: the CRM's HTTP answer (4xx = it refused, e.g. out of stock); none = couldn't reach it. */
export class CrmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export function crmClient(baseUrl: string, apiKey: string, fetchFn: typeof fetch = fetch, timeoutMs = 8000): Crm {
  const base = baseUrl.replace(/\/+$/, "");
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetchFn(`${base}/api${path}`, {
        method,
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new CrmError(`CRM unreachable: ${(err as Error).name === "TimeoutError" ? "timed out" : String(err).slice(0, 120)}`);
    }
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      /* not JSON */
    }
    if (!res.ok) throw new CrmError(String(data.error ?? text).slice(0, 200) || `CRM error ${res.status}`, res.status);
    return data as T;
  }
  return {
    createBooking: async (b) => (await call<{ booking: CrmBooking }>("POST", "/bookings", b)).booking,
    reschedule: async (id, date, time) => (await call<{ booking: CrmBooking }>("POST", `/bookings/${id}/reschedule`, { date, time: time ?? null })).booking,
    setStatus: async (id, status, reason) => (await call<{ booking: CrmBooking }>("POST", `/bookings/${id}/status`, { status, reason: reason ?? null })).booking,
    events: (after) => call("GET", `/events${after === null ? "" : `?after=${after}`}`),
    syncStock: (rows, isTest) => call("POST", "/stock/sync", { rows, is_test: isTest }),
    openBookings: async (ig) => (await call<{ bookings: CrmBookingFull[] }>("GET", `/customers/bookings?ig_user_id=${encodeURIComponent(ig)}`)).bookings,
  };
}

/** "3:00 PM" / "15:00" -> "15:00". Unknown -> null. */
export function to24h(t?: string): string | null {
  if (!t) return null;
  const m = t.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ?? "00";
  const ap = m[3]?.toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || Number(min) > 59) return null;
  return `${String(h).padStart(2, "0")}:${min}`;
}

/** The bot's payment words -> the CRM's. */
export function crmPayment(p: string): CrmBookingInput["payment_method"] {
  const k = p.toLowerCase().replace(/[\s-]+/g, "_");
  if (k === "cash" || k === "cash_app" || k === "zelle" || k === "stripe" || k === "apple_pay") return k;
  return "apple_pay";
}
