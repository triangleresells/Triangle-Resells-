import Anthropic from "@anthropic-ai/sdk";
import type { Fulfillment, OrderItem } from "./pricing.js";
import type { ChatTurn, ShipTo } from "./store.js";

export interface AgentReply {
  text: string;
  handoff?: { route: "team" | "josh"; reason: string; summary: string };
  /** Set when the bot made a Stripe link in this reply. The bot makes sure it reaches the customer. */
  checkoutUrl?: string;
  /** Heads-up alerts for the team. Unlike a handoff, the bot keeps selling in the chat. */
  alerts?: { reason: string; summary: string }[];
  /** The customer said they don't want the order, so don't follow up on the unpaid link. */
  cancelFollowUp?: boolean;
  /** Items this customer wants (saved to the customer list for restock blasts). */
  interests?: string[];
}

export type PaymentMethod = "cash" | "cash_app" | "zelle" | "apple_pay";

/** Order actions the AI can take for the customer it's talking to. Prices always come from the warehouse sheet. */
export interface OrderTools {
  quote(items: OrderItem[], fulfillment: Fulfillment, deliveryArea?: string): string;
  /** Cash, Cash App or Zelle (and Apple Pay when Stripe is off): lock in the order. Label BOOKED; stock comes off the sheet once it's paid. */
  submitOrder?(
    items: OrderItem[],
    fulfillment: Fulfillment,
    fulfillDate: string,
    fulfillTime: string | undefined,
    deliveryArea: string | undefined,
    payment: PaymentMethod,
    shipTo?: ShipTo,
  ): Promise<
    | { ok: true; total: number; summary: string; freebies: string[]; note?: string; payText?: string }
    | { ok: false; error: string; fixable?: boolean; handoff?: boolean }
  >;
  /** True if this exact order is already locked in for this buyer (so submit_order isn't run twice). */
  isBooked?(items: OrderItem[], fulfillment: Fulfillment, deliveryArea?: string): boolean;
  /** Buyer says they sent the money (or sent a screenshot). Tells Josh to check. Never confirms anything. */
  paymentSent?(method: string, note: string): Promise<string>;
  /** Stripe payment link. Only when STRIPE_ENABLED=true. */
  checkout?(
    items: OrderItem[],
    fulfillment: Fulfillment,
    fulfillDate: string,
    fulfillTime?: string,
    deliveryArea?: string,
  ): Promise<{ ok: true; url: string; total: number; summary: string; note?: string } | { ok: false; error: string; fixable?: boolean }>;
}

export interface ReplyEngine {
  reply(history: ChatTurn[], inventory: string, tools?: OrderTools, schedule?: string): Promise<AgentReply>;
}

const ITEMS_SCHEMA = {
  type: "array",
  description: "Every PAID item in the order, one entry per item + color + size. Never include the free Baccarat or G-Shock: they're added automatically.",
  items: {
    type: "object",
    properties: {
      product: { type: "string", description: "Item name exactly as on the stock sheet, e.g. Alo Hoodie, Chrome Hearts Tee, Bleu de Chanel EDP." },
      variant: { type: "string", description: "Color exactly as on the stock sheet, e.g. Gray, Black/Pink. Blank for fragrances and bags." },
      size: { type: "string", description: "Size as on the stock sheet: XS, S, M, L, XL, a waist size like 32, or blank for fragrances, hats and bags." },
      qty: { type: "integer", minimum: 1 },
    },
    required: ["product", "qty"],
  },
} as const;

const FULFILLMENT_SCHEMA = {
  type: "string",
  enum: ["pickup", "ship", "delivery"],
  description:
    "pickup = buyer comes to the warehouse. ship = UPS anywhere in the US. delivery = Josh drops it off locally (fee by drive time, max 1 hour; also use it for meeting halfway, with the meeting town as delivery_area).",
} as const;

const DELIVERY_AREA_SCHEMA = {
  type: "string",
  description: "Delivery only: the town or area, e.g. Durham, Knightdale, Clayton. For meeting halfway, the meeting town.",
} as const;

