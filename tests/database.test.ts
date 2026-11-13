import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ReplyEngine } from "../src/ai.js";
import { Bot } from "../src/bot.js";
import { customersCsv, matchCustomers } from "../src/customers.js";
import type { InstagramApi } from "../src/instagram.js";
import { FileSaver } from "../src/persist.js";
import { createServer } from "../src/server.js";
import { Store } from "../src/store.js";

const dir = mkdtempSync(path.join(tmpdir(), "triangle-db-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function makeBot(store: Store, agent: ReplyEngine["reply"] = async () => ({ text: "ok" })) {
  const sent: { to: string; text: string }[] = [];
  const ig: InstagramApi = {
    sendText: vi.fn(async (to, text) => {
      sent.push({ to, text });
      return `mid-${sent.length}`;
    }),
    sendPrivateReply: vi.fn(async () => "m"),
    replyToComment: vi.fn(async () => {}),
    getUsername: vi.fn(async (id: string) => `buyer_${id}`),
  };
  const bot = new Bot({
    ig, agent: { reply: vi.fn(agent) }, store, notify: async () => {}, getInventory: async () => "", accountName: "Triangle Resells",
    keywords: [], publicCommentReplies: [], humanPauseHours: 12,
  });
  const dm = (from: string, text: string, mid: string) =>
    bot.handle({ object: "instagram", entry: [{ id: "own", messaging: [{ sender: { id: from }, recipient: { id: "own" }, message: { mid, text } }] }] });
  return { bot, sent, dm };
}

describe("small database", () => {
  it("keeps chats, pending follow-ups and the customer list across a restart", async () => {
    const file = path.join(dir, "state.json");
    const store1 = new Store();
    const saver1 = new FileSaver(file, store1, 0);
    saver1.watch();
    const { dm } = makeBot(store1, async () => ({ text: "Don't have Pink L right now, I'll DM you first when it lands.", interests: ["Spider Hoodie Pink L"] }));
    await dm("u1", "you got spider pink in L?", "m1");
    store1.setPendingLink("u1", { url: "https://checkout.stripe.com/x", summary: "1x Alo Hoodie Gray M", createdAt: 1 });
    saver1.saveNow();

    // "Redeploy": brand-new store loads the file.
    const store2 = new Store();
    new FileSaver(file, store2).load();
    expect(store2.history("u1").map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(store2.duePendingLinks(Date.now())).toHaveLength(1);
    const c = store2.allCustomers()[0];
    expect(c).toMatchObject({ userId: "u1", username: "buyer_u1" });
    expect(c.interests.map((i) => i.item)).toContain("Spider Hoodie Pink L");
  });

  it("doesn't save pictures to disk", () => {
    const store = new Store();
    store.addTurn("u1", { role: "user", text: "how much", images: [{ mediaType: "image/jpeg", data: "AAAA" }] });
    const snap = store.snapshot();
    expect(JSON.stringify(snap)).not.toContain("AAAA");
    expect(snap.convos[0].turns[0].text).toContain("picture not saved");
  });

  it("survives a missing or broken file", () => {
    const store = new Store();
    new FileSaver(path.join(dir, "nope.json"), store).load();
    expect(store.allCustomers()).toEqual([]);
  });
});

describe("customer list and restock blast", () => {
  it("finds who wants an item, exports a spreadsheet, and only DMs people inside Instagram's 24-hour window", async () => {
    let t = Date.parse("2026-11-05T19:00:00Z");
    const store = new Store(() => t);
    const { bot, sent, dm } = makeBot(store, async () => ({ text: "ok", interests: ["Essentials Hoodie Black L"] }));
    await dm("old", "lmk when essentials restock", "m1"); // messaged 3 days ago
    t += 3 * 86_400_000;
    await dm("new", "need essentials hoodie in L when they land", "m2"); // messaged just now
    store.addInterest("other", "BAPE tee");

    expect(matchCustomers(store.allCustomers(), "essentials").map((c) => c.userId).sort()).toEqual(["new", "old"]);
    const csv = customersCsv(store.allCustomers(), t);
    expect(csv).toContain("https://instagram.com/buyer_new");
    expect(csv).toContain("no (DM them yourself)");

    const before = sent.length;
    const r = await bot.blast("Essentials hoodies just landed, black in XS and L. Want me to set you up?", "essentials");
    expect(r.sent.map((c) => c.userId)).toEqual(["new"]);
    expect(r.manual.map((c) => c.userId)).toEqual(["old"]);
    expect(sent.slice(before)).toEqual([{ to: "new", text: expect.stringContaining("just landed") }]);
  });

  it("records paid orders on the customer", () => {
    const store = new Store();
    const { bot } = makeBot(store);
    bot.markPaid("u9", "2x Alo Hoodie Gray M", 104);
    expect(store.customer("u9").orders[0]).toMatchObject({ summary: "2x Alo Hoodie Gray M", total: 104 });
  });

  it("hides the admin page without the right key", async () => {
    const store = new Store();
    store.addInterest("u1", "Valley hoodie");
    const app = createServer({ handle: async () => {} }, {
      appSecret: "s", verifyToken: "v",
      admin: { key: "secret-key-123", customers: () => store.allCustomers(), blast: async () => ({ sent: [], manual: [] }) },
    });
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      expect((await fetch(`http://127.0.0.1:${port}/admin`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${port}/admin/customers.csv?key=wrong`)).status).toBe(404);
      const ok = await fetch(`http://127.0.0.1:${port}/admin/customers.csv?key=secret-key-123`);
      expect(ok.status).toBe(200);
      expect(await ok.text()).toContain("Valley hoodie");
      const page = await fetch(`http://127.0.0.1:${port}/admin/blast?key=secret-key-123`, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "search=valley&message=Valley+restock",
      });
      expect(await page.text()).toContain("DM these yourself");
    } finally {
      server.close();
    }
  });

  it("won't change an order the CRM owns from the admin page (only in the CRM)", async () => {
    const store = new Store();
    const crmOrder = store.addLabel({ userId: "u1", label: "BOOKED", summary: "1x Valley hoodie", total: 60, payment: "zelle", when: "pickup", crmId: "11111111-1111-1111-1111-111111111111" });
    const own = store.addLabel({ userId: "u2", label: "BOOKED", summary: "1x Valley tee", total: 30, payment: "cash", when: "pickup" });
    const calls: string[] = [];
    const app = createServer({ handle: async () => {} }, {
      appSecret: "s", verifyToken: "v",
      admin: {
        key: "secret-key-123", customers: () => [], blast: async () => ({ sent: [], manual: [] }),
        labels: {
          all: () => store.allLabels(),
          markPaid: async (id) => (calls.push(`paid ${id}`), store.markLabelPaid(id)),
          done: async (id) => (calls.push(`done ${id}`), store.clearLabel(id)),
          doneAll: async () => 0,
          cancel: async (id) => (calls.push(`cancel ${id}`), { ok: store.clearLabel(id) }),
        },
      },
    });
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    const post = (action: string, id: string) =>
      fetch(`http://127.0.0.1:${port}/admin/labels/${action}?key=secret-key-123`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `id=${id}` }).then((r) => r.text());
    try {
      const page = await (await fetch(`http://127.0.0.1:${port}/admin?key=secret-key-123`)).text();
      expect(page).toContain("In the CRM: mark it paid, done or cancelled there.");
      for (const action of ["paid", "clear", "cancel"]) expect(await post(action, crmOrder.id)).toContain("That order is in the CRM");
      expect(calls).toEqual([]);
      expect(await post("cancel", own.id)).toContain("Cancelled.");
      expect(calls).toEqual([`cancel ${own.id}`]);
      expect(store.allLabels().map((l) => l.id)).toEqual([crmOrder.id]);
    } finally {
      server.close();
    }
  });
});

describe("drive times from the warehouse (SE Raleigh)", () => {
  it("Durham meetup is $10 and Knightdale is closer than Durham", () => {
    const pricing = JSON.parse(readFileSync(new URL("../config/pricing.json", import.meta.url), "utf8"));
    expect(pricing.delivery.areas.Durham).toBe(30);
    expect(pricing.delivery.areas.Knightdale).toBeLessThan(pricing.delivery.areas.Durham);
  });
});

describe("paused chats", () => {
  it("lists paused chats and turns the bot back on in all of them (saved to the database)", () => {
    const store = new Store();
    let saves = 0;
    store.onChange = () => saves++;
    store.pause("a", 12);
    store.pause("b", 12);
    expect(store.pausedChats().sort()).toEqual(["a", "b"]);
    expect(store.unpauseAll()).toBe(2);
    expect(store.isPaused("a")).toBe(false);
    expect(store.snapshot().convos.every((c) => c.pausedUntil === 0)).toBe(true);
    expect(saves).toBeGreaterThan(2);
  });
});
