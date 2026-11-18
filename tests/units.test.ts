import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildSystemBlocks, buildSystemPrompt, ClaudeAgent, claimsSaved, CONFIRM_LINE, CONFIRM_LINE_ES, dropCorrection, unbackedClaims, looksReadyToBook, phantomCorrection, toApiMessages, type OrderTools } from "../src/ai.js";
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

describe("Spanish buyers", async () => {
  const { looksSpanish } = await import("../src/language.js");
  const { quietNudgeText, followUpText } = await import("../src/bot.js");
  it("spots Spanish and Spanglish, not English", () => {
    expect(looksSpanish(["hola cuanto sale la sudadera alo"])).toBe(true);
    expect(looksSpanish(["q onda wey tienes la playera en M", "xfa"])).toBe(true);
    expect(looksSpanish(["yo u got the alo hoodie in M bro", "how much"])).toBe(false);
    expect(looksSpanish(["ok", "M"])).toBe(false);
  });
  it("the automatic follow-ups go out in Spanish to Spanish buyers", () => {
    expect(quietNudgeText("1x Alo Hoodie Black XS", undefined, true)).toMatch(/^Hola, aquí sigo con tu pedido: 1x Alo Hoodie Black XS\./);
    expect(followUpText("1x Alo Hoodie", true)).toContain("link de pago");
    expect(quietNudgeText("1x Alo Hoodie")).toMatch(/^Hey, still got you/);
  });
});

