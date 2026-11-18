/**
 * Team alerts as phone pushes: the bot writes a row into the CRM's `notifications` table and the CRM sends it to the
 * team's phones (the CRM app installed on the home screen). Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY on Render
 * (only the service key may write there). Same key the CRM on Netlify uses; server-side only, never logged.
 *
 * The CRM's rules: a repeat `dedupe_key` is dropped silently; without one, an identical alert within 6 hours is dropped.
 * Leave delivered_at empty (the CRM sets it after the push).
 */
import { isTestBuyer } from "./desk.js";
import type { HandoffAlert, Notifier, TextPoster } from "./handoff.js";

export interface PushRow {
  type: string; // escalation | needs_human | approval | wrap_up | ...
  title: string;
  body?: string;
  priority?: "low" | "normal" | "high" | "urgent";
  conversation_id?: string;
  sale_id?: string;
  dedupe_key?: string;
  is_test?: boolean;
}
export type Pusher = (row: PushRow) => Promise<void>;

export function crmPusher(supabaseUrl: string, serviceKey: string, fetchFn: typeof fetch = fetch): Pusher {
  const base = supabaseUrl.trim().replace(/\/+$/, "").replace(/\/rest\/v1$/i, "").replace(/\/+$/, "");
  return async (row) => {
    const res = await fetchFn(`${base}/rest/v1/notifications`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        ...(serviceKey.startsWith("sb_") ? {} : { Authorization: `Bearer ${serviceKey}` }),
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(row),
    });
    if (res.ok || res.status === 409) return; // 409 = same dedupe_key already sent: fine
    throw new Error(`CRM push answered HTTP ${res.status}`);
  };
}

/** "Needs a human" alerts -> a phone push. Paused chats are high priority, FYIs normal. */
export function pushNotifier(push: Pusher, now: () => number = Date.now): Notifier {
  return async (a: HandoffAlert) => {
    const who = a.username ? `@${a.username}` : `user ${a.userId}`;
    const fyi = a.paused === false;
    const bucket = Math.floor(now() / (10 * 60 * 1000)); // the same alert twice within 10 minutes = one push
    try {
      await push({
        type: fyi ? "fyi" : "needs_human",
        title: `${a.route === "josh" ? "Josh: " : ""}${who} ${fyi ? `– ${a.reason}` : "needs a human"}`.slice(0, 120),
        body: [fyi ? "" : `Why: ${a.reason}`, a.summary, fyi ? "Bot still running in this chat." : "Bot paused. Reply from the Instagram inbox."]
          .filter(Boolean)
          .join("\n"),
        priority: fyi ? "normal" : "high",
        conversation_id: a.userId,
        dedupe_key: `handoff:${a.userId}:${a.reason}:${bucket}`.slice(0, 200),
        ...(isTestBuyer(a.userId) ? { is_test: true } : {}),
      });
    } catch (err) {
      console.error("[push] alert not sent:", (err as Error).message ?? err);
    }
  };
}

/** One plain text (the 10 PM wrap-up) -> a phone push. Throws on failure so the caller can retry. */
export function pushText(push: Pusher, type: string, title: string): TextPoster {
  return (text) => push({ type, title, body: text, priority: "normal" });
}

/** Sends to every target; one failing doesn't stop the others. */
export function allNotifiers(...ns: Notifier[]): Notifier {
  return async (a) => void (await Promise.allSettled(ns.map((n) => n(a))));
}
