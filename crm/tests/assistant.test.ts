/**
 * The team assistant (src/team) against the local CRM database, logged in as a team member. The AI is scripted (it
 * sends the tool calls Claude would), so these check what the assistant DOES with the CRM, not the AI's wording.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TeamAssistant, UserDbError, type UserDb } from "../../src/team/assistant.js";
import { assistantHandler, parseMessages } from "../../src/team/handler.js";
import { createApi } from "../src/api/handler.js";
import { testDb, type TestDb } from "./pg.js";

let t: TestDb;
beforeAll(async () => {
  t = await testDb();
});
beforeEach(async () => {
  await t.reset();
  await t.seedStock([{ brand: "Essentials", item: "Essentials Hoodie", color: "Black", size: "M", qty: 5, cost: 25 }], false);
});

const NOW = new Date("2026-11-12T20:00:00Z"); // 3 PM ET
type Step = { tool?: { name: string; input: Record<string, unknown> }; text?: string };

/** A scripted Claude: each step is either a tool call or the final text. Records every request. */
function scripted(steps: Step[]) {
  const requests: any[] = [];
  let n = 0;
  const client = {
    messages: {
      create: async (req: any) => {
        requests.push(JSON.parse(JSON.stringify(req)));
        const s = steps.shift()!;
        if (s.tool) return { content: [{ type: "tool_use", id: `t${++n}`, name: s.tool.name, input: s.tool.input }], stop_reason: "tool_use" };
        return { content: [{ type: "text", text: s.text }], stop_reason: "end_turn" };
      },
    },
  };
  return { assistant: new TeamAssistant(client as any, "claude-sonnet-5-5"), requests };
}
const lastToolResult = (req: any) => req.messages.at(-1).content[0].content as string;

describe("team assistant", () => {
  it("logs an in-person sale as the person, takes the stock, and says what it saved", async () => {
    const josh = await t.login("Josh");
    const { assistant, requests } = scripted([
      { tool: { name: "log_sale", input: { date: "2026-11-12", status: "done", customer: { ig_handle: "@jay" }, payment_method: "cash", fulfillment: "pickup",
        assignee: "Josh", items: [{ brand: "Essentials", item: "Essentials Hoodie", color: "Black", size: "M", qty: 2, unit_price: 60 }] } } },
      { text: "Saved: 2x Essentials Hoodie Black M to @jay, $120 cash, Done." },
    ]);
    const r = await assistant.chat(t.asUser(josh), "Josh", [{ role: "user", text: "just sold 2 black ess hoodies M to @jay 120 cash" }], NOW);
    expect(r.reply).toBe("Saved: 2x Essentials Hoodie Black M to @jay, $120 cash, Done.");
    expect(r.changes).toEqual(["Booked a done sale for 2026-11-12: 2x Essentials Hoodie, $120"]);
    const b = (await t.pg.query<{ status: string; created_by: string; source: string; cash_collected_by: string; sale_price: string }>("select * from bookings")).rows[0];
    expect(b).toMatchObject({ status: "done", created_by: "Josh", source: "in_person", cash_collected_by: "Josh", sale_price: "120.00" });
    expect(await t.qty("Essentials Hoodie", "Black", "M", false)).toBe(3);
    // The AI was told who it's talking to and today's date.
    expect(requests[0].system).toContain("talking with Josh");
    expect(requests[0].system).toContain("Thursday 2026-11-12");
  });

  it("passes a refusal back to the AI (e.g. not enough left) instead of failing", async () => {
    const chema = await t.login("Chema");
    const { assistant, requests } = scripted([
      { tool: { name: "log_sale", input: { date: "2026-11-12", status: "done", payment_method: "cash", fulfillment: "pickup", customer: { name: "TEST" },
        items: [{ item: "Essentials Hoodie", color: "Black", size: "M", qty: 9, unit_price: 60 }] } } },
      { text: "Only 5 left of those." },
    ]);
    const r = await assistant.chat(t.asUser(chema), "Chema", [{ role: "user", text: "sold 9 ess hoodies M" }], NOW);
    expect(lastToolResult(requests[1])).toBe("Error: only 5 left of Essentials Hoodie Black M (asked for 9)");
    expect(r.changes).toEqual([]);
    expect((await t.pg.query("select * from bookings")).rows).toHaveLength(0);
  });

  it("reads a restock screenshot into an incoming restock (the picture reaches the AI)", async () => {
    const diego = await t.login("Diego");
    const { assistant, requests } = scripted([
      { tool: { name: "log_restock", input: { name: "Nov 16-17 restock", expected_date: "2026-11-16", items: [
        { brand: "Supreme", item: "Supreme Hoodie", color: "Black", size: "M", qty_expected: 10 },
        { brand: "Supreme", item: "Supreme Hoodie", color: "Black", size: "L", qty_expected: 5 },
      ] } } },
      { text: "Logged the Nov 16-17 restock: Supreme Hoodie Black M x10, L x5." },
    ]);
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==";
    const r = await assistant.chat(t.asUser(diego), "Diego", [{ role: "user", text: "this is whats coming mon/tue", images: [{ mediaType: "image/png", data: png }] }], NOW);
    expect(requests[0].messages[0].content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: png } });
    expect(r.changes).toEqual(['Logged incoming restock "Nov 16-17 restock" (2 lines)']);
    const restock = (await t.pg.query<{ name: string; created_by: string; status: string }>("select * from restocks")).rows[0];
    expect(restock).toMatchObject({ name: "Nov 16-17 restock", created_by: "Diego", status: "incoming" });
  });

  it("'tell the bot': the note is saved and the DM bot reads it from the CRM", async () => {
    const josh = await t.login("Josh");
    const { assistant } = scripted([
      { tool: { name: "tell_bot", input: { note: "The BAPE restock moved to Tuesday Nov 17.", expires_on: "2026-11-18" } } },
      { text: "Got it, the bot will tell buyers Tuesday." },
    ]);
    await assistant.chat(t.asUser(josh), "Josh", [{ role: "user", text: "tell the bot bape moved to tuesday" }], NOW);
    const KEY = "test-bot-key-0123456789-abcdefghijklmnop";
    const api = createApi({ db: t.asService, botApiKey: KEY });
    const res = await (await api(new Request("https://crm.test/api/notes", { headers: { Authorization: `Bearer ${KEY}` } }))).json();
    expect(res.notes).toMatchObject([{ note: "The BAPE restock moved to Tuesday Nov 17.", created_by: "Josh" }]);
    // Expired notes drop off by themselves.
    expect(await t.asService.rpc("bot_notes_active", { p_today: "2026-11-19" })).toEqual([]);
  });

  it("answers from the reports and can undo its own change", async () => {
    const josh = await t.login("Josh");
    const sale = scripted([
      { tool: { name: "log_sale", input: { date: "2026-11-12", status: "done", payment_method: "cash_app", fulfillment: "pickup", customer: { name: "TEST" },
        items: [{ item: "Essentials Hoodie", color: "Black", size: "M", qty: 1, unit_price: 60 }] } } },
      { text: "ok" },
    ]);
    await sale.assistant.chat(t.asUser(josh), "Josh", [{ role: "user", text: "sold one" }], NOW);
    const ask = scripted([
      { tool: { name: "sales_report", input: { from: "2026-11-12", to: "2026-11-12" } } },
      { tool: { name: "recent_changes", input: { limit: 5 } } },
      { text: "Today: $60." },
    ]);
    await ask.assistant.chat(t.asUser(josh), "Josh", [{ role: "user", text: "how much today" }], NOW);
    expect(JSON.parse(lastToolResult(ask.requests[1])).totals).toMatchObject({ revenue: 60, sales: 1 });
    const recent = JSON.parse(lastToolResult(ask.requests[2])) as { id: number; entity: string; action: string }[];
    const created = recent.find((x) => x.entity === "bookings" && x.action === "create")!;
    const undo = scripted([{ tool: { name: "undo", input: { id: created.id } } }, { text: "Undone." }]);
    const r = await undo.assistant.chat(t.asUser(josh), "Josh", [{ role: "user", text: "undo that sale" }], NOW);
    expect(r.changes).toEqual([`Undid change #${created.id}`]);
    expect((await t.pg.query("select * from bookings")).rows).toHaveLength(0);
    expect(await t.qty("Essentials Hoodie", "Black", "M", false)).toBe(5);
  });
});

