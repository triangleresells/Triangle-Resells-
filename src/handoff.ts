export interface HandoffAlert {
  account: string;
  route: "team" | "josh";
  reason: string;
  summary: string;
  userId: string;
  username?: string;
  /** False for FYI alerts (like a paid order) where the bot keeps running in the chat. */
  paused?: boolean;
}

export type Notifier = (alert: HandoffAlert) => Promise<void>;

export function formatAlert(a: HandoffAlert): string {
  const who = a.username ? `@${a.username}` : `user ${a.userId}`;
  const to = a.route === "josh" ? "🔺 JOSH" : "🔺 TEAM";
  return [
    `${to} — ${a.account} DM needs a human`,
    `Customer: ${who}${a.username ? ` (https://instagram.com/${a.username})` : ""}`,
    `Why: ${a.reason}`,
    `Summary: ${a.summary}`,
    a.paused === false ? `FYI only, the bot is still running in this chat.` : `The bot is paused in this chat. Reply from the Instagram inbox.`,
  ].join("\n");
}

/**
 * Posts handoff alerts to a Discord or Slack incoming webhook.
 * Sends both `content` (Discord) and `text` (Slack) so either works.
 */
export function webhookNotifier(url: string, fetchFn: typeof fetch = fetch): Notifier {
  return async (alert) => {
    const message = formatAlert(alert);
    if (!url) {
      console.log(`[handoff] (no HANDOFF_WEBHOOK_URL set)\n${message}`);
      return;
    }
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message, text: message }),
    });
    if (!res.ok) console.error(`[handoff] webhook failed: HTTP ${res.status}`);
  };
}

/** Posts one plain line to the team's Discord / Slack webhook (CRM notifications: "📅 Chema booked a sale..."). */
export type TextPoster = (text: string) => Promise<void>;

export function webhookText(url: string, fetchFn: typeof fetch = fetch): TextPoster {
  return async (text) => {
    if (!url) {
      console.log(`[notify] (no HANDOFF_WEBHOOK_URL set) ${text}`);
      return;
    }
    const res = await fetchFn(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: text, text }) });
    if (!res.ok) throw new Error(`webhook answered HTTP ${res.status}`);
  };
}
