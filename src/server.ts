import { timingSafeEqual } from "node:crypto";
import express, { type Request } from "express";
import { adminPage, customersCsv } from "./customers.js";
import type { Customer, OrderLabel } from "./store.js";
import type { Bot, WebhookPayload } from "./bot.js";
import { isValidSignature } from "./signature.js";
import { isValidStripeSignature, paidOrderFromEvent, type PaidOrder } from "./stripe.js";

type RawRequest = Request & { rawBody?: Buffer };

export interface ServerOpts {
  appSecret: string;
  /** Extra app secrets to accept (Meta may sign with the Facebook app secret instead of the Instagram one). */
  extraAppSecrets?: string[];
  verifyToken: string;
  stripeWebhookSecret?: string;
  onPaidOrder?: (order: PaidOrder) => Promise<void>;
  /** Extra details for /health (Render's health check). Never include secrets. */
  health?: () => Promise<Record<string, unknown>>;
  /**
   * The team assistant (the chat inside the CRM). The CRM page sends the person's login token; the assistant acts as them.
   * origin: the CRM's web address (only that site may call it). Off unless set.
   */
  assistant?: {
    origin: string;
    handle: (accessToken: string, body: unknown) => Promise<{ status: number; body: unknown }>;
  };
  /** Josh's customer list page. Off unless ADMIN_KEY is set. */
  admin?: {
    key: string;
    customers: () => Customer[];
    blast: (message: string, search: string) => Promise<{ sent: Customer[]; manual: Customer[] }>;
    /** Turns the bot back on in every chat it paused itself in. Returns how many. */
    unpauseAll?: () => number;
    /** PAID / BOOKED orders (Instagram's own DM labels can't be set by API, so they live here). */
    labels?: {
      all: () => OrderLabel[];
      /** Money confirmed: PAID, logged in the sales tracker. */
      markPaid: (id: string) => Promise<boolean>;
      /** Fulfilled: logged if it wasn't yet, label cleared. */
      done: (id: string) => Promise<boolean>;
      doneAll: () => Promise<number>;
      /** No-show / changed mind: stock goes back on the sheet, label removed. */
      cancel: (id: string) => Promise<{ ok: boolean; wasLogged?: boolean }>;
    };
  };
}

