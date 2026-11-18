/**
 * Deposits in the CRM's `deposits` table (the CRM owns it; see docs/schema.md). The bot writes one row per order when a
 * buyer says they sent a 50% deposit: who, what, the deposit, the balance due. status 'held' = deposit in, order open.
 * Josh still confirms the money actually arrived (the payment alert says so). Service key, server-side only.
 */
export interface DepositRow {
  igUserId: string;
  username?: string;
  items: string;
  pieces: number;
  orderTotal: number;
  deposit: number;
  payment: string;
  bookingId?: string;
  expectedDate?: string;
  isTest?: boolean;
}

export type DepositRecorder = (d: DepositRow) => Promise<void>;

export function balanceDue(total: number, deposit: number): number {
  return Math.round((total - deposit) * 100) / 100;
}

/** 50% of the total, rounded to the cent. */
export function halfOf(total: number): number {
  return Math.round(total * 50) / 100;
}

export function supabaseDeposits(supabaseUrl: string, serviceKey: string, fetchFn: typeof fetch = fetch): DepositRecorder {
  const base = supabaseUrl.trim().replace(/\/+$/, "").replace(/\/rest\/v1$/i, "").replace(/\/+$/, "") + "/rest/v1";
  return async (d) => {
    const res = await fetchFn(`${base}/deposits`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        ...(serviceKey.startsWith("sb_") ? {} : { Authorization: `Bearer ${serviceKey}` }),
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        customer_name: d.username ? `@${d.username}` : `IG ${d.igUserId}`,
        ig_handle: d.username ?? null,
        item: d.items.slice(0, 500),
        qty: Math.max(1, d.pieces),
        amount_cents: Math.round(d.deposit * 100),
        payment_method: d.payment,
        status: "held",
        booking_id: d.bookingId ?? null,
        expected_date: d.expectedDate ?? null,
        note: `50% deposit $${d.deposit} of $${d.orderTotal}. Balance due $${balanceDue(d.orderTotal, d.deposit)}. Buyer says it's sent: Josh confirms it arrived.`,
        created_by: "Bot",
        ...(d.isTest ? { is_test: true } : {}),
      }),
    });
    if (!res.ok) throw new Error(`deposit HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  };
}
