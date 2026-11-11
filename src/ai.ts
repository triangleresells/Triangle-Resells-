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
  if (schedule) parts.push("PICKUP SCHEDULE (live from Josh's calendar)\n" + schedule);
  parts.push(`TODAY\n${today} (North Carolina time). Use this to turn "today", "tomorrow" or "next Thursday" into a date.`);
  parts.push(
    "FORMAT\nYou are writing an Instagram DM. Plain text only: no markdown, no bullet lists, no asterisks. Keep it short.",
  );
  return parts.join("\n\n");
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

/** Only offer the tools that work right now: Stripe links when Stripe is on, otherwise submit_order. */
export function toolsFor(tools?: OrderTools) {
  return TOOLS.filter((t) =>
    t.name === "create_checkout_link" ? !!tools?.checkout : t.name === "submit_order" ? !!tools?.submitOrder : t.name === "payment_sent" ? !!tools?.paymentSent : true,
  );
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
    this.client = new Anthropic({ apiKey });
  }

  async reply(history: ChatTurn[], inventory: string, tools?: OrderTools, schedule?: string): Promise<AgentReply> {
    const system = buildSystemPrompt(this.instructions, this.knowledgeBase, inventory, new Date(), schedule);
    const messages = toApiMessages(history);
    let handoff: AgentReply["handoff"];
    let checkoutUrl: string | undefined;
    let cancelFollowUp = false;
    const interests: string[] = [];
    const alerts: NonNullable<AgentReply["alerts"]> = [];
    let finalTexts: string[] = [];
    const allTexts: string[] = [];

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: 500,
        system,
        messages,
        tools: toolsFor(tools),
      });

      const texts: string[] = [];
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of res.content) {
        if (block.type === "text" && block.text.trim()) texts.push(block.text.trim());
        if (block.type !== "tool_use") continue;
        const input = block.input as any;
        let content: string;
        if (block.name === "handoff_to_team") {
          handoff = input as AgentReply["handoff"];
          content = "Team alerted. Write one short message telling the customer someone will jump in shortly.";
        } else if (block.name === "alert_team") {
          alerts.push({ reason: String(input.reason ?? ""), summary: String(input.summary ?? "") });
          content = "Josh alerted. Keep helping: offer the closest item we do have and keep closing.";
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
          max_tokens: 400,
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
    if (!text) {
      text = handoff
        ? "Got you, someone from the team will jump in here shortly."
        : "Good question, let me get someone from the team to confirm that for you.";
      handoff ??= { route: "team", reason: "AI had no answer", summary: "Bot produced an empty reply." };
    }
    return { text, handoff, checkoutUrl, alerts: alerts.length ? alerts : undefined, ...(cancelFollowUp ? { cancelFollowUp } : {}), ...(interests.length ? { interests } : {}) };
  }
}
