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
