import Anthropic from "@anthropic-ai/sdk";
import type { Fulfillment, OrderItem } from "./pricing.js";
import type { ChatTurn } from "./store.js";

export interface AgentReply {
  text: string;
  handoff?: { route: "team" | "josh"; reason: string; summary: string };
  /** Set when the bot made a Stripe link in this reply. The bot makes sure it reaches the customer. */
  checkoutUrl?: string;
  /** Heads-up alerts for the team. Unlike a handoff, the bot keeps selling in the chat. */
  alerts?: { reason: string; summary: string }[];
  /** The customer said they don't want the order, so don't follow up on the unpaid link. */
  cancelFollowUp?: boolean;
}

/** Order actions the AI can take for the customer it's talking to. Prices always come from config/pricing.json. */
export interface OrderTools {
  quote(items: OrderItem[], fulfillment: Fulfillment, deliveryArea?: string): string;
  checkout(
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
  description: "Every item in the order. One entry per product + variant + size.",
  items: {
    type: "object",
    properties: {
      product: { type: "string", description: "Product key from the PRODUCT KEYS list, e.g. alo_hoodie." },
      variant: { type: "string", description: "Colorway or scent, e.g. Gray, Pink/Black, Bleu de Chanel." },
      size: { type: "string", description: "XS, S, M, L, XL, a shoe size, or blank for colognes." },
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
      "Make a branded Stripe payment link for the confirmed order. Only call it once items, sizes, stock, pickup or ship, and the date are all settled, and after you told them all sales are final.",
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
    const alerts: NonNullable<AgentReply["alerts"]> = [];
    let finalTexts: string[] = [];
    const allTexts: string[] = [];

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: 500,
        system,
        messages,
        tools: TOOLS,
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
        } else if (block.name === "cancel_follow_up") {
          cancelFollowUp = true;
          content = "No follow-up will be sent. Close politely and leave the door open.";
        } else if (!tools) {
          content = "Ordering isn't available right now. Hand off to the team.";
        } else if (block.name === "quote_order") {
          content = tools.quote(input.items ?? [], input.fulfillment, input.delivery_area);
        } else if (block.name === "create_checkout_link") {
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
    if (!text) {
      text = handoff
        ? "Bet, let me get someone from the team to jump in for you real quick."
        : "Good question, let me get someone from the team to confirm for you.";
      handoff ??= { route: "team", reason: "AI had no answer", summary: "Bot produced an empty reply." };
    }
    return { text, handoff, checkoutUrl, alerts: alerts.length ? alerts : undefined, ...(cancelFollowUp ? { cancelFollowUp } : {}) };
  }
}
