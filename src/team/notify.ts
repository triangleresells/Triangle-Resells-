/**
 * CRM -> the team's Discord / Slack. Every 20 seconds the bot reads new team notifications from the CRM (a team member
 * booked, rescheduled, cancelled, a no-show, something sold out, new video ideas) and posts each one. A notification
 * that fails to post is retried next time; its place is saved, so a restart doesn't repeat or skip any.
 */
import type { Crm } from "../crm.js";
import type { TextPoster } from "../handoff.js";
import type { Store } from "../store.js";

export class NotifySync {
  private running = false;
  constructor(private d: { crm: Pick<Crm, "notifications">; store: Store; post: TextPoster }) {}

  /** Posts what's new. Returns how many it posted. Never throws. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let posted = 0;
    try {
      const cursor = this.d.store.notifyCursor();
      if (cursor === undefined) {
        // First run: start from now (don't post the backlog).
        this.d.store.setNotifyCursor((await this.d.crm.notifications(null)).latest);
        return 0;
      }
      const { notifications } = await this.d.crm.notifications(cursor);
      for (const n of notifications) {
        try {
          await this.d.post(n.text);
        } catch (err) {
          console.error(`[notify] couldn't post #${n.id}, will retry:`, (err as Error).message ?? err);
          break; // keep the order: try this one again next tick
        }
        this.d.store.setNotifyCursor(n.id);
        posted++;
      }
    } catch (err) {
      console.error("[notify] can't reach the CRM:", (err as Error).message ?? err);
    } finally {
      this.running = false;
    }
    return posted;
  }
}