describe("POST /team/assistant (who can use it)", () => {
  const ok = { messages: [{ role: "user", text: "hi" }] };

  it("only the team: a stranger's login gets 403, an expired login 401, the team gets an answer", async () => {
    const { assistant } = scripted([{ text: "hey Chema" }]);
    const chema = await t.login("Chema");
    const stranger = (await t.pg.query<{ id: string }>("insert into auth.users (email) values ('x@x.com') returning id")).rows[0].id;
    const expired: UserDb = { rpc: async () => { throw new UserDbError("JWT expired", 401); } };
    const handle = assistantHandler({ assistant, dbFor: (tok) => (tok === "expired" ? expired : t.asUser(tok)), now: () => NOW });
    expect(await handle(stranger, ok)).toMatchObject({ status: 403 });
    expect(await handle("expired", ok)).toMatchObject({ status: 401 });
    expect(await handle(chema, ok)).toEqual({ status: 200, body: { who: "Chema", reply: "hey Chema", changes: [] } });
  });

  it("checks the messages it's sent", () => {
    expect(parseMessages({})).toEqual({ error: "messages must be a non-empty list" });
    expect(parseMessages({ messages: [{ role: "system", text: "x" }] })).toMatchObject({ error: expect.stringMatching(/role/) });
    expect(parseMessages({ messages: [{ role: "user", text: "x", images: [{ mediaType: "image/svg+xml", data: "PHN2Zz4=" }] }] })).toMatchObject({ error: expect.stringMatching(/PNG/) });
    expect(parseMessages({ messages: [{ role: "user", text: "a" }, { role: "assistant", text: "b" }] })).toMatchObject({ error: "the last message must be yours" });
    expect(parseMessages({ messages: [{ role: "assistant", text: "hi!" }, { role: "user", text: "yo" }] })).toEqual({ messages: [{ role: "user", text: "yo" }] });
  });
});
