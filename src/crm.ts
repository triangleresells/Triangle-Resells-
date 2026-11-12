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

export interface Crm {
  createBooking(b: CrmBookingInput): Promise<CrmBooking>;
  reschedule(id: string, date: string, time?: string | null): Promise<CrmBooking>;
  setStatus(id: string, status: "paid" | "done" | "cancelled" | "no_show", reason?: string): Promise<CrmBooking>;
}

export class CrmError extends Error {}

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
    if (!res.ok) throw new CrmError(`CRM said ${res.status}: ${String(data.error ?? text).slice(0, 200)}`);
    return data as T;
  }
  return {
    createBooking: async (b) => (await call<{ booking: CrmBooking }>("POST", "/bookings", b)).booking,
    reschedule: async (id, date, time) => (await call<{ booking: CrmBooking }>("POST", `/bookings/${id}/reschedule`, { date, time: time ?? null })).booking,
    setStatus: async (id, status, reason) => (await call<{ booking: CrmBooking }>("POST", `/bookings/${id}/status`, { status, reason: reason ?? null })).booking,
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