describe("answers the newest message (no phantom corrections)", () => {
  function agentWith(responses: object[]) {
    const agent = new ClaudeAgent("k", "m", "rules", "kb");
    const calls: any[] = [];
    (agent as any).client = { messages: { create: async (req: any) => (calls.push(structuredClone(req)), responses.shift()) } };
    return { agent, calls };
  }
  const text = (t: string) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
  const withTool = (draft: string) => ({
    content: [{ type: "text", text: draft }, { type: "tool_use", id: "q1", name: "quote_order", input: { items: [{ product: "Essentials Hoodie", qty: 1 }], fulfillment: "pickup" } }],
    stop_reason: "tool_use",
  });
  const tools: OrderTools = { quote: () => "Essentials Hoodie is INCOMING, not in stock yet." };
  // Josh's real test chat, Nov 17 2026.
  const joshChat = [
    { role: "user" as const, text: "Hello" },
    { role: "assistant" as const, text: "Hey, welcome to Triangle Resells. What are you looking for today?" },
    { role: "user" as const, text: "Do you have any essentials available" },
  ];

  it("root cause: an unsent draft before a tool call is hidden from the AI, and only the final text is sent", async () => {
    const { agent, calls } = agentWith([withTool("Yes, Essentials land this week."), text("Not in stock right now.")]);
    const r = await agent.reply(joshChat, "", tools);
    expect(r.text).toBe("Not in stock right now.");
    const assistantTurn = calls[1].messages.at(-2);
    expect(assistantTurn.role).toBe("assistant");
    expect(assistantTurn.content.some((b: any) => b.type === "text")).toBe(false);
    expect(JSON.stringify(calls[1].messages)).not.toContain("land this week");
    expect(JSON.stringify(calls[1].messages.at(-1))).toContain("nothing from this reply has been sent yet");
  });

  it("an empty final round falls back to the latest draft only, never several drafts joined", async () => {
    const { agent } = agentWith([withTool("Draft one."), withTool("We don't have Essentials in right now."), text("")]);
    const r = await agent.reply(joshChat, "", tools);
    expect(r.text).toBe("We don't have Essentials in right now.");
  });

  it("Josh's exact chat: the 'correct my last text' reply is rewritten into a direct answer", async () => {
    const { agent, calls } = agentWith([
      text('Sorry, I need to correct my last text: the new batch lands Monday and Tuesday, not just "this week."'),
      text("We don't have any Essentials in stock right now."),
    ]);
    const r = await agent.reply(joshChat, "", tools);
    expect(r.text).toBe("We don't have any Essentials in stock right now.");
    expect(calls[1].tool_choice).toEqual({ type: "none" });
  });

  it("if the rewrite still corrects a phantom text, that sentence is cut", async () => {
    const { agent } = agentWith([
      text("Sorry, I need to correct my last text: it lands Monday. We're out of Essentials right now."),
      text("Correction: my last text was wrong, it's Tuesday."),
    ]);
    const r = await agent.reply(joshChat, "", tools);
    expect(r.text).toBe("We're out of Essentials right now.");
  });

  const opener = (u: string, b: string, q: string) => [
    { role: "user" as const, text: u },
    { role: "assistant" as const, text: b },
    { role: "user" as const, text: q },
  ];
  it.each([
    ["Josh's chat", joshChat, 'Sorry, I need to correct my last text: the new batch lands Monday and Tuesday, not just "this week."'],
    ["first message", [{ role: "user" as const, text: "Do you have any essentials available?" }], "Quick correction to my last message: Essentials are $60."],
    ["yo + essentials", opener("yo", "Hey, what can I get you?", "u got essentials?"), "Correcting my previous text, the restock is next week."],
    ["hi + hoodie size", opener("Hi", "Hey! What are you looking for?", "Any Essentials hoodies in M?"), "My last message was wrong, it lands Tuesday."],
    ["sweatpants price", opener("hey", "Hey, what you need?", "how much are the essentials sweatpants"), "Scratch that, they're $55."],
    ["CH hats", opener("Hello", "Hey, welcome in.", "Do you have any Chrome Hearts hats?"), "I misspoke earlier, the hats are $25."],
    ["Alo colors", opener("sup", "What's good, what you looking for?", "what colors the alo hoodie come in"), "Correction: the Alo restock is Friday."],
    ["shipping", opener("Hello", "Hey! What can I help you find?", "Do you ship to Texas?"), "Let me fix my last text: shipping is $15."],
    ["spider", opener("hey bro", "Hey, what you need?", "is the spider hoodie still available"), "Update to my earlier message: Spider lands Monday."],
    ["fragrance", opener("Hello", "Hey there.", "How much is the Bleu de Chanel?"), "Sorry, my previous text was a typo, it's $70."],
    ["spanish", opener("hola", "Hola, ¿qué buscas?", "tienen essentials?"), "Correction: my last text said this week, it's next week."],
    ["BAPE", opener("Good morning", "Morning! What can I get you?", "Do you have any BAPE tees?"), "Correcting my last message: BAPE lands Tuesday Nov 17."],
  ])("flags a phantom correction (%s)", (_name, history, reply) => {
    expect(phantomCorrection(reply, history)).toBe(true);
  });

  it("allows a real correction of a detail that is in a text the bot actually sent", () => {
    const history = opener("how much for the valley hoodie", "The Valley hoodie is $65.", "ok");
    expect(phantomCorrection("Correction to my last text: the Valley hoodie is $60, not $65.", history)).toBe(false);
  });

  it("ignores normal replies", () => {
    expect(phantomCorrection("We don't have Essentials in stock right now.", joshChat)).toBe(false);
    expect(phantomCorrection("Got you, I'll update the order to size L.", joshChat)).toBe(false);
  });

  it("dropCorrection keeps the real answer", () => {
    expect(dropCorrection("Sorry, I need to correct my last text: it lands Monday. We're out right now.")).toBe("We're out right now.");
  });
});