export const TOOLS = [
  {
    name: "handoff_to_team",
    description:
      "Pause the bot in this chat and alert a human on the Triangle team. Use it for the cases listed under HANDOFF in your instructions.",
    input_schema: {
      type: "object" as const,
      properties: {
        route: {
          type: "string",
          enum: ["team", "josh"],
          description: "josh for complaints, refunds, known bulk buyers, collabs, and price exceptions. team for everything else.",
        },
        reason: { type: "string", description: "Short reason, e.g. 'cash buyer', 'upset customer'." },
        summary: {
          type: "string",
          description: "One or two lines the team can act on: items, sizes, quantities, pickup or ship, etc.",
        },
      },
      required: ["route", "reason", "summary"],
    },
  },
  {
    name: "alert_team",
    description:
      "Send Josh an instant heads-up WITHOUT pausing the chat. Use it when a customer asks for something we don't have in stock, don't carry, or haven't priced. Keep selling after.",
    input_schema: {
      type: "object" as const,
      properties: {
        reason: { type: "string", description: "e.g. 'asked for item not in stock', 'asked for unpriced item'." },
        summary: { type: "string", description: "Exactly what they asked for: brand, item, size, color, how many." },
      },
      required: ["reason", "summary"],
    },
  },
  {
    name: "quote_order",
    description:
      "Get the exact price for an order. Always use this before telling the customer any total. Never do price math yourself.",
    input_schema: {
      type: "object" as const,
      properties: { items: ITEMS_SCHEMA, fulfillment: FULFILLMENT_SCHEMA, delivery_area: DELIVERY_AREA_SCHEMA },
      required: ["items", "fulfillment"],
    },
  },
  {
    name: "create_checkout_link",
    description:
      "Make a branded Stripe payment link for the confirmed order. Only call it when the buyer says they're ready to pay, after items, sizes, stock, pickup or ship, and the date are all settled and you told them all sales are final. If they change the order after getting a link (add, remove or swap anything), call it again with the FULL new order: their old link is cancelled automatically and only the new one works.",
    input_schema: {
      type: "object" as const,
      properties: {
        items: ITEMS_SCHEMA,
        fulfillment: FULFILLMENT_SCHEMA,
        fulfill_date: {
          type: "string",
          description: "YYYY-MM-DD the buyer picks up, it's delivered, or the day it ships. Can be a later day: they pay now and we hold it.",
        },
        fulfill_time: { type: "string", description: "Pickup or delivery time like '3:00 PM'. Leave blank for shipping." },
        delivery_area: DELIVERY_AREA_SCHEMA,
      },
      required: ["items", "fulfillment", "fulfill_date"],
    },
  },
  {
    name: "submit_order",
    description:
      "Lock in a confirmed order paid by cash, Cash App or Zelle. Only call it once items, sizes, pickup/delivery/ship, the day (and time for pickup or delivery), the payment method, and for shipping the full name and address are all settled, and after you sent the order summary and said all sales are final. The items are held for them (they come off the stock sheet once paid), the order goes on Josh's calendar, and Josh is alerted. The chat keeps going.",
    input_schema: {
      type: "object" as const,
      properties: {
        items: ITEMS_SCHEMA,
        fulfillment: FULFILLMENT_SCHEMA,
        fulfill_date: { type: "string", description: "YYYY-MM-DD of the pickup, delivery or ship day." },
        fulfill_time: { type: "string", description: "Pickup or delivery time like '3:00 PM'. Blank for shipping." },
        delivery_area: DELIVERY_AREA_SCHEMA,
        payment: { type: "string", enum: ["cash", "cash_app", "zelle", "apple_pay"], description: "How they'll pay. Card and Apple Pay go through create_checkout_link when it's offered." },
        ship_to: {
          type: "object",
          description: "Shipping only (required for ship): the buyer's full name and address, exactly as they gave it.",
          properties: {
            name: { type: "string" },
            street: { type: "string" },
            apt: { type: "string", description: "Apt/unit, blank if none." },
            city: { type: "string" },
            state: { type: "string", description: "2-letter state, e.g. NC" },
            zip: { type: "string" },
          },
          required: ["name", "street", "city", "state", "zip"],
        },
      },
      required: ["items", "fulfillment", "fulfill_date", "payment"],
    },
  },
  {
    name: "payment_sent",
    description:
      "Call when the buyer says they sent the money or sends a payment screenshot (Cash App or Zelle). It tells Josh to check his app. It does NOT confirm the payment: only Josh confirms.",
    input_schema: {
      type: "object" as const,
      properties: {
        method: { type: "string", enum: ["cash_app", "zelle", "other"] },
        note: { type: "string", description: "What they said or what the screenshot shows (amount, name, time)." },
      },
      required: ["method", "note"],
    },
  },
  {
    name: "save_interest",
    description:
      "Save what this customer wants to Josh's customer list, so he can reach them on a restock or with leftover stock. Call it whenever they ask about an item that's out, coming soon, or say 'let me know when X drops'. Doesn't alert anyone or pause the chat.",
    input_schema: {
      type: "object" as const,
      properties: { item: { type: "string", description: "Brand, item, color and size, e.g. 'Spider Hoodie Pink L', '50 Essentials hoodies'." } },
      required: ["item"],
    },
  },
  {
    name: "cancel_follow_up",
    description:
      "Call when the customer clearly says they don't want the order anymore (\"nah I'm good\", \"changed my mind\"), so the bot doesn't follow up on their unpaid link.",
    input_schema: { type: "object" as const, properties: {} },
  },
];

