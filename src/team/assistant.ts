/**
 * The team assistant: Josh, Chema and Diego chat with it inside the CRM. It logs in-person sales, reads restock
 * screenshots, answers "what's booked tomorrow?" / "how much did we make?", changes bookings, and takes notes for the
 * DM bot. Every tool calls a CRM database function AS the logged-in person (their Supabase login), so everything is
 * logged under their name and can be undone.
 */
import type Anthropic from "@anthropic-ai/sdk";

/** Calls CRM database functions as the logged-in person. */
export interface UserDb {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T>;
}

export class UserDbError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Supabase REST as the person: their access token, plus the project's public (anon) key. */
export function supabaseUserDb(url: string, anonKey: string, accessToken: string, fetchFn: typeof fetch = fetch): UserDb {
  const base = url.replace(/\/+$/, "");
  return {
    async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
      const res = await fetchFn(`${base}/rest/v1/rpc/${fn}`, {
        method: "POST",
        headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(15000),
      });
      const text = await res.text();
      const body = text ? JSON.parse(text) : null;
      if (!res.ok) throw new UserDbError(String(body?.message ?? `error ${res.status}`).slice(0, 300), res.status);
      return body as T;
    },
  };
}

export interface ChatImage {
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  /** base64 */
  data: string;
}

export interface AssistantMessage {
  role: "user" | "assistant";
  text: string;
  images?: ChatImage[];
}

export interface AssistantResult {
  reply: string;
  /** What changed, in plain words (shown under the reply). */
  changes: string[];
}

type Messages = Pick<Anthropic, "messages">;

const ITEM = {
  type: "object",
  properties: {
    brand: { type: "string" },
    item: { type: "string", description: "Item name as BOT STOCK writes it, e.g. 'Essentials Hoodie'." },
    color: { type: "string" },
    size: { type: "string", description: "Size, or 'One Size' for hats, bags and fragrances." },
    qty: { type: "integer", minimum: 1 },
    unit_price: { type: "number", description: "Price per piece the buyer paid." },
  },
  required: ["item", "size", "qty"],
};
const DATE = { type: "string", description: "YYYY-MM-DD" };
const FILTERS = {
  type: "object",
  description: "Optional filters.",
  properties: {
    assignee: { type: "string", enum: ["Josh", "Chema", "Diego"] },
    payment_method: { type: "string", enum: ["cash", "cash_app", "zelle", "stripe", "apple_pay"] },
    fulfillment: { type: "string", enum: ["pickup", "delivery", "ship"] },
    source_account: { type: "string", enum: ["Triangle Resells", "Triangle Scales", "Triangle Sales", "none"] },
  },
};