function keyOk(given: unknown, key: string): boolean {
  if (!key || typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createServer(bot: Pick<Bot, "handle">, opts: ServerOpts) {
  const app = express();

  // Team assistant: its own (bigger) body limit for screenshots, registered before the 1mb parser below.
  if (opts.assistant) {
    const a = opts.assistant;
    app.use("/team", (req, res, next) => {
      if (req.headers.origin === a.origin) {
        res.setHeader("Access-Control-Allow-Origin", a.origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
        res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
        res.setHeader("Access-Control-Max-Age", "600");
      }
      if (req.method === "OPTIONS") return res.sendStatus(req.headers.origin === a.origin ? 204 : 403);
      next();
    });
    app.post("/team/assistant", express.json({ limit: "10mb" }), async (req, res) => {
      const auth = req.headers.authorization ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      if (!token) return res.status(401).json({ error: "log in first" });
      try {
        const out = await a.handle(token, req.body);
        res.status(out.status).json(out.body);
      } catch (err) {
        console.error("[assistant] failed:", (err as Error).message ?? err);
        res.status(500).json({ error: "The assistant hit an error. Try again." });
      }
    });
  }

  app.use(
    express.json({
      limit: "1mb",
      verify: (req, _res, buf) => {
        (req as RawRequest).rawBody = buf;
      },
    }),
  );

  app.get("/", (_req, res) => {
    res.send("Triangle AI DM agent is running.");
  });

  // Render's health check. Always 200 while the server is up; details are best effort.
  app.get("/health", async (_req, res) => {
    let details: Record<string, unknown> = {};
    try {
      details = (await opts.health?.()) ?? {};
    } catch (err) {
      details = { detailsError: String(err).slice(0, 200) };
    }
    res.json({ ok: true, uptimeSec: Math.round(process.uptime()), ...details });
  });

  // Meta calls this once when you save the webhook URL in the dashboard.
  app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === opts.verifyToken && typeof challenge === "string") {
      res.status(200).send(challenge);
      return;
    }
    res.sendStatus(403);
  });

  app.post("/webhook", (req, res) => {
    const raw = (req as RawRequest).rawBody;
    const sig = req.get("x-hub-signature-256");
    const secrets = [opts.appSecret, ...(opts.extraAppSecrets ?? [])].filter(Boolean);
    if (!raw || !secrets.some((s) => isValidSignature(raw, sig, s))) {
      // Most common cause: IG_APP_SECRET on Render isn't the app secret from the Meta Instagram setup page.
      console.warn(
        `[webhook] REJECTED a delivery: signature check failed (${sig ? "IG_APP_SECRET / META_APP_SECRET don't match the app" : "no signature header"})`,
      );
      res.sendStatus(403);
      return;
    }
    // Answer Meta right away; it retries deliveries that take too long.
    res.sendStatus(200);
    const body = req.body as WebhookPayload;
    const kinds = (body.entry ?? []).flatMap((e) => [
      ...(e.messaging ?? []).map((m) => (m.message?.is_echo ? "echo" : "message")),
      ...(e.changes ?? []).map((c) => c.field),
    ]);
    console.log(`[webhook] received ${body.object ?? "?"}: ${kinds.join(", ") || "nothing to handle"}`);
    void bot.handle(body);
  });

  // Stripe calls this when a checkout link is paid.
  app.post("/stripe/webhook", (req, res) => {
    const raw = (req as RawRequest).rawBody;
    if (!opts.stripeWebhookSecret || !raw || !isValidStripeSignature(raw, req.get("stripe-signature"), opts.stripeWebhookSecret)) {
      res.sendStatus(400);
      return;
    }
    res.sendStatus(200);
    const order = paidOrderFromEvent(req.body);
    if (order && opts.onPaidOrder) {
      void opts.onPaidOrder(order).catch((err) => console.error("[stripe] paid order handling failed:", err));
    }
  });

  // Josh's customer list: /admin?key=ADMIN_KEY
  const admin = opts.admin;
  if (admin?.key) {
    app.use("/admin", express.urlencoded({ extended: false, limit: "20kb" }));
    app.use("/admin", (req, res, next) => (keyOk(req.query.key, admin.key) ? next() : res.sendStatus(404)));
    const page = (key: unknown, notice = "", result?: Parameters<typeof adminPage>[1]) =>
      adminPage(String(key), result, admin.labels?.all() ?? [], notice);
    app.get("/admin", (req, res) => {
      res.type("html").send(page(req.query.key));
    });
    app.post("/admin/labels/paid", async (req, res) => {
      const ok = (await admin.labels?.markPaid(String(req.body?.id ?? ""))) ?? false;
      res.type("html").send(page(req.query.key, ok ? "Marked PAID and logged in the sales tracker." : "That order wasn't found (or was already paid)."));
    });
    app.post("/admin/labels/clear", async (req, res) => {
      const ok = (await admin.labels?.done(String(req.body?.id ?? ""))) ?? false;
      res.type("html").send(page(req.query.key, ok ? "Done. Label cleared." : "That order wasn't found."));
    });
    app.post("/admin/labels/cancel", async (req, res) => {
      const r = (await admin.labels?.cancel(String(req.body?.id ?? ""))) ?? { ok: false };
      res
        .type("html")
        .send(page(req.query.key, r.ok ? `Cancelled. Items are back on BOT STOCK.${r.wasLogged ? " It was already in the sales tracker: delete that row by hand." : ""}` : "That order wasn't found."));
    });
    app.post("/admin/labels/clear-all", async (req, res) => {
      const n = (await admin.labels?.doneAll()) ?? 0;
      console.log(`[admin] cleared ${n} order label(s)`);
      res.type("html").send(page(req.query.key, `Cleared ${n} label(s).`));
    });
    app.get("/admin/customers.csv", (_req, res) => {
      res.type("text/csv").attachment("triangle-customers.csv").send(customersCsv(admin.customers()));
    });
    app.post("/admin/unpause", (req, res) => {
      const n = admin.unpauseAll?.() ?? 0;
      console.log(`[admin] unpaused ${n} chat(s)`);
      res.type("html").send(page(req.query.key, `Bot turned back on in ${n} chat(s).`));
    });
    app.post("/admin/blast", async (req, res) => {
      const message = String(req.body?.message ?? "").trim().slice(0, 1000);
      const search = String(req.body?.search ?? "").trim();
      if (!message) {
        res.status(400).send("Write a message first.");
        return;
      }
      const result = await admin.blast(message, search);
      res.type("html").send(page(req.query.key, "", { ...result, message }));
    });
  }

  return app;
}
