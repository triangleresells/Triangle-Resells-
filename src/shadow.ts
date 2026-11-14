/**
 * SHADOW_MODE: the bot reads real DMs and does all its thinking, but nothing leaves it. Replies, comment replies,
 * team alerts and bookings are written to a drafts log instead (shown on /admin/shadow) so Josh can review them
 * before going live. Reads (stock, CRM notes, the buyer's CRM history) stay real; every write is stubbed.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { Crm } from "./crm.js";
import type { Booking, OrderDesk } from "./desk.js";
import type { HandoffAlert, Notifier } from "./handoff.js";
import type { InstagramApi } from "./instagram.js";
import type { OrderLabel } from "./store.js";

export interface ShadowDraft {
  at: string;
  kind: "reply" | "comment_dm" | "comment_reply" | "alert" | "booking";
  to: string;
  text: string;
}

export class ShadowLog {
  private drafts: ShadowDraft[] = [];
  constructor(private file?: string, private now = () => new Date()) {
    if (file && existsSync(file)) {
      try {
        this.drafts = readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-500).map((l) => JSON.parse(l) as ShadowDraft);
      } catch (err) {
        console.error("[shadow] couldn't read the drafts file:", (err as Error).message ?? err);
      }
    }
  }

  add(kind: ShadowDraft["kind"], to: string, text: string): void {
    const d: ShadowDraft = { at: this.now().toISOString(), kind, to, text };
    this.drafts.push(d);
    if (this.drafts.length > 500) this.drafts.shift();
    console.log(`[shadow] DRAFT ${kind} to ${to}: ${text.replace(/\s+/g, " ").slice(0, 300)}`);
    if (this.file) {
      try {
        appendFileSync(this.file, JSON.stringify(d) + "\n");
      } catch (err) {
        console.error("[shadow] couldn't save a draft:", (err as Error).message ?? err);
      }
    }
  }

  /** Newest first. */
  recent(n = 100): ShadowDraft[] {
    return this.drafts.slice(-n).reverse();
  }
}

/** Instagram that never sends: drafts go to the log. Usernames and the account id are still read for real. */
export function shadowInstagram(real: InstagramApi, log: ShadowLog): InstagramApi {
  let n = 0;
  return {
    sendText: async (to, text) => (log.add("reply", to, text), `shadow-${++n}`),
    sendPrivateReply: async (commentId, text) => (log.add("comment_dm", `comment ${commentId}`, text), `shadow-${++n}`),
    replyToComment: async (commentId, text) => void log.add("comment_reply", `comment ${commentId}`, text),
    getUsername: (id) => real.getUsername(id),
    setAccountId: real.setAccountId ? (id) => real.setAccountId!(id) : undefined,
    typingOn: async () => {},
  };
}

/** Team alerts are drafted, not posted. */
export function shadowNotifier(log: ShadowLog): Notifier {
  return async (a: HandoffAlert) => log.add("alert", a.route, `${a.reason}${a.summary ? `: ${a.summary}` : ""}`);
}

/** Orders are drafted: no CRM booking, no calendar, no stock change, no /admin label (so nothing can be logged as a sale). */
export function shadowDesk(log: ShadowLog): Pick<OrderDesk, "booked" | "stripePaid"> {
  const fake = (userId: string, summary: string, total: number, payment: string, when: string): OrderLabel =>
    ({ id: "shadow", userId, label: "BOOKED", summary, total, payment, when, createdAt: Date.now() }) as OrderLabel;
  return {
    booked: async (b: Booking) => {
      const when = [b.fulfillment, b.fulfillDate, b.fulfillTime, b.deliveryArea && `(${b.deliveryArea})`].filter(Boolean).join(" ");
      log.add("booking", b.username ? `@${b.username}` : b.userId, `WOULD BOOK ${b.items}, $${b.total} by ${b.payment}, ${when}`);
      return fake(b.userId, b.items, b.total, b.payment, when);
    },
    stripePaid: async (userId, _lines, summary, total, when) => {
      log.add("booking", userId, `WOULD MARK STRIPE PAID ${summary}, $${total}, ${when}`);
      return fake(userId, summary, total, "stripe", when);
    },
  };
}

/** The CRM for a shadow bot: reads stay real, the one write the bot makes on its own (DM count) is skipped. */
export function shadowCrm(real: Crm): Crm {
  return { ...real, recordDm: async () => {} };
}