export const ASSISTANT_TOOLS: Anthropic.Tool[] = [
  {
    name: "log_sale",
    description:
      "Book a sale in the CRM (in person, text, referral): stock comes off automatically, refused if the pieces aren't free to sell. It starts as booked or paid; if it already happened, follow with mark_fulfilled (approval) to put it in revenue and the tracker.",
    input_schema: {
      type: "object",
      properties: {
        date: DATE,
        time: { type: "string", description: "HH:MM 24h, optional" },
        status: { type: "string", enum: ["booked", "paid"], description: "booked (or paid if the money is in). Even a sale that already happened is logged booked: then mark_fulfilled, which needs their approval." },
        customer: { type: "object", properties: { ig_handle: { type: "string" }, name: { type: "string" }, phone: { type: "string" } } },
        items: { type: "array", items: ITEM, minItems: 1 },
        sale_price: { type: "number", description: "Item total, only if it differs from the sum of unit prices (a bundle deal)." },
        payment_method: { type: "string", enum: ["cash", "cash_app", "zelle", "stripe", "apple_pay"] },
        fulfillment: { type: "string", enum: ["pickup", "delivery", "ship"] },
        delivery_fee: { type: "number" },
        location: { type: "string" },
        assignee: { type: "string", enum: ["Josh", "Chema", "Diego"], description: "Who fulfills / fulfilled it." },
        source: { type: "string", enum: ["instagram", "in_person", "text", "referral", "other"] },
        source_account: { type: "string", enum: ["Triangle Resells", "Triangle Scales", "Triangle Sales"] },
        notes: { type: "string" },
      },
      required: ["date", "items", "payment_method", "fulfillment"],
    },
  },
  {
    name: "find_bookings",
    description: "Every booking between two dates (inclusive) with customer, items, status, who's fulfilling.",
    input_schema: { type: "object", properties: { from: DATE, to: DATE }, required: ["from", "to"] },
  },
  {
    name: "change_booking",
    description: "Edit a booking: new date/time (reschedule), items, price, who fulfills, location, tracking number (the buyer gets it in the DMs), notes.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        changes: {
          type: "object",
          properties: {
            date: DATE, time: { type: "string" }, items: { type: "array", items: ITEM }, sale_price: { type: "number" },
            assignee: { type: "string", enum: ["Josh", "Chema", "Diego"] }, location: { type: "string" },
            tracking_number: { type: "string" }, label_cost: { type: "number" }, notes: { type: "string" },
          },
        },
      },
      required: ["id", "changes"],
    },
  },
  {
    name: "set_status",
    description: "Booked / Paid / No-show / Cancelled. Cancelled and No-show put the pieces back in stock. For Done (fulfilled) use mark_fulfilled.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" }, status: { type: "string", enum: ["booked", "paid", "no_show", "cancelled"] }, reason: { type: "string" } },
      required: ["id", "status"],
    },
  },
  {
    name: "mark_fulfilled",
    description:
      "Mark pickups / deliveries / shipments as Done (fulfilled): that puts them in revenue and the sales tracker, so it needs approval. Call it WITHOUT approval_code first: you get a preview and a code. Show the preview and ask them to reply exactly \"yes\". Only a plain yes counts; then call it again with the same ids and the approval_code.",
    input_schema: {
      type: "object",
      properties: { ids: { type: "array", items: { type: "string" }, minItems: 1 }, approval_code: { type: "string" } },
      required: ["ids"],
    },
  },
  {
    name: "sales_report",
    description: "Revenue (Done sales, fees excluded), profit, and every sale behind it, for a date range. Use for 'how much did we make', per person, per account.",
    input_schema: { type: "object", properties: { from: DATE, to: DATE, filters: FILTERS }, required: ["from", "to"] },
  },
  {
    name: "monthly_report",
    description: "Revenue and profit for each of the last N months.",
    input_schema: { type: "object", properties: { months: { type: "integer", minimum: 1, maximum: 24 } }, required: ["months"] },
  },
  {
    name: "cash_report",
    description: "Cash each person collected on a day, and from which bookings.",
    input_schema: { type: "object", properties: { day: DATE }, required: ["day"] },
  },
  {
    name: "customers",
    description: "Customer list with orders, total spent, last order, DM chats. sort: top_spenders, lowest_spenders, most_dms, repeat_buyers, recent. search: handle, name or phone.",
    input_schema: { type: "object", properties: { sort: { type: "string" }, search: { type: "string" } } },
  },
  {
    name: "stock",
    description: "Every item: free to sell, reserved, came in this restock, sold since it landed, sold all-time.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "restocks",
    description: "Restocks logged (incoming and received) with their lines.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "log_restock",
    description: "Log an incoming restock (e.g. read from a screenshot): every item, color, size and how many. Nothing goes into stock until it's received.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "e.g. 'Nov 16-17 restock'" },
        expected_date: DATE,
        notes: { type: "string" },
        items: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              brand: { type: "string" }, item: { type: "string" }, color: { type: "string" }, size: { type: "string" },
              qty_expected: { type: "integer", minimum: 0 }, unit_cost: { type: "number" }, price_list: { type: "string" },
            },
            required: ["item", "qty_expected"],
          },
        },
      },
      required: ["name", "items"],
    },
  },
  {
    name: "receive_restock",
    description: "A restock landed: its pieces go into stock (INCOMING becomes FOR SALE). Pass received counts only for lines that came in short.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        short: { type: "array", items: { type: "object", properties: { line_id: { type: "string" }, qty_received: { type: "integer", minimum: 0 } }, required: ["line_id", "qty_received"] } },
      },
      required: ["id"],
    },
  },
  {
    name: "tell_bot",
    description: "Give the Instagram DM bot a piece of info it should use with buyers from now on (wins over its knowledge base). Optional expires_on for temporary things.",
    input_schema: { type: "object", properties: { note: { type: "string" }, expires_on: DATE }, required: ["note"] },
  },
  {
    name: "bot_notes",
    description: "What the DM bot has been told (active notes).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "retire_bot_note",
    description: "Stop the DM bot using a note.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "video_ideas",
    description: "A day's video ideas per account (goals: Resells 3, Scales 2, Sales 6 incl. a meetup video), with status To film / Filmed / Posted.",
    input_schema: { type: "object", properties: { day: DATE }, required: ["day"] },
  },
  {
    name: "add_video_idea",
    description: "Add a video idea (hook) for a day and account. account: resells, scales or sales.",
    input_schema: {
      type: "object",
      properties: { day: DATE, account: { type: "string", enum: ["resells", "scales", "sales"] }, hook: { type: "string" }, meetup: { type: "boolean" } },
      required: ["day", "account", "hook"],
    },
  },
  {
    name: "update_video_idea",
    description: "Change a video idea: status (todo = To film, filmed, posted), posted_to accounts, post link, views, or the hook.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        changes: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["todo", "filmed", "posted"] }, hook: { type: "string" },
            posted_to: { type: "array", items: { type: "string", enum: ["resells", "scales", "sales"] } },
            post_link: { type: "string" }, views: { type: "integer", minimum: 0 },
          },
        },
      },
      required: ["id", "changes"],
    },
  },
  {
    name: "generate_video_ideas",
    description: "Write fresh hooks to fill a day up to the goals per account (never repeats recent ones).",
    input_schema: { type: "object", properties: { day: DATE }, required: ["day"] },
  },
  {
    name: "recent_changes",
    description: "The latest changes in the CRM (who did what), with ids for undo.",
    input_schema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50 } } },
  },
  {
    name: "undo",
    description: "Reverse one change by its id from recent_changes.",
    input_schema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
  },
];

