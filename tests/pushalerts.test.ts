import { describe, expect, it } from "vitest";
import { allNotifiers, crmPusher, pushNotifier, type PushRow } from "../src/pushalerts.js";

const fakeFetch = (status: number, calls: { url: string; init: RequestInit }[]) =>
  (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(null, { status });
  }) as unknown as typeof fetch;

describe("phone-push alerts through the CRM", () => {
  it("writes one notifications row with the service key, never delivered_at", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    await crmPusher("https://x.supabase.co/rest/v1/", "secret-key", fakeFetch(201, calls))({ type: "needs_human", title: "t" });
    expect(calls[0].url).toBe("https://x.supabase.co/rest/v1/notifications");
    const h = calls[0].init.headers as Record<string, string>;
    expect(h.apikey).toBe("secret-key");
    expect(h.Authorization).toBe("Bearer secret-key");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ type: "needs_human", title: "t" });
  });

  it("a duplicate (409) is fine, a real failure throws", async () => {
    await expect(crmPusher("https://x.supabase.co", "sb_secret_1", fakeFetch(409, []))({ type: "a", title: "b" })).resolves.toBeUndefined();
    await expect(crmPusher("https://x.supabase.co", "sb_secret_1", fakeFetch(500, []))({ type: "a", title: "b" })).rejects.toThrow("500");
  });

  it("a paused chat is a high-priority needs_human push, deduped per 10 minutes; test buyers are TEST", async () => {
    const rows: PushRow[] = [];
    const n = pushNotifier(async (r) => void rows.push(r), () => 1_000_000_000);
    await n({ account: "triangle", route: "team", reason: "asks if it's real", summary: "wants the hoodie", userId: "123", username: "buyer" });
    await n({ account: "triangle", route: "team", reason: "paid", summary: "$50 cash app", userId: "e2e-test-1", paused: false });
    expect(rows[0]).toMatchObject({ type: "needs_human", priority: "high", conversation_id: "123", title: "@buyer needs a human" });
    expect(rows[0].dedupe_key).toBe(`handoff:123:asks if it's real:${Math.floor(1_000_000_000 / 600_000)}`);
    expect(rows[0].is_test).toBeUndefined();
    expect(rows[1]).toMatchObject({ type: "fyi", priority: "normal", is_test: true });
  });

  it("a failing push never breaks the chat, and the other target still gets it", async () => {
    let discord = 0;
    const n = allNotifiers(pushNotifier(async () => { throw new Error("down"); }), async () => void discord++);
    await expect(n({ account: "a", route: "team", reason: "r", summary: "s", userId: "1" })).resolves.toBeUndefined();
    expect(discord).toBe(1);
  });
});
