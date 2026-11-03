import express, { type Request } from "express";
import type { Bot, WebhookPayload } from "./bot.js";
import { isValidSignature } from "./signature.js";

type RawRequest = Request & { rawBody?: Buffer };

export function createServer(bot: Pick<Bot, "handle">, opts: { appSecret: string; verifyToken: string }) {
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

  return app;
}
