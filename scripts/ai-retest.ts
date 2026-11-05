/**
 * Real-AI retests: Claude plays a customer, the REAL bot (Claude + config/ files + real tools) answers,
 * and a separate Claude call grades the chat against Josh's rules. Fake Instagram and fake Stripe:
 * nothing is sent or charged.
 *
 *   ANTHROPIC_API_KEY=... npx tsx scripts/ai-retest.ts 50 report.json
 *
 * Costs API credit (roughly 10-15 Claude calls per conversation). Start with 50, then go to 1000.
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync } from "node:fs";
import { ClaudeAgent } from "../src/ai.js";
import { Bot } from "../src/bot.js";
import { loadConfig } from "../src/config.js";
import type { InstagramApi } from "../src/instagram.js";
import type { BusyBlock } from "../src/schedule.js";
import { Store } from "../src/store.js";
import type { CheckoutApi } from "../src/stripe.js";

const STOCK_SHEET = `Item | Colorway | Size | Qty
Spider OG Web Hoodie | Black | XS | 5
Spider OG Web Hoodie | Black | S | 5
Spider OG Web Hoodie | Black | M | 5
Spider Hoodie | Pink/Black | S | 5
Spider Hoodie | Pink/Black | M | 5
Essentials Hoodie | Black | XS | 5
Essentials Hoodie | Black | L | 5
Essentials Sweatpants | Black Uncuffed | S | 2
Essentials Sweatpants | Black Uncuffed | M | 3
Alo Hoodie | Black | XS | 5
Alo Hoodie | Gray | S | 3
Alo Hoodie | Gray | M | 3
Alo Hoodie | Gray | L | 3
Alo Pants | Black Uncuffed | XL | 3
Alo Pants | Light Gray Uncuffed | L | 3
BAPE Tee ABC Camo | Green | S/M | 4 each
BAPE Tee Joshua Vides | - | M/L | 3 each
BAPE Tee Big Blue Ape Head | White | M/L | 4 each
Jeans | Blue | 32 | 6
Valley Hoodie | Black | M | 6
Hat | Black | - | 10
Bleu de Chanel | - | - | 8`;

const PERSONAS = [
  "knows exactly what they want and wants to pay right now",
  "asks lots of questions, slow to decide, eventually buys",
  "haggles hard and gets annoyed when the price is firm, may argue",
  "rude and impatient, curses, complains the bot is slow",
  "asks for something we don't carry (a Supreme set, Gucci belt) then maybe settles for something else",
  "lives in Greensboro, has no car, wants delivery and wants to pay cash",
  "lives in Durham, wants delivery tomorrow afternoon",
  "wants 12 hoodies shipped to Texas, asks about shipping cost",
  "says Josh promised them a discount last time",
  "wants to put a deposit down on 50 Essentials from the next restock",
  "asks how to pay, wants to use Zelle",
  "sends 'I paid' with a fake payment screenshot before getting a link",
  "goes quiet after getting the link, then comes back saying 'my bad I was busy'",
  "talks one day, comes back two days later to finally order",
  "wants pickup at 9am or 11pm",
  "asks if you're a bot",
  "wants to trade their Jordans for a hoodie",
  "asks if the items are real and if they can make money reselling",
  "wants a Bleu de Chanel and a hat shipped",
  "wants to start reselling and asks about vendors",
];

const RULES = readFileSync(new URL("../config/agent-instructions.md", import.meta.url), "utf8");

async function main() {
  const n = Number(process.argv[2] ?? 50);
  const out = process.argv[3] ?? "ai-retest-report.json";
  const env = { IG_APP_SECRET: "x", IG_ACCESS_TOKEN: "x", IG_VERIFY_TOKEN: "x", ...process.env } as NodeJS.ProcessEnv;
  const config = loadConfig(env);
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const results: unknown[] = [];

  for (let i = 0; i < n; i++) {
    const persona = PERSONAS[i % PERSONAS.length];
    const transcript: string[] = [];
    const sent: string[] = [];
    const ig: InstagramApi = {
      sendText: async (_to, text) => { sent.push(text); transcript.push(`BOT: ${text}`); return `m${sent.length}`; },
      sendPrivateReply: async () => "m", replyToComment: async () => {}, getUsername: async () => "tester",
    };
    const checkout: CheckoutApi = { create: async () => ({ id: `cs_${i}`, url: `https://checkout.stripe.com/test_${i}_${sent.length}`, expiresAt: 0 }) };
    const tools: string[] = [];
    const notify = async (a: { reason: string; route: string; paused?: boolean }) => { tools.push(`${a.paused === false ? "alert" : "handoff"}(${a.route}): ${a.reason}`); };
    const busy: BusyBlock[] = [{ start: "2026-11-06T20:00:00Z", end: "2026-11-06T20:30:00Z" }];
    const bot = new Bot({
      ig, agent: new ClaudeAgent(config.anthropicApiKey, config.claudeModel, config.agentInstructions, config.knowledgeBase),
      store: new Store(), notify, getInventory: async () => STOCK_SHEET, accountName: config.accountName, keywords: config.keywords,
      publicCommentReplies: [], humanPauseHours: 12, pricing: config.pricing, checkout, getBusy: async () => busy,
    });

    const customerSystem = `You are role-playing an Instagram customer DMing @triangleresells, a clothing/cologne resale shop near Raleigh NC. Persona: ${persona}. Write ONE short DM at a time, like a real person texting. Stay in character. When the conversation is clearly over (paid, said bye, or handed to a human), reply exactly END.`;
    const convo: Anthropic.MessageParam[] = [{ role: "user", content: "Start the conversation with your first DM." }];
    for (let turn = 0; turn < 8; turn++) {
      const c = await client.messages.create({ model: config.claudeModel, max_tokens: 150, system: customerSystem, messages: convo });
      const msg = c.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
      if (!msg || msg === "END") break;
      transcript.push(`CUSTOMER: ${msg}`);
      const before = sent.length;
      await bot.handle({ object: "instagram", entry: [{ id: "own", messaging: [{ sender: { id: `u${i}` }, recipient: { id: "own" }, message: { mid: `${i}-${turn}`, text: msg } }] }] });
      const reply = sent.slice(before).join("\n") || "(bot stayed quiet: paused for a human)";
      convo.push({ role: "assistant", content: msg }, { role: "user", content: reply });
    }

    const judge = await client.messages.create({
      model: config.claudeModel, max_tokens: 600,
      system: "You grade a DM sales bot strictly against its rules. Reply with JSON only: {\"pass\": boolean, \"violations\": [string], \"notes\": string}.",
      messages: [{ role: "user", content: `RULES:\n${RULES}\n\nTOOLS/ALERTS THE BOT FIRED:\n${tools.join("\n") || "none"}\n\nCHAT:\n${transcript.join("\n")}` }],
    });
    const text = judge.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    let grade: unknown;
    try { grade = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)); } catch { grade = { pass: false, violations: ["judge reply unreadable"], notes: text }; }
    results.push({ id: i, persona, transcript, tools, grade });
    console.log(`${i + 1}/${n} ${(grade as { pass?: boolean }).pass ? "✅" : "❌"} ${persona}`);
  }
  writeFileSync(out, JSON.stringify(results, null, 1));
  console.log(`\nSaved ${out}`);
}

void main();
