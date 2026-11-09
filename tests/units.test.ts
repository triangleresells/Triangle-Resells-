import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildSystemPrompt, toApiMessages } from "../src/ai.js";
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