const WRITE_SUMMARY: Record<string, (input: any, out: any) => string> = {
  log_sale: (i, o) => `Booked a sale for ${o?.date}: ${(o?.items ?? []).map((x: any) => `${x.qty}x ${x.item}`).join(", ")}, $${o?.sale_price}`,
  change_booking: (i) => `Changed booking ${String(i.id).slice(0, 8)}: ${Object.keys(i.changes ?? {}).join(", ")}`,
  set_status: (i) => `Marked booking ${String(i.id).slice(0, 8)} ${i.status}`,
  mark_fulfilled: (i, o) => (o?.marked ? `Marked ${o.marked} sale(s) Done: in revenue and the sales tracker` : ""),
  log_restock: (i) => `Logged incoming restock "${i.name}" (${(i.items ?? []).length} lines)`,
  receive_restock: () => `Received a restock: pieces added to stock`,
  tell_bot: (i) => `Told the DM bot: "${String(i.note).slice(0, 80)}"`,
  retire_bot_note: () => `Retired a bot note`,
  undo: (i) => `Undid change #${i.id}`,
  add_video_idea: (i) => `Added a ${i.account} video idea for ${i.day}: "${String(i.hook).slice(0, 60)}"`,
  update_video_idea: (i) => `Updated a video idea: ${Object.keys(i.changes ?? {}).join(", ")}`,
  generate_video_ideas: (i, o) => `Wrote ${o?.added ?? 0} new video idea(s) for ${i.day}`,
};

/** Runs one tool as the person. Errors come back as text so the AI can explain or fix them. */
/** Who's talking, which message this is, and what they just said (an approval only counts if it's exactly "yes"). */
export interface ApprovalCtx {
  who: string;
  turn: number;
  lastUserText: string;
}

