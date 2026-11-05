import { timingSafeEqual } from "node:crypto";
import express, { type Request } from "express";
import { adminPage, customersCsv } from "./customers.js";
import type { Customer } from "./store.js";
import type { Bot, WebhookPayload } from "./bot.js";
import { isValidSignature } from "./signature.js";
import { isValidStripeSignature, paidOrderFromEvent, type PaidOrder } from "./stripe.js";

type RawRequest = Request & { rawBody?: Buffer };

export interface ServerOpts {
  appSecret: string;
  verifyToken: string;
  stripeWebhookSecret?: string;
  onPaidOrder?: (order: PaidOrder) => Promise<void>;
  /** Josh's customer list page. Off unless ADMIN_KEY is set. */
  admin?: {
    key: string;
    customers: () => Customer[];
    blast: (message: string, search: string) => Promise<{ sent: Customer[]; manual: Customer[] }>;
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
    if (!raw || !isValidSignature(raw, req.get("x-hub-signature-256"), opts.appSecret)) {
      res.sendStatus(403);
      return;
    }
    // Answer Meta right away; it retries deliveries that take too long.
    res.sendStatus(200);
    void bot.handle(req.body as WebhookPayload);
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
    app.get("/admin", (req, res) => {
      res.type("html").send(adminPage(String(req.query.key)));
    });
    app.get("/admin/customers.csv", (_req, res) => {
      res.type("text/csv").attachment("triangle-customers.csv").send(customersCsv(admin.customers()));
    });
    app.post("/admin/blast", async (req, res) => {
      const message = String(req.body?.message ?? "").trim().slice(0, 1000);
      const search = String(req.body?.search ?? "").trim();
      if (!message) {
        res.status(400).send("Write a message first.");
        return;
      }
      const result = await admin.blast(message, search);
      res.type("html").send(adminPage(String(req.query.key), { ...result, message }));
    });
  }

  return app;
}
