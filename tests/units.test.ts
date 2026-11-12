import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildSystemPrompt, normalizeHandoff, pickHandoff, toApiMessages } from "../src/ai.js";
import { formatAlert } from "../src/handoff.js";
import { splitMessage } from "../src/instagram.js";
import { formatInventoryCsv, InventorySheet } from "../src/inventory.js";
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

describe("inventory sheet", () => {
  it("keeps the header and drops blank rows", () => {
    const csv = 'Item,Price,In stock\nBlack hoodie,$75,Yes\n,,\n"Perfume, 100ml",$60,No\n';
    expect(formatInventoryCsv(csv)).toBe("Item | Price | In stock\nBlack hoodie | $75 | Yes\nPerfume, 100ml | $60 | No");
  });

  it("caches and survives a failed fetch", async () => {
    let calls = 0;
    const fake = (async () => {
      calls++;
      if (calls > 1) throw new Error("down");
      return new Response("Item,Price\nTee,$45\n");
    }) as typeof fetch;
    const sheet = new InventorySheet("https://example.com/sheet.csv", fake);
    expect(await sheet.get()).toContain("Tee | $45");
    expect(await sheet.get()).toContain("Tee | $45");
    expect(calls).toBe(1);
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
    expect(buildSystemPrompt("I", "KB", "")).not.toContain("LIVE INVENTORY");
    expect(buildSystemPrompt("I", "KB", "Item | Price")).toContain("LIVE INVENTORY");
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

describe("handoff tool input", () => {
  it("fills missing fields from a truncated tool call", () => {
    expect(normalizeHandoff({ route: "team" })).toEqual({
      route: "team",
      reason: "handoff requested",
      summary: "No summary given. Check the chat.",
    });
    expect(normalizeHandoff({ route: "nope", reason: " refund " }).route).toBe("team");
  });

  it("keeps the josh route when the model calls the tool twice", () => {
    const josh = normalizeHandoff({ route: "josh", reason: "refund", summary: "stained hoodie" });
    const team = normalizeHandoff({ route: "team", reason: "upset", summary: "x" });
    expect(pickHandoff(josh, team)).toBe(josh);
    expect(pickHandoff(team, josh)).toBe(josh);
    expect(pickHandoff(undefined, team)).toBe(team);
  });
});