async function runTool(db: UserDb, name: string, input: any, extra: AssistantExtras, gate: ApprovalGate, ctx: ApprovalCtx): Promise<unknown> {
  switch (name) {
    case "mark_fulfilled":
      return gate.markFulfilled(db, input.ids ?? [], input.approval_code, ctx);
    case "video_ideas":
      return db.rpc("videos_for_day", { p_day: input.day, p_is_test: false });
    case "add_video_idea":
      return db.rpc("add_video_ideas", { p_day: input.day, p_ideas: [{ account: input.account, hook: input.hook, meetup: input.meetup ?? false }] });
    case "update_video_idea":
      return db.rpc("update_video_idea", { p_id: input.id, p: input.changes ?? {} });
    case "generate_video_ideas":
      if (!extra.fillVideoIdeas) throw new Error("the hook writer isn't switched on");
      return { added: await extra.fillVideoIdeas(input.day) };
    case "log_sale":
      if (input.status === "done") throw new Error("log it as booked, then mark_fulfilled (Done needs their approval)");
      return db.rpc("create_booking", { p: { source: "in_person", ...input } });
    case "find_bookings":
      return db.rpc("bookings_between", { p_from: input.from, p_to: input.to, p_include_test: false });
    case "change_booking":
      return db.rpc("update_booking", { p_id: input.id, p: input.changes ?? {} });
    case "set_status":
      if (input.status === "done") throw new Error("Done needs approval: use mark_fulfilled");
      return db.rpc("set_booking_status", { p_id: input.id, p_status: input.status, p_reason: input.reason ?? null });
    case "sales_report":
      return db.rpc("sales_report", { p_from: input.from, p_to: input.to, p_filters: input.filters ?? {}, p_include_test: false });
    case "monthly_report":
      return db.rpc("monthly_report", { p_months: input.months, p_filters: {}, p_include_test: false });
    case "cash_report":
      return db.rpc("cash_report", { p_day: input.day, p_include_test: false });
    case "customers":
      return db.rpc("customers_report", { p_sort: input.sort ?? "top_spenders", p_limit: 50, p_include_test: false, p_search: input.search ?? null });
    case "stock":
      return db.rpc("stock_overview", { p_is_test: false });
    case "restocks":
      return db.rpc("restocks_list", { p_include_test: false });
    case "log_restock":
      return db.rpc("create_restock", { p: input });
    case "receive_restock":
      return db.rpc("receive_restock", { p_id: input.id, p_received: (input.short ?? []).map((s: any) => ({ id: s.line_id, qty_received: s.qty_received })) });
    case "tell_bot":
      return db.rpc("add_bot_note", { p_note: input.note, p_expires_on: input.expires_on ?? null });
    case "bot_notes":
      return db.rpc("bot_notes_active", {});
    case "retire_bot_note":
      return db.rpc("retire_bot_note", { p_id: input.id });
    case "recent_changes":
      return db.rpc("recent_activity", { p_limit: input.limit ?? 15 });
    case "undo":
      return db.rpc("undo_activity", { p_id: input.id });
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

export function assistantSystem(who: string, today: string, weekday: string): string {
  return `You are the Triangle Resells team assistant. You're talking with ${who} (a co-owner; the team is Josh, Chema and Diego, all full access). Today is ${weekday} ${today} (Eastern time). The business: a resale shop near Raleigh/Wendell NC selling streetwear and cologne through Instagram DMs (accounts Triangle Resells, Triangle Scales, Triangle Sales), in person, by text and referrals.

What you do, with your tools (they act as ${who} and everything is logged under their name and can be undone):
- Log sales they tell you about (log_sale): source in_person (or text / referral), today's date unless they say otherwise. Cash is pickup only. If it already happened, preview it for Done right away with mark_fulfilled so they can approve it.
- Read restock screenshots and log them (log_restock): read EVERY item, color, size and quantity; if a part is unreadable, say which. Mark restocks received when they say it landed (receive_restock).
- Answer questions with exact numbers from the reports (sales_report, monthly_report, cash_report, customers, stock, find_bookings). Revenue = Done sales, delivery fees not included.
- Mark sales fulfilled (mark_fulfilled) when they tell you a pickup / delivery / shipment happened: preview it, then ask them to reply exactly "yes". Only a plain yes approves. If they answer anything else ("yeah", "ok", a question), it is NOT approved: nothing goes in revenue or the tracker; ask again.
- Change bookings: reschedule, status, who fulfills, tracking numbers (the buyer gets the tracking in the DMs automatically).
- Video ideas per account (video_ideas, add_video_idea, update_video_idea, generate_video_ideas): mark them filmed / posted, save the post link and views.
- Pass info to the Instagram DM bot (tell_bot): restock dates, closures, new rules. It uses it with buyers from now on.
- Undo things (recent_changes, then undo).

Rules:
- Just do it when the request is clear. Ask ONE short question only when something you need is missing: which item, size, how many, or the price (never make up a price).
- Item names: use them the way BOT STOCK does (check the stock tool if unsure). If a sale is refused because the pieces aren't free to sell, say exactly what's left.
- After any change, say plainly what you saved (date, items, price, status). Keep replies short, like texting a teammate. No markdown tables, no headings.
- Never share or invent anything about payments you can't see. Never delete real data except through undo when they ask.`;
}

const MAX_ROUNDS = 8;

/** Josh's rule: only a plain "yes" approves (any capitals; a period or ! at the end is fine). "yeah", "ok", "yes but..." don't. */
export const isYes = (text: string) => /^yes[.!]*$/i.test(text.trim());

/**
 * Josh's rule: a sale goes in revenue and the tracker (Done) only after he replies "yes". The first mark_fulfilled call
 * only previews and hands out a code; the code works only in a LATER message from the same person, for the same bookings,
 * within 30 minutes, AND only if that message is exactly "yes". So the AI can't approve on its own, ever.
 */
export class ApprovalGate {
  private codes = new Map<string, { ids: string[]; who: string; turn: number; at: number }>();
  constructor(private now: () => number = Date.now) {}

  async markFulfilled(db: UserDb, ids: string[], code: string | undefined, ctx: ApprovalCtx): Promise<unknown> {
    const key = [...new Set(ids)].sort().join(",");
    if (!key) throw new Error("which bookings?");
    if (!code) {
      const preview: string[] = [];
      for (const id of ids) {
        const b = await db.rpc<any>("get_booking", { p_id: id });
        const who = b.customer?.ig_handle ? `@${b.customer.ig_handle}` : (b.customer?.name ?? "buyer");
        const items = (b.items ?? []).map((i: any) => `${i.qty}x ${[i.item, i.color, i.size === "One Size" ? "" : i.size].filter(Boolean).join(" ")}`).join(", ");
        preview.push(`${who}, ${b.date}${b.time ? ` ${String(b.time).slice(0, 5)}` : ""} ${b.fulfillment}, ${items}, $${b.sale_price} ${String(b.payment_method).replace("_", " ")}, status ${b.status}, fulfilling ${b.assignee ?? "nobody"}`);
      }
      const fresh = Math.random().toString(36).slice(2, 6).toUpperCase();
      this.codes.set(fresh, { ids: key.split(","), who: ctx.who, turn: ctx.turn, at: this.now() });
      return {
        needs_approval: true,
        approval_code: fresh,
        preview,
        next: 'Show this list and ask them to reply exactly "yes" to mark it Done. Only a plain yes approves; anything else is NOT approval. When they reply yes, call mark_fulfilled again with the same ids and this approval_code.',
      };
    }
    const a = this.codes.get(code.trim().toUpperCase());
    if (!a || a.who !== ctx.who || a.ids.join(",") !== key) throw new Error("that approval code doesn't match these bookings: preview again");
    if (a.turn >= ctx.turn) throw new Error("they haven't approved yet: show the preview and wait for their yes");
    if (!isYes(ctx.lastUserText)) {
      throw new Error(`not approved: their reply wasn't "yes", so nothing was marked Done. Ask them to reply exactly "yes" if it was fulfilled.`);
    }
    if (this.now() - a.at > 30 * 60_000) throw new Error("the approval expired: preview again");
    this.codes.delete(code.trim().toUpperCase());
    for (const id of a.ids) await db.rpc("set_booking_status", { p_id: id, p_status: "done", p_reason: null });
    return { marked: a.ids.length };
  }
}

/** Abilities that live on the bot rather than in the database. */
export interface AssistantExtras {
  /** Writes hooks to fill a day up to the goals; returns how many it added. */
  fillVideoIdeas?: (day: string) => Promise<number>;
}

export class TeamAssistant {
  constructor(
    private client: Messages,
    private model: string,
    private extra: AssistantExtras = {},
    private gate = new ApprovalGate(),
  ) {}

  /** Counts messages, so an approval code is only good in a later one. */
  private turn = 0;

  async chat(db: UserDb, who: string, history: AssistantMessage[], now = new Date()): Promise<AssistantResult> {
    const today = now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const weekday = now.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long" });
    const messages: Anthropic.MessageParam[] = history.map((m) => ({
      role: m.role,
      content: [
        ...(m.images ?? []).map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mediaType, data: img.data } })),
        { type: "text" as const, text: m.text || "(screenshot)" },
      ],
    }));
    const changes: string[] = [];
    let reply = "";
    // Their latest message: an approval only counts if it's exactly "yes".
    const lastUserText = [...history].reverse().find((m) => m.role === "user")?.text ?? "";
    const ctx: ApprovalCtx = { who, turn: ++this.turn, lastUserText };
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: 4000,
        system: assistantSystem(who, today, weekday),
        messages,
        tools: ASSISTANT_TOOLS,
      });
      const texts = res.content.filter((b) => b.type === "text").map((b) => (b as Anthropic.TextBlock).text.trim()).filter(Boolean);
      if (texts.length) reply = texts.join("\n");
      const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (res.stop_reason !== "tool_use" || !uses.length) break;
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const u of uses) {
        let content: string;
        try {
          const out = await runTool(db, u.name, u.input, this.extra, this.gate, ctx);
          content = JSON.stringify(out ?? null).slice(0, 60_000);
          const sum = WRITE_SUMMARY[u.name];
          const line = sum?.(u.input, out);
          if (line) changes.push(line);
        } catch (err) {
          content = `Error: ${(err as Error).message}`;
        }
        results.push({ type: "tool_result", tool_use_id: u.id, content });
      }
      messages.push({ role: "assistant", content: res.content }, { role: "user", content: results });
    }
    return { reply: reply || "Done.", changes };
  }
}