export function buildSystemPrompt(instructions: string, knowledgeBase: string, inventory: string, now = new Date(), schedule = ""): string {
  return systemBlocks(instructions, knowledgeBase, inventory, now, schedule)
    .map((b) => b.text)
    .join("\n\n");
}

/**
 * The system prompt in two blocks. The first (instructions, knowledge base, stock sheet) only changes when the
 * sheet does, so it's cached: cheaper, and cached reads don't eat the per-minute rate limit. The second holds what
 * changes every request (pickup schedule, current time).
 */
export function systemBlocks(instructions: string, knowledgeBase: string, inventory: string, now = new Date(), schedule = ""): Anthropic.TextBlockParam[] {
  const today = now.toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  });
  const parts = [instructions, "KNOWLEDGE BASE\n" + knowledgeBase];
  if (inventory) {
    parts.push(
      "LIVE STOCK SHEET (updated by the team; if it disagrees with the knowledge base on stock or restock dates, trust this sheet)\n" +
        inventory,
    );
  }
  const stable = parts.join("\n\n");
  parts.length = 0;
  if (schedule) parts.push("PICKUP SCHEDULE (live from Josh's calendar)\n" + schedule);
  parts.push(`TODAY\n${today} (North Carolina time). Use this to turn "today", "tomorrow" or "next Thursday" into a date.`);
  parts.push(
    "FORMAT\nYou are writing an Instagram DM. Plain text only: no markdown, no bullet lists, no asterisks. Keep it short.",
  );
  return [
    { type: "text", text: stable, cache_control: { type: "ephemeral" } },
    { type: "text", text: parts.join("\n\n") },
  ];
}

/** Only the most recent customer screenshots are sent to the AI, to keep replies fast and cheap. */
const MAX_IMAGE_TURNS = 2;

type Block = Anthropic.TextBlockParam | Anthropic.ImageBlockParam;

/** Claude's API needs turns to alternate, starting with the customer. Recent screenshots go in as images. */
export function toApiMessages(history: ChatTurn[]): Anthropic.MessageParam[] {
  const imageTurns = new Set(
    history
      .map((t, i) => (t.images?.length ? i : -1))
      .filter((i) => i >= 0)
      .slice(-MAX_IMAGE_TURNS),
  );
  const out: { role: "user" | "assistant"; blocks: Block[] }[] = [];
  history.forEach((t, i) => {
    const blocks: Block[] = [];
    if (t.images?.length && imageTurns.has(i)) {
      for (const img of t.images) {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: img.mediaType as "image/jpeg", data: img.data },
        });
      }
    }
    blocks.push({ type: "text", text: t.images?.length && !imageTurns.has(i) ? `${t.text} (older picture, no longer shown)` : t.text });
    const last = out[out.length - 1];
    if (last && last.role === t.role) last.blocks.push(...blocks);
    else out.push({ role: t.role, blocks });
  });
  while (out.length && out[0].role !== "user") out.shift();
  return out.map(({ role, blocks }) =>
    blocks.every((b) => b.type === "text")
      ? { role, content: blocks.map((b) => (b as Anthropic.TextBlockParam).text).join("\n") }
      : { role, content: blocks },
  );
}

const MAX_ROUNDS = 5;
/**
 * Room for the model's thinking plus a short DM or tool call. Haiku 5.5 thinks before answering, and the old
 * 500 ran out mid-tool-call, which threw away the turn and sent "let me get someone from the team" instead.
 * Only tokens actually used are billed; the DM itself stays short because the instructions say so.
 */
const MAX_TOKENS = 16000;

const FINAL_RE = /all\s+sales\s+(are\s+)?final/i;

/**
 * Josh's rule, enforced in code: nothing gets locked in (submit_order or a payment link) until the buyer has
 * seen the full order summary with a $ total and "all sales final" in one of our last 2 messages, and answered it.
 * Returns what to tell the AI instead, or undefined when it's OK to lock in.
 */
