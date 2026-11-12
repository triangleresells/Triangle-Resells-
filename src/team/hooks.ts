/**
 * Daily video ideas: fills a day up to each account's goal (Resells 3, Scales 2, Sales 6 incl. a meetup video) with
 * fresh hooks written by Claude, never repeating recent ones. Only fills what's missing, so running it twice is safe.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { Crm, VideoAccount } from "../crm.js";

export const ACCOUNTS: Record<VideoAccount, string> = {
  resells: "Triangle Resells: local meetups, supplying other resellers, shipping and bulk orders of streetwear (Essentials, BAPE, Supreme, Spider, Chrome Hearts) and cologne, Raleigh NC.",
  scales: "Triangle Scales: reselling education: vendors, how to start, flipping tips, scaling a resale business.",
  sales: "Triangle Sales: everything, including reposts from Resells and Scales and at least one meetup video a day (handing orders to buyers in the parking lot).",
};

export interface NewIdea {
  account: VideoAccount;
  hook: string;
  meetup?: boolean;
}

/** How many ideas each account still needs that day, and whether Sales still needs its meetup video. */
export function missingFor(goals: Record<VideoAccount, number>, ideas: { account: VideoAccount; meetup: boolean }[]) {
  const have = (a: VideoAccount) => ideas.filter((i) => i.account === a).length;
  const need = Object.fromEntries((Object.keys(ACCOUNTS) as VideoAccount[]).map((a) => [a, Math.max(0, (goals[a] ?? 0) - have(a))])) as Record<VideoAccount, number>;
  const needsMeetup = need.sales > 0 && !ideas.some((i) => i.account === "sales" && i.meetup);
  return { need, needsMeetup, total: need.resells + need.scales + need.sales };
}

/** Pulls the ideas out of Claude's answer and keeps only valid ones, up to what each account needs. */
export function parseIdeas(text: string, need: Record<VideoAccount, number>, recent: string[]): NewIdea[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  const seen = new Set(recent.map((h) => h.toLowerCase().trim()));
  const left = { ...need };
  const out: NewIdea[] = [];
  for (const i of ((raw as { ideas?: unknown[] })?.ideas ?? []) as { account?: string; hook?: string; meetup?: boolean }[]) {
    const account = i?.account as VideoAccount;
    const hook = typeof i?.hook === "string" ? i.hook.trim().replace(/\s+/g, " ") : "";
    if (!(account in left) || !left[account] || !hook || hook.length > 200 || seen.has(hook.toLowerCase())) continue;
    seen.add(hook.toLowerCase());
    left[account]--;
    out.push({ account, hook, ...(i.meetup === true && account === "sales" ? { meetup: true } : {}) });
  }
  return out;
}

export class HookWriter {
  constructor(
    private client: Pick<Anthropic, "messages">,
    private model: string,
    private crm: Pick<Crm, "videosForDay" | "recentHooks" | "addVideoIdeas">,
  ) {}

  /** Fills `day` (YYYY-MM-DD) up to the goals. Returns how many ideas it added. */
  async fillDay(day: string): Promise<number> {
    const [{ goals, ideas }, recent] = await Promise.all([this.crm.videosForDay(day), this.crm.recentHooks()]);
    const { need, needsMeetup, total } = missingFor(goals, ideas);
    if (!total) return 0;
    const ask = (Object.keys(need) as VideoAccount[]).filter((a) => need[a]).map((a) => `- ${a}: ${need[a]} idea(s). ${ACCOUNTS[a]}`).join("\n");
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 2000,
      system:
        "You write short-form video hooks (Instagram Reels) for Triangle Resells, a resale business near Raleigh NC run by Josh, Chema and Diego. A hook is the first line said or shown in the first 2 seconds: specific, curiosity-driven, plain words, under 90 characters. Style examples from Josh: \"How to start reselling in 2026\", \"How I turned $200 into $2,000 in 2 weeks\". Personal results told as a story are fine; never promise viewers they'll make money. No hashtags, no emojis.",
      messages: [
        {
          role: "user",
          content: `Write video hooks for ${day}:\n${ask}\n${needsMeetup ? "One of the sales ideas must be a meetup video (set \"meetup\": true on it).\n" : ""}Don't repeat or closely copy any of these recent hooks:\n${recent.slice(0, 80).map((h) => `- ${h}`).join("\n") || "(none yet)"}\n\nAnswer with JSON only: {"ideas": [{"account": "resells" | "scales" | "sales", "hook": "...", "meetup": false}]}`,
        },
      ],
    });
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const out = parseIdeas(text, need, recent);
    if (needsMeetup && out.some((i) => i.account === "sales") && !out.some((i) => i.meetup)) {
      out.find((i) => i.account === "sales")!.meetup = true;
    }
    if (out.length) await this.crm.addVideoIdeas(day, out);
    return out.length;
  }
}

/** Tomorrow's date in Eastern time, YYYY-MM-DD. */
export function tomorrowET(now = new Date()): string {
  return new Date(now.getTime() + 24 * 3600_000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}
