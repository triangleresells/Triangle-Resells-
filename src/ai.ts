import Anthropic from "@anthropic-ai/sdk";
import type { Fulfillment, OrderItem } from "./pricing.js";
import type { ChatTurn } from "./store.js";

export interface AgentReply {
  text: string;
  handoff?: { route: "team" | "josh"; reason: string; summary: string };
  /** Set when the bot made a Stripe link in this reply. The bot makes sure it reaches the customer. */
  checkoutUrl?: string;
}

/** Order actions the AI can take for the customer it's talking to. Prices always come from config/pricing.json. */
export interface OrderTools {
  quote(items: OrderItem[], fulfillment: Fulfillment): string;
  checkout(
    items: OrderItem[],
    fulfillment: Fulfillment,
    fulfillDate: string,
    fulfillTime?: string,
  ): Promise<{ ok: true; url: string; total: number; summary: string } | { ok: false; error: string }>;
}

export interface ReplyEngine {
  reply(history: ChatTurn[], inventory: string, tools?: OrderTools): Promise<AgentReply>;
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
  enum: ["pickup", "ship"],
  description: "pickup = buyer comes to the warehouse. ship = UPS anywhere in the US.",
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
    name: "quote_order",
    description:
      "Get the exact price for an order. Always use this before telling the customer any total. Never do price math yourself.",
    input_schema: {
      type: "object" as const,
      properties: { items: ITEMS_SCHEMA, fulfillment: FULFILLMENT_SCHEMA },
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
          description: "YYYY-MM-DD the buyer picks up, or the day it ships. Can be a later day: they pay now and we hold it.",
        },
        fulfill_time: { type: "string", description: "Pickup time like '3:00 PM'. Leave blank for shipping." },
      },
      required: ["items", "fulfillment", "fulfill_date"],
    },
  },
];

export function buildSystemPrompt(instructions: string, knowledgeBase: string, inventory: string, now = new Date()): string {
  const today = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "America/New_York",
  });
  const parts = [instructions, "KNOWLEDGE BASE\n" + knowledgeBase];
  if (inventory) {
    parts.push(
      "LIVE STOCK SHEET (updated by the team; if it disagrees with the knowledge base on stock or restock dates, trust this sheet)\n" +
        inventory,
    );
  }
  parts.push(`TODAY\n${today} (North Carolina time). Use this to turn "today", "tomorrow" or "next Thursday" into a date.`);
  parts.push(
    "FORMAT\nYou are writing an Instagram DM. Plain text only: no markdown, no bullet lists, no asterisks. Keep it short.",
  );
  return parts.join("\n\n");
}

/** Claude's API needs turns to alternate, starting with the customer. */
export function toApiMessages(history: ChatTurn[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const t of history) {
    const last = out[out.length - 1];
    if (last && last.role === t.role) {
      last.content = `${last.content as string}\n${t.text}`;
    } else {
      out.push({ role: t.role, content: t.text });
    }
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
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

  async reply(history: ChatTurn[], inventory: string, tools?: OrderTools): Promise<AgentReply> {
    const system = buildSystemPrompt(this.instructions, this.knowledgeBase, inventory);
    const messages = toApiMessages(history);
    let handoff: AgentReply["handoff"];
    let checkoutUrl: string | undefined;
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
        } else if (!tools) {
          content = "Ordering isn't available right now. Hand off to the team.";
        } else if (block.name === "quote_order") {
          content = tools.quote(input.items ?? [], input.fulfillment);
        } else if (block.name === "create_checkout_link") {
          const r = await tools.checkout(input.items ?? [], input.fulfillment, input.fulfill_date, input.fulfill_time);
          if (r.ok) {
            checkoutUrl = r.url;
            content = `Link made. Total $${r.total} (${r.summary}). Send the customer this exact link: ${r.url}`;
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
    return { text, handoff, checkoutUrl };
  }
}
