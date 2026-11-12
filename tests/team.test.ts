import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";

describe("/team/assistant route", () => {
  const ORIGIN = "https://crm.triangleresells.test";
  function start() {
    const calls: { token: string; body: unknown }[] = [];
    const app = createServer({ handle: async () => {} }, {
      appSecret: "s", verifyToken: "v",
      assistant: { origin: ORIGIN, handle: async (token, body) => (calls.push({ token, body }), { status: 200, body: { reply: "hi" } }) },
    });
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    return { base, calls, close: () => server.close() };
  }

  it("lets only the CRM's own site call it (CORS)", async () => {
    const s = start();
    try {
      const ok = await fetch(`${s.base}/team/assistant`, { method: "OPTIONS", headers: { Origin: ORIGIN } });
      expect(ok.status).toBe(204);
      expect(ok.headers.get("access-control-allow-origin")).toBe(ORIGIN);
      const other = await fetch(`${s.base}/team/assistant`, { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
      expect(other.status).toBe(403);
      expect(other.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      s.close();
    }
  });

  it("needs a login token, and takes a screenshot-sized message", async () => {
    const s = start();
    try {
      expect((await fetch(`${s.base}/team/assistant`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(401);
      const big = { messages: [{ role: "user", text: "restock", images: [{ mediaType: "image/jpeg", data: "A".repeat(3_000_000) }] }] };
      const res = await fetch(`${s.base}/team/assistant`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer tok123", Origin: ORIGIN }, body: JSON.stringify(big) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ reply: "hi" });
      expect(s.calls[0].token).toBe("tok123");
    } finally {
      s.close();
    }
  });
});

describe("sales tracker import (reading the tabs)", async () => {
  const { parseTrackerTab, itemsOf, dateOf, moneyOf, monthTabs, colIndex, previewByMonth } = await import("../src/team/importsales.js");
  /** A month tab like Josh's: title rows, headers on row 5, data from row 6. */
  function tab() {
    const rows: string[][] = [["Triangle Resells Sales Tracker"], [], [], [], []];
    const head = rows[4];
    const set = (r: string[], col: string, v: string) => (r[colIndex(col)] = v);
    ["Date", "Sales Channel", "Handle", "Products Sold", "Product Cost", "Order Total", "Platform Fee", "Label Cost", "Profit", "Payment Method", "Confirmed", "Buyer Name", "Phone", "Street Address", "Apt", "City", "State", "Country", "Zip"]
      .forEach((h, i) => (head[i] = h));
    set(head, "Y", "Fulfilled"); set(head, "Z", "Tracking Number"); set(head, "AA", "Notes");
    ["Date", "Closer", "Buyer", "Products", "Cost", "Sale", "Profit", "Payment", "Deposit", "Confirmed", "Meetup Notes"].forEach((h, i) => set(head, ["AD", "AE", "AF", "AG", "AH", "AI", "AJ", "AK", "AL", "AM", "AN"][i], h));
    const r6: string[] = [];
    ["11/3/2026", "Instagram", "@ship_buyer", "2x Alo Hoodie Gray M, 1x Bleu de Chanel", "$62.00", "$170.00", "$3.50", "$8.00", "", "Cash App", "Yes", "Jordan Ellis", "919-555-0100", "1 Main St", "", "Atlanta", "GA", "USA", "30305"].forEach((v, i) => (r6[i] = v));
    set(r6, "Z", "1ZOLD"); set(r6, "AD", "11/5"); set(r6, "AE", "Chema"); set(r6, "AF", "@meet_buyer"); set(r6, "AG", "Chrome Hearts Hat x2"); set(r6, "AH", "24"); set(r6, "AI", "70"); set(r6, "AK", "cash"); set(r6, "AN", "parking lot");
    const r7: string[] = [];
    set(r7, "AD", "11/9/26"); set(r7, "AE", "Diego"); set(r7, "AF", "Marcus"); set(r7, "AG", "Spider hoodie"); set(r7, "AI", "$80");
    rows.push(r6, r7, [], []);
    return rows;
  }

  it("reads online orders (A-AA) and meetups (AD-AN) by their headers", () => {
    const rows = parseTrackerTab("Nov 2026", tab());
    expect(rows).toEqual([
      { key: "Nov 2026!A6", date: "2026-11-03", channel: "Instagram", handle: "@ship_buyer", buyer_name: "Jordan Ellis", phone: "919-555-0100",
        products: "2x Alo Hoodie Gray M, 1x Bleu de Chanel", cost: "62", total: "170", platform_fee: "3.5", label_cost: "8", payment: "Cash App",
        fulfillment: "ship", location: "1 Main St, Atlanta, GA, 30305", tracking: "1ZOLD", notes: undefined,
        items: [{ item: "Alo Hoodie Gray M", qty: 2 }, { item: "Bleu de Chanel", qty: 1 }] },
      { key: "Nov 2026!AD6", date: "2026-11-05", channel: "Meetup", closer: "Chema", handle: "@meet_buyer", products: "Chrome Hearts Hat x2",
        cost: "24", total: "70", payment: "cash", fulfillment: "pickup", notes: "parking lot", items: [{ item: "Chrome Hearts Hat", qty: 2 }] },
      { key: "Nov 2026!AD7", date: "2026-11-09", channel: "Meetup", closer: "Diego", buyer_name: "Marcus", products: "Spider hoodie",
        cost: undefined, total: "80", payment: undefined, fulfillment: "pickup", notes: undefined, items: [{ item: "Spider hoodie", qty: 1 }] },
    ]);
    expect(previewByMonth(rows)).toEqual(["Nov 2026: 3 sales, $320.00"]);
  });

  it("handles messy cells and picks only month tabs (skipping Oct 2026)", () => {
    expect(itemsOf("3 x BAPE Tee + Supreme Hoodie and 2x Gia Set")).toEqual([{ item: "BAPE Tee", qty: 3 }, { item: "Supreme Hoodie", qty: 1 }, { item: "Gia Set", qty: 2 }]);
    expect(dateOf("2026-12-01", 2026)).toBe("2026-12-01");
    expect(dateOf("Dec 1", 2026)).toBeUndefined();
    expect(moneyOf("$1,234.50")).toBe("1234.5");
    expect(moneyOf("TBD")).toBeUndefined();
    expect(monthTabs(["Summary", "Oct 2026", "Nov 2026", "Dec 2026", "Template"])).toEqual(["Nov 2026", "Dec 2026"]);
  });
});

describe("video hooks", async () => {
  const { missingFor, parseIdeas } = await import("../src/team/hooks.js");
  const goals = { resells: 3, scales: 2, sales: 6 };

  it("only fills what's missing, and Sales needs its meetup video", () => {
    const ideas = [{ account: "resells" as const, meetup: false }, { account: "sales" as const, meetup: false }];
    expect(missingFor(goals, ideas)).toEqual({ need: { resells: 2, scales: 2, sales: 5 }, needsMeetup: true, total: 9 });
    expect(missingFor(goals, [...ideas, { account: "sales" as const, meetup: true }]).needsMeetup).toBe(false);
  });

  it("keeps valid hooks, drops repeats, junk and extras", () => {
    const text = `Sure! {"ideas": [
      {"account": "resells", "hook": "I sold 40 hoodies in one parking lot"},
      {"account": "resells", "hook": "How to start reselling in 2026"},
      {"account": "resells", "hook": "A third resells hook"},
      {"account": "scales", "hook": "The vendor mistake that cost me $500"},
      {"account": "tiktok", "hook": "wrong account"},
      {"account": "sales", "hook": "Meetup run: 6 orders tonight", "meetup": true}]}`;
    expect(parseIdeas(text, { resells: 1, scales: 1, sales: 1 }, ["How to start reselling in 2026"])).toEqual([
      { account: "resells", hook: "I sold 40 hoodies in one parking lot" },
      { account: "scales", hook: "The vendor mistake that cost me $500" },
      { account: "sales", hook: "Meetup run: 6 orders tonight", meetup: true },
    ]);
    expect(parseIdeas("no json here", { resells: 1, scales: 0, sales: 0 }, [])).toEqual([]);
  });
});

describe("team notifications -> Discord", async () => {
  const { NotifySync } = await import("../src/team/notify.js");
  const { Store } = await import("../src/store.js");

  it("starts from now, posts in order, retries a failed post, and never reposts after a restart", async () => {
    const all = [1, 2, 3].map((id) => ({ id, kind: "booked", text: `note ${id}`, is_test: false }));
    let latest = 0;
    const crm = { notifications: async (after: number | null) => ({ notifications: after === null ? [] : all.filter((n) => n.id > after && n.id <= latest), latest }) };
    const posted: string[] = [];
    let failOn = "";
    const post = async (t: string) => { if (t === failOn) throw new Error("Discord down"); posted.push(t); };
    const store = new Store();
    const sync = new NotifySync({ crm, store, post });
    await sync.tick(); // first run: start from now (latest = 0)
    latest = 3;
    failOn = "note 2";
    expect(await sync.tick()).toBe(1);
    expect(posted).toEqual(["note 1"]);
    failOn = "";
    expect(await sync.tick()).toBe(2);
    expect(posted).toEqual(["note 1", "note 2", "note 3"]);
    // Restart: the saved place means nothing is posted again.
    const store2 = new Store();
    store2.restore(store.snapshot());
    expect(await new NotifySync({ crm, store: store2, post }).tick()).toBe(0);
  });
});