export function lockInBlocker(history: ChatTurn[]): string | undefined {
  const lastUser = history.map((t) => t.role).lastIndexOf("user");
  const before = history.slice(0, lastUser).filter((t) => t.role === "assistant" && !t.text.startsWith("[Team member replied]"));
  const recent = before.slice(-2);
  if (lastUser >= 0 && recent.some((t) => FINAL_RE.test(t.text) && /\$\s?\d/.test(t.text))) return undefined;
  return "This call was NOT run. Anything locked in earlier in this chat is still locked in, and payment info sent earlier is still correct: never tell the buyer otherwise. To lock in a NEW or CHANGED order, first send the full ORDER SUMMARY in one text: every item with color/size and price, the free gift, any shipping or delivery fee, the TOTAL, pickup/delivery/ship and the day (and time), how they're paying, and the words \"all sales are final\". Ask them to confirm. Only call this again after they say yes.";
}

/** Only offer the tools that work right now: Stripe links when Stripe is on, otherwise submit_order. */
export function toolsFor(tools?: OrderTools) {
  return TOOLS.filter((t) =>
    t.name === "create_checkout_link" ? !!tools?.checkout : t.name === "submit_order" ? !!tools?.submitOrder : t.name === "payment_sent" ? !!tools?.paymentSent : true,
  );
}

const THANKS_RE = /^(?:(hey|hi|yo|hello)\s*[,!.]?\s*)?(?:thanks|thank you)(?: so much)? for (?:reaching out|messaging|the message|your message|hitting (?:us|me) up)[!.,]*\s*/i;
const QUESTION_RE = /^(?:(hey|hi|yo|hello)\s*[,!.]?\s*)?(?:good|great) question[!.,]*\s*/i;

/** Ends a text with a "do you want it?" question instead of the next step. ("Want me to put you down for one?" on a restock is allowed.) */
const WANT_RE =
  /\b(?:want (?:it|that|this|them|those|one|that one|this one|both|all \w+|to (?:grab|go ahead|do|get|add)[^?]*|me to lock it in)|would (?:that|this|it|those|the [^?]{1,40}|\$\d[^?]*) work(?: for you)?|do you (?:want|still want)|would you like|you want (?:it|that|this|one|them))\b[^?]*\?\s*$/i;
/** "I've saved / flagged / told Josh..." said in this reply. Only true if a tool that does that ran this turn. */
const CLAIM_RE =
  /\b(?:i(?:'ve| have| just)? ?(?:saved|added|flagged|noted|logged|put you (?:down|on)|got you (?:down|on (?:the|my) list)|let josh know|told josh|passed (?:it|this) (?:on|to josh)|sent (?:it|this) to josh)|you(?:'re| are) (?:saved|on (?:the|my|our) list|down for))\b/i;

/**
 * Josh's rules that code can check: one question per text, no "want it?" endings, and no claiming
 * an action (saved you, told Josh) unless a tool that does it ran in this reply. Returns the problems found.
 */
export function lintReply(text: string, ranTools: Set<string> = new Set()): string[] {
  const problems: string[] = [];
  const bubbles = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  for (const b of bubbles) {
    const q = (b.match(/\?/g) ?? []).length;
    if (q > 1) problems.push(`One text asks ${q} questions ("${b.slice(0, 80)}"). Keep ONE question per text: the next step only.`);
    if (WANT_RE.test(b) && !/put you down for/i.test(b)) {
      problems.push(`A text ends by asking if they want it ("${b.slice(-70)}"). Assume the close: ask the next step instead (size, pickup or shipped, day/time, payment).`);
    }
  }
  const saved = ["alert_team", "save_interest", "handoff_to_team", "payment_sent"].some((t) => ranTools.has(t));
  const claim = text.match(CLAIM_RE);
  if (claim && !saved) problems.push(`It says "${claim[0]}", but no tool that does that ran in this reply. Don't claim it: either drop the line, or say what you can do.`);
  return problems;
}

/** Drops the customer-service openers Josh banned ("Thanks for reaching out.", "Good question."), keeping a "Hey!". */
export function stripFiller(text: string): string {
  let out = text;
  for (const re of [THANKS_RE, QUESTION_RE]) {
    const m = out.match(re);
    if (!m) continue;
    const rest = out.slice(m[0].length);
    if (!rest.trim()) continue; // never blank out a whole reply
    const greet = m[1] ? `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()}! ` : "";
    out = greet + rest.charAt(0).toUpperCase() + rest.slice(1);
  }
  return out;
}