describe("no invented facts (pre-send check)", () => {
  const KB = [
    "- Sizing: Essentials runs a size up (an Essentials XS fits like a small). BAPE, Supreme, Alo and Spider are true to size.",
    "- \"Returns / exchanges?\" All sales are final.",
  ].join("\n");

  it.each([
    ["authenticity", "Yes, they're 100% authentic."],
    ["authenticity", "These are real, all legit."],
    ["authenticity", "Sí, son originales."],
    ["sourcing", "We get them straight from the brand."],
    ["sourcing", "They come with retail receipts."],
    ["refund", "If it doesn't fit we can exchange it."],
    ["refund", "You'll get your money back if anything's wrong."],
    ["refund", "Quality is guaranteed."],
    ["delivery_date", "Shipped UPS, it'll arrive by Friday."],
    ["delivery_date", "With shipping you'll get it in 2-3 business days."],
    ["fabric", "The Valley hoodie is 100% cotton, heavyweight."],
    ["fit", "The Valley hoodie runs small."],
    ["fit", "Godspeed tees are true to size."],
    ["restock_date", "The new batch lands next week."],
  ])("blocks an unbacked %s claim: %s", (kind, text) => {
    expect(unbackedClaims(text, KB).map((c) => c.kind)).toContain(kind);
  });

  it.each([
    "Essentials runs a size up, so an XS fits like a small.",
    "Alo is true to size.",
    "All sales are final, no returns or refunds.",
    "Let me have the team confirm that, give me a quick sec.",
    "Is it cotton? Let me check with the team on that.",
    "Locked in for Saturday 2 PM pickup. Cash at pickup.",
    "Delivery to Durham Saturday afternoon is $10.",
    "Black XS and Gray M, $70 each.",
  ])("lets a backed or harmless line through: %s", (text) => {
    expect(unbackedClaims(text, KB)).toEqual([]);
  });

  it("a fit note for one brand doesn't cover another", () => {
    expect(unbackedClaims("Valley is true to size.", KB).map((c) => c.kind)).toEqual(["fit"]);
  });

  it("a fact a tool returned counts as backed", () => {
    expect(unbackedClaims("It ships UPS, it'll arrive in 3 days.", KB + "\nquote_order: UPS ground, arrives in 3 days")).toHaveLength(1); // still never promised
    expect(unbackedClaims("The Gia set is cotton.", KB + "\nGia Set (cotton), $90")).toEqual([]);
  });

  function agentWith(responses: object[], kb = KB) {
    const agent = new ClaudeAgent("k", "m", "rules", kb);
    const calls: any[] = [];
    (agent as any).client = { messages: { create: async (req: any) => (calls.push(structuredClone(req)), responses.shift()) } };
    return { agent, calls };
  }
  const text = (t: string) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });

  it("rewrites an invented fabric claim into the confirm line and alerts the team (chat keeps going)", async () => {
    const { agent, calls } = agentWith([text("Yeah it's 100% cotton, heavyweight. $65."), text("It's $65. Let me have the team confirm that, give me a quick sec.")]);
    const r = await agent.reply([{ role: "user", text: "is the valley hoodie cotton? how much" }], "Valley Hoodie Black L $65");
    expect(r.text).toBe("It's $65. Let me have the team confirm that, give me a quick sec.");
    expect(r.handoff).toBeUndefined();
    expect(r.alerts?.[0]).toMatchObject({ kind: "question", summary: "is the valley hoodie cotton? how much" });
    expect(JSON.stringify(calls[1].messages)).toContain("nothing backs up");
  });

  it("if the rewrite still invents it, those sentences are cut (or the confirm line is sent)", async () => {
    const { agent } = agentWith([text("They're 100% authentic."), text("Yes, all legit.")]);
    const r = await agent.reply([{ role: "user", text: "are these real?" }], "");
    expect(r.text).toBe(CONFIRM_LINE);
  });

  it("Spanish buyers get the Spanish confirm line", async () => {
    const { agent } = agentWith([text("Sí, son originales."), text("Sí, son originales.")]);
    const r = await agent.reply([{ role: "user", text: "hola son originales las playeras?" }], "");
    expect(r.text).toBe(CONFIRM_LINE_ES);
  });
});

describe("restock dates are backed only by a restock line", () => {
  it("allows the day on the restock line, blocks any other", () => {
    const src = "INCOMING RESTOCK (landing Monday Nov 16 and Tuesday Nov 17, 2026)";
    expect(unbackedClaims("The restock is landing Monday and Tuesday.", src)).toEqual([]);
    expect(unbackedClaims("The restock is landing Friday.", src).map((c) => c.kind)).toEqual(["restock_date"]);
    expect(unbackedClaims("The restock is landing Monday.", "Pickup Monday 10am-10pm").map((c) => c.kind)).toEqual(["restock_date"]);
  });
});
