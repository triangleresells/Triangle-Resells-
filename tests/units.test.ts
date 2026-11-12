import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildSystemBlocks, buildSystemPrompt, ClaudeAgent, claimsSaved, looksReadyToBook, toApiMessages, type OrderTools } from "../src/ai.js";
import { formatAlert } from "../src/handoff.js";
import { splitMessage } from "../src/instagram.js";
import { parsePricesCsv, parseStockCsv } from "../src/catalog.js";
import { isBareKeyword, matchKeyword } from "../src/keywords.js";
import { isValidSignature } from "../src/signature.js";
import { loadConfig } from "../src/config.js";

describe("signature", () => {
  const secret = "shh";
  const body = Buffer.from('{"object":"instagram"}');
  const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

  it("accepts Meta's real signature", () => expect(isValidSignature(body, sig, secret)).toBe(true));
  it("rejects a wrong one", () => expect(isValidSignature(body, "sha256=" + "0".repeat(64), secret)).toBe(false));
  it("rejects a missing one", () => expect(isValidSignature(body, undefined, secret)).toBe(false));
});

describe("keywords", () => {
  const rules = [{ account: "x", keyword: "PRICE", reply: "r" }];
  it("matches case-insensitively as a whole word", () => {
    expect(matchKeyword("price?", rules)).toBeDefined();
    expect(matchKeyword("whats the PRICE on that", rules)).toBeDefined();
    expect(matchKeyword("priceless", rules)).toBeUndefined();
  });
  it("knows a bare keyword from a question", () => {
    expect(isBareKeyword(" Price! ", rules[0])).toBe(true);
    expect(isBareKeyword("price on hoodies", rules[0])).toBe(false);
  });
});

describe("warehouse sheet tabs", () => {
  it("finds the header under the title row and reads stock rows", () => {
    const csv = 'BOT STOCK - read me,,,\nCategory,Brand,Item,Color,Size,Qty,Price List,Status,Notes\nHoodie,Alo,Alo Hoodie,Black,XS,2.0,ALO,FOR SALE,\n,,,,,,,,\nFragrance,Baccarat,Baccarat Rouge,,,~60,,FREEBIE,"Never sell, 1 free"\n';
    const rows = parseStockCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ item: "Alo Hoodie", qty: 2, priceList: "ALO", status: "for_sale" });
    expect(rows[1]).toMatchObject({ qty: 60, status: "freebie", notes: "Never sell, 1 free" });
  });

  it("reads per-piece prices, with $ signs, and works from Total when Each is blank", () => {
    const csv = "BOT PRICES,,,,\nPrice List,Pieces,Total,Each,Notes\nALO,1,$70.00,$70.00,\nALO,2,104,,\n,,,,\n";
    expect(parsePricesCsv(csv)).toEqual({ ALO: { "1": 70, "2": 52 } });
  });
});

describe("ai helpers", () => {
  it("merges same-speaker turns and starts with the customer", () => {
    const msgs = toApiMessages([
      { role: "assistant", text: "a" },
      { role: "user", text: "hi" },
      { role: "user", text: "u there" },
      { role: "assistant", text: "yo" },
    ]);
    expect(msgs).toEqual([
      { role: "user", content: "hi\nu there" },
      { role: "assistant", content: "yo" },
    ]);
  });

  it("puts the live sheet in the prompt only when there is one", () => {
    expect(buildSystemPrompt("I", "KB", "")).not.toContain("LIVE STOCK");
    expect(buildSystemPrompt("I", "KB", "Item | Price")).toContain("LIVE STOCK");
  });

  it("caches the instructions, knowledge base and sheet, and keeps the clock and schedule after the cache", () => {
    const now = new Date("2026-11-12T19:00:00Z");
    const [head, tail] = buildSystemBlocks("I", "KB", "Item | Price", now, "Fri 4 PM taken");
    expect(head.cache_control).toEqual({ type: "ephemeral" });
    expect(head.text).toContain("LIVE STOCK");
    expect(head.text).not.toMatch(/TODAY|PICKUP SCHEDULE/);
    expect(tail.cache_control).toBeUndefined();
    expect(tail.text).toContain("PICKUP SCHEDULE");
    expect(tail.text).toContain("2:00 PM");
    // A minute later only the uncached block changes.
    expect(buildSystemBlocks("I", "KB", "Item | Price", new Date(now.getTime() + 60_000))[0].text).toBe(head.text);
  });
});