/** Adds a text note to the last customer turn (the API needs user and assistant turns to alternate). */
export function withNote(messages: Anthropic.MessageParam[], note: string): Anthropic.MessageParam[] {
  const out = [...messages];
  const last = out[out.length - 1];
  if (!last || last.role !== "user") return [...out, { role: "user", content: note }];
  const blocks = typeof last.content === "string" ? [{ type: "text" as const, text: last.content }] : [...last.content];
  out[out.length - 1] = { role: "user", content: [...blocks, { type: "text", text: note }] };
  return out;
}

export class ClaudeAgent implements ReplyEngine {
  private client: Anthropic;

  constructor(
    apiKey: string,
    private model: string,
    private instructions: string,
    private knowledgeBase: string,
  ) {
    // Rate limits (429) and overloads are retried with backoff instead of dropping the customer's reply.
    this.client = new Anthropic({ apiKey, maxRetries: 4 });
  }

  async reply(history: ChatTurn[], inventory: string, tools?: OrderTools, schedule?: string): Promise<AgentReply> {
    const system = systemBlocks(this.instructions, this.knowledgeBase, inventory, new Date(), schedule);
    if (tools && !tools.checkout) {
      system.push({
        type: "text",
        text: "PAYMENT LINKS ARE OFF RIGHT NOW. Never mention a card link or payment link. Payment is cash (pickup only), Cash App or Zelle; Apple Pay goes through submit_order and Josh sends the info.",
      });
    }
    const messages = toApiMessages(history);
    let handoff: AgentReply["handoff"];
    let checkoutUrl: string | undefined;
    let cancelFollowUp = false;
    const interests: string[] = [];
    const alerts: NonNullable<AgentReply["alerts"]> = [];
    const ran = new Set<string>();
    let finalTexts: string[] = [];
    const allTexts: string[] = [];

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: MAX_TOKENS,
        system,
        messages,
        tools: toolsFor(tools),
      });

      const texts: string[] = [];
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      if (res.stop_reason === "max_tokens") {
        // Cut off: tool inputs may be incomplete (e.g. quote_order with no items), so run nothing from it.
        console.error(`[ai] reply hit max_tokens (${res.usage.output_tokens} tokens); not running its tool calls`);
        break;
      }
      for (const block of res.content) {
        if (block.type === "text" && block.text.trim()) texts.push(block.text.trim());
        if (block.type !== "tool_use") continue;
        const input = block.input as any;
        ran.add(block.name);
        let content: string;
        if (block.name === "handoff_to_team") {
          handoff = input as AgentReply["handoff"];
          content =
            "Team alerted. Write one short message telling the customer someone will jump in shortly. Don't say what they'll do, confirm or decide (no \"Josh will confirm the discount\").";
        } else if (block.name === "alert_team") {
          alerts.push({ reason: String(input.reason ?? ""), summary: String(input.summary ?? "") });
          content =
            "Josh alerted, and it's saved on their customer list, so they'll get a text if it comes in. Keep helping: offer the closest item we do have and keep closing.";
        } else if (block.name === "save_interest") {
          if (input.item) interests.push(String(input.item));
          content = "Saved to the customer list. Keep helping.";
        } else if (block.name === "cancel_follow_up") {
          cancelFollowUp = true;
          content = "No follow-up will be sent. Close politely and leave the door open.";
        } else if (!tools) {
          content = "Ordering isn't available right now. Hand off to the team.";
        } else if (block.name === "quote_order") {
          content = tools.quote(input.items ?? [], input.fulfillment, input.delivery_area);
        } else if (block.name === "payment_sent" && tools.paymentSent) {
          content = await tools.paymentSent(String(input.method ?? "other"), String(input.note ?? ""));
        } else if (block.name === "submit_order" && tools.isBooked?.(input.items ?? [], input.fulfillment, input.delivery_area)) {
          content =
            "This exact order is ALREADY locked in (booked earlier). Don't call submit_order again, and don't re-send the order or the payment info unless they ask for it. Just answer what they said.";
        } else if ((block.name === "submit_order" || block.name === "create_checkout_link") && lockInBlocker(history)) {
          content = lockInBlocker(history)!;
        } else if (block.name === "submit_order" && tools.submitOrder) {
          const r = await tools.submitOrder(input.items ?? [], input.fulfillment, input.fulfill_date, input.fulfill_time, input.delivery_area, input.payment, input.ship_to);
          if (r.ok) {
            const gifts = r.freebies.length ? `, plus ${r.freebies.join(" and ")}` : "";
            content = `Order locked in (BOOKED): total $${r.total}${gifts}. It's held for them and on Josh's calendar.${r.note ? ` ${r.note}` : ""} ${r.payText ?? ""} Don't send the order summary again.`;
          } else if (!r.fixable && r.handoff) {
            content = `Could not lock it in: ${r.error}. Call handoff_to_team (josh) with the order, and tell the customer Josh will reach out right here.`;
          } else if (r.fixable) {
            content = `Could not lock it in: ${r.error}. Tell the customer what's wrong and offer the closest fix (another open time, an in-stock color or size, shipping or meeting halfway), then try again once they pick.`;
          } else {
            content = `Could not lock it in: ${r.error}. Hand off to josh.`;
          }
        } else if (block.name === "create_checkout_link" && tools.checkout) {
          const r = await tools.checkout(input.items ?? [], input.fulfillment, input.fulfill_date, input.fulfill_time, input.delivery_area);
          if (r.ok) {
            checkoutUrl = r.url;
            content = `Link made. Total $${r.total} (${r.summary}).${r.note ? ` ${r.note}` : ""} Send the customer this exact link: ${r.url}`;
          } else if (r.fixable) {
            content = `Could not make the link: ${r.error}. Tell the customer and offer an open time from the PICKUP SCHEDULE (or another fix, like shipping or meeting halfway), then try again once they pick.`;
          } else {
            content = `Could not make the link: ${r.error}. Hand off to the team.`;
          }
        } else {
          content = "Unknown tool.";
        }
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content });
      }
      allTexts.push(...texts);
      finalTexts = texts;

      if (res.stop_reason !== "tool_use" || toolResults.length === 0) break;
      messages.push({ role: "assistant", content: res.content });
      messages.push({ role: "user", content: toolResults });
    }

    let text = (finalTexts.length ? finalTexts : allTexts).join("\n").replace(/\*\*/g, "").trim();
    if (!text && !handoff) {
      // The AI used its tools but never wrote the DM. Ask once more for just the message, so the chat
      // keeps going instead of being handed to the team for no reason.
      try {
        const res = await this.client.messages.create({
          model: this.model,
          max_tokens: MAX_TOKENS,
          system,
          messages: withNote(
            messages,
            "(Note from the system, not the customer: write your DM reply to the customer now. If we don't have what they asked for, say so and offer what we do have in stock.)",
          ),
          tools: toolsFor(tools),
          tool_choice: { type: "none" },
        });
        text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("\n").replace(/\*\*/g, "").trim();
      } catch (err) {
        console.error("[ai] retry for an empty reply failed:", err);
      }
    }
    text = stripFiller(text);
    const problems = text ? lintReply(text, ran) : [];
    if (problems.length) {
      // One targeted rewrite. The buyer only ever sees the better of the two versions.
      try {
        const res = await this.client.messages.create({
          model: this.model,
          max_tokens: MAX_TOKENS,
          system,
          messages: withNote(
            messages,
            `(Note from the system, not the customer: this is the DM you were about to send:\n"""\n${text}\n"""\nFix ONLY these problems, keep everything else (prices, facts, links) the same, and reply with just the fixed DM:\n- ${problems.join("\n- ")})`,
          ),
          tools: toolsFor(tools),
          tool_choice: { type: "none" },
        });
        const fixed = stripFiller(res.content.map((b) => (b.type === "text" ? b.text : "")).join("\n").replace(/\*\*/g, "").trim());
        if (fixed && (!checkoutUrl || fixed.includes(checkoutUrl) || !text.includes(checkoutUrl)) && lintReply(fixed, ran).length < problems.length) {
          console.log(`[ai] rewrote a reply to fix: ${problems.map((p) => p.split(".")[0]).join(" | ")}`);
          text = fixed;
        }
      } catch (err) {
        console.error("[ai] rewrite failed, sending the original:", err);
      }
    }
    if (!text) {
      text = handoff
        ? "Got you, someone from the team will jump in here shortly."
        : "Good question, let me get someone from the team to confirm that for you.";
      handoff ??= { route: "team", reason: "AI had no answer", summary: "Bot produced an empty reply." };
    }
    return { text, handoff, checkoutUrl, alerts: alerts.length ? alerts : undefined, ...(cancelFollowUp ? { cancelFollowUp } : {}), ...(interests.length ? { interests } : {}) };
  }
}
