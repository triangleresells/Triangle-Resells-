import Anthropic from "@anthropic-ai/sdk";
import type { ChatTurn } from "./store.js";

export interface AgentReply {
  text: string;
  handoff?: { route: "team" | "josh"; reason: string; summary: string };
}

export interface ReplyEngine {
  reply(history: ChatTurn[], inventory: string): Promise<AgentReply>;
}

const HANDOFF_TOOL = {
  name: "handoff_to_team",
  description:
    "Pause the bot in this chat and alert a human on the Triangle team. Use it for the cases listed under HANDOFF in your instructions.",
  input_schema: {
    type: "object" as const,
    properties: {
      route: {
        type: "string",
        enum: ["team", "josh"],
        description: "josh for refunds, chargebacks, complaints, bulk/wholesale, and collabs. team for everything else.",
      },
      reason: { type: "string", description: "Short reason, e.g. 'ready to buy', 'bulk order', 'upset customer'." },
      summary: {
        type: "string",
        description: "One or two lines the team can act on: item, size, state, quantities, email, etc.",
      },
    },
    required: ["route", "reason", "summary"],
  },
};

export function buildSystemPrompt(instructions: string, knowledgeBase: string, inventory: string): string {
  const parts = [instructions, "KNOWLEDGE BASE\n" + knowledgeBase];
  if (inventory) {
    parts.push(
      "LIVE INVENTORY SHEET (updated by the team; if it disagrees with the knowledge base on a price, stock, or restock date, trust this sheet)\n" +
        inventory,
    );
  }
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

  async reply(history: ChatTurn[], inventory: string): Promise<AgentReply> {
    const system = buildSystemPrompt(this.instructions, this.knowledgeBase, inventory);
    const messages = toApiMessages(history);
    let handoff: AgentReply["handoff"];
    const texts: string[] = [];

    // Up to 2 rounds: the model may call the handoff tool, then write its reply.
    for (let round = 0; round < 2; round++) {
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: 400,
        system,
        messages,
        tools: [HANDOFF_TOOL],
      });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of res.content) {
        if (block.type === "text" && block.text.trim()) texts.push(block.text.trim());
        if (block.type === "tool_use" && block.name === HANDOFF_TOOL.name) {
          handoff = block.input as AgentReply["handoff"];
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: "Team alerted. Write one short message telling the customer someone will jump in shortly.",
          });
        }
      }

      // Stop if there's nothing to continue, or the customer reply was already written alongside the handoff.
      if (res.stop_reason !== "tool_use" || toolResults.length === 0 || texts.length > 0) break;
      messages.push({ role: "assistant", content: res.content });
      messages.push({ role: "user", content: toolResults });
    }

    let text = texts.join("\n").replace(/\*\*/g, "").trim();
    if (!text) {
      text = handoff
        ? "Bet, let me get someone from the team to jump in for you real quick."
        : "Good question, let me get someone from the team to confirm for you.";
      handoff ??= { route: "team", reason: "AI had no answer", summary: "Bot produced an empty reply." };
    }
    return { text, handoff };
  }
}