describe("misc", () => {
  it("splits long DMs under 1,000 characters on word boundaries", () => {
    const parts = splitMessage("word ".repeat(450));
    expect(parts.length).toBe(3);
    expect(parts.every((p) => p.length <= 1000)).toBe(true);
  });

  it("formats handoff alerts with a profile link", () => {
    const msg = formatAlert({
      account: "Triangle Resells",
      route: "team",
      reason: "ready to buy",
      summary: "Black hoodie, L, Texas",
      userId: "1",
      username: "buyer",
    });
    expect(msg).toContain("instagram.com/buyer");
    expect(msg).toContain("ready to buy");
  });

  it("loads the real config files and keeps only this account's keywords", () => {
    const cfg = loadConfig({
      IG_APP_SECRET: "a",
      IG_ACCESS_TOKEN: "b",
      IG_VERIFY_TOKEN: "c",
      ANTHROPIC_API_KEY: "d",
      ACCOUNT_NAME: "Triangle Resells",
    });
    expect(cfg.keywords.map((k) => k.keyword).sort()).toEqual(["PRICE", "RESTOCK", "SHIP"]);
    expect(cfg.agentInstructions).toContain("DM assistant for Triangle Resells");
    expect(cfg.agentInstructions).not.toContain("{{");
    expect(cfg.knowledgeBase).toContain("Elite Vendor Bundle: $89.99");
  });

  it("refuses to start without required secrets", () => {
    expect(() => loadConfig({})).toThrow(/IG_APP_SECRET/);
  });
});

describe("claimsSaved (bot says they're on the list)", () => {
  it.each([
    "I've saved you on the list for an XL and a L.",
    "I also just saved your Chrome Hearts hoodie request",
    "Bet, I've got you down for one Black Medium at $100.",
    "I've saved your interest in a L.",
    "You're on the restock list now, I'll DM you first when it lands.",
    "Got you down for 2 in M 🔥",
    "I'll put you down for the black L.",
  ])("catches %s", (t) => expect(claimsSaved(t)).toBe(true));

  it.each([
    "Want me to put you down for one?",
    "Got you, Jordan. Cash App works.",
    "Restock is coming soon, I'll DM you first when it lands.",
    "I have it in XL for $35. Pickup or shipped?",
    "Should I save you a spot on the list?",
    "Locked in, Jordan. Send the Cash App payment to $X for $70.",
  ])("ignores %s", (t) => expect(claimsSaved(t)).toBe(false));
});

describe("lock-in guard", () => {
  it.each([
    "1x Bleu de Chanel @ $60, free Baccarat. Total $60. All sales final. Should I lock it in?",
    "Want me to lock it in with Zelle?",
    "Should I lock that in for you?",
    "All sales are final.",
  ])("spots an unbooked close: %s", (t) => expect(looksReadyToBook(t)).toBe(true));
  it.each(["Pickup or shipped?", "Locked in, Jordan. Send $70 to $X.", "What size you need?"])("ignores %s", (t) =>
    expect(looksReadyToBook(t)).toBe(false),
  );

  /** A fake Claude that replies with the given responses in order. */
  function agentWith(responses: object[]) {
    const agent = new ClaudeAgent("k", "m", "rules", "kb");
    const calls: any[] = [];
    (agent as any).client = { messages: { create: async (req: any) => (calls.push(req), responses.shift()) } };
    return { agent, calls };
  }
  const text = (t: string) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
  const submit = { content: [{ type: "tool_use", id: "t1", name: "submit_order", input: { items: [{ product: "Bleu de Chanel", qty: 1 }], fulfillment: "pickup", fulfill_date: "2026-11-14", fulfill_time: "2:00 PM", payment: "cash" } }], stop_reason: "tool_use" };
  const tools = (booked: unknown[]): OrderTools => ({
    quote: () => "",
    submitOrder: async (...a) => (booked.push(a), { ok: true, total: 60, summary: "1x Bleu", freebies: [], payText: "Cash at pickup." }),
  });

  it("books the order instead of asking permission, and replaces the permission question", async () => {
    const booked: unknown[] = [];
    const { agent, calls } = agentWith([text("Total $60. All sales final. Should I lock it in?"), submit, text("Locked in for Sat 2 PM. All sales final. Cash at pickup.")]);
    const r = await agent.reply([{ role: "user", text: "1 bleu, pickup sat 2pm, cash" }], "", tools(booked));
    expect(booked).toHaveLength(1);
    expect(r.text).toBe("Locked in for Sat 2 PM. All sales final. Cash at pickup.");
    expect(calls[1].tools.map((t: any) => t.name).sort()).toEqual(["handoff_to_team", "submit_order"]);
  });

  it("keeps the first reply when something is really missing", async () => {
    const booked: unknown[] = [];
    const { agent } = agentWith([text("Total $60. All sales final. Cash, Cash App or Zelle?"), text("MISSING")]);
    const r = await agent.reply([{ role: "user", text: "1 bleu, pickup sat 2pm" }], "", tools(booked));
    expect(booked).toHaveLength(0);
    expect(r.text).toBe("Total $60. All sales final. Cash, Cash App or Zelle?");
  });
});
