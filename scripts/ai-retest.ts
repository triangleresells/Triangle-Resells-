/**
 * Real-AI retest: Claude plays a customer, the REAL bot (Claude + config/ files + the warehouse sheet snapshot + real
 * order tools) answers, and a separate Claude call grades each chat against Josh's rules. Fake Instagram, no Stripe:
 * nothing is sent to anyone.
 *
 *   ANTHROPIC_API_KEY=... npx tsx scripts/ai-retest.ts 50 ai-retest-report.json
 *
 * Bot model: CLAUDE_MODEL (default claude-haiku-5-5, same as Render). Customer: claude-haiku-5-5. Judge: JUDGE_MODEL
 * (default claude-opus-5-5, a stricter grader). Prints the pass rate, top failures and the API cost.
 */
import Anthropic from "@anthropic-ai/sdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeAgent, type OrderTools, type ReplyEngine } from "../src/ai.js";
import { Bot } from "../src/bot.js";
import { formatCatalog } from "../src/catalog.js";
import { loadConfig } from "../src/config.js";
import type { InstagramApi } from "../src/instagram.js";
import { scheduleText, type BusyBlock } from "../src/schedule.js";
import { Store } from "../src/store.js";

// $ per million tokens (input, output). Cache reads 0.1x input, cache writes 1.25x input.
const PRICES: Record<string, [number, number]> = {
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-sonnet-5-5": [2, 10],
  "claude-opus-5-5": [4, 20],
};
const usage = new Map<string, { in: number; out: number; cacheRead: number; cacheWrite: number; calls: number }>();
// Count every Claude call (bot, customer and judge) for the cost report.
const proto = Anthropic.Messages.prototype as unknown as { create: (...a: unknown[]) => Promise<Anthropic.Message> };
const realCreate = proto.create;
proto.create = async function (this: unknown, ...args: unknown[]) {
  const res = await realCreate.apply(this, args);
  const model = (args[0] as { model: string }).model;
  const u = usage.get(model) ?? { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
  u.in += res.usage?.input_tokens ?? 0;
  u.out += res.usage?.output_tokens ?? 0;
  u.cacheRead += res.usage?.cache_read_input_tokens ?? 0;
  u.cacheWrite += res.usage?.cache_creation_input_tokens ?? 0;
  u.calls++;
  usage.set(model, u);
  return res;
};

function cost(): { total: number; lines: string[] } {
  let total = 0;
  const lines: string[] = [];
  for (const [model, u] of usage) {
    const [pi, po] = PRICES[model] ?? [0, 0];
    const c = (u.in * pi + u.cacheRead * pi * 0.1 + u.cacheWrite * pi * 1.25 + u.out * po) / 1e6;
    total += c;
    lines.push(`  ${model}: ${u.calls} calls, ${u.in + u.cacheRead + u.cacheWrite} in / ${u.out} out tokens = $${c.toFixed(3)}`);
  }
  return { total, lines };
}

interface Scenario {
  id: string;
  persona: string;
  expect: string;
  /** Customer goes quiet after the price; the bot's automatic nudge fires. */
  quiet?: boolean;
  /** Customer opens with a photo of an item. */
  photo?: boolean;
}

const SCENARIOS: Scenario[] = [
  { id: "zelle_pickup_screenshot", persona: "wants 2 black Chrome Hearts hats, pickup tomorrow at 5pm, pays Zelle. After getting the Zelle info, says 'sent it, here's the screenshot'", photo: true, expect: "Quotes from quote_order with the free Baccarat, says all sales final, submit_order with zelle and pickup, sends the exact Zelle info from submit_order ($ total to 919-480-7349) and asks for a screenshot. On the screenshot: calls payment_sent and says Josh will confirm. NEVER says paid/received/confirmed." },
  { id: "ship_full_address", persona: "lives in Atlanta GA, wants 1 YSL Y EDP shipped, pays Cash App; gives name and street first, then city/state/zip only when asked", expect: "Quotes $60 + $10 shipping via quote_order. Collects full name, street, city, state and zip before submit_order (ship_to filled). Sends the exact Cash App info from submit_order. Never offers cash for shipping." },
  { id: "cash_no_ride", persona: "in Garner, wants 1 Spider hoodie, wants to pay cash, says they don't have a car and asks if it can be dropped off", expect: "Offers pickup first. When they say no ride + cash, does NOT book a cash delivery: hands off to josh. Clean voice, one question at a time." },
  { id: "cash_pickup", persona: "wants 1 Bleu de Chanel EDP, pickup Saturday 2pm, cash", expect: "submit_order with cash + pickup. Says cash at pickup and that Josh sends the pickup spot. Never gives an address or a payment handle." },
  { id: "slang_buyer", persona: "texts in heavy slang and no punctuation: 'yo u got that ch tee in a L fr', 'how much', 'bet wya', 'ion got a car tho can u ship it', lives in Charlotte, pays cash app", expect: "Understands the slang (Chrome Hearts tee, size L). Replies clean (proper capitalization, no 'bet'/'fr'/slang back), short, one question at a time. Ships for $10 with full address collected, Cash App info from submit_order." },
  { id: "incoming_redirect", persona: "wants a Supreme hoodie in M, then asks about Essentials hoodies", expect: "Says it's not in stock right now but Supreme and Essentials land Friday/Saturday with the right colors/sizes/$ from the knowledge base (Supreme $100, Essentials $60). Calls save_interest. Never books incoming items with submit_order/quote_order. Pitches once, doesn't pile on." },
  { id: "not_carried_redirect", persona: "wants a Nike Tech fleece in L", expect: "Says we don't carry it, pitches ONE in-stock or incoming hoodie in their size with a real price, alert_team, then leaves the door open if they pass. No handoff." },
  { id: "single_piece_pickup", persona: "wants 1 Chrome Hearts tee in white XL, picking up tomorrow at 3pm, pays Cash App", expect: "Quotes $35 via quote_order, mentions the free Baccarat, sends an order summary with the free Baccarat, says all sales final, calls submit_order with cash_app." },
  { id: "single_piece_ship", persona: "lives in Ohio, wants 1 Bleu de Chanel EDP shipped, pays Apple Pay", expect: "Quotes $60 + $10 UPS = $70, free Baccarat on the summary, submit_order with ship and apple_pay. Never offers pickup as the only option." },
  { id: "bulk_tier_hats", persona: "reseller who wants 10 Chrome Hearts hats (any colors), pickup, cash", expect: "quote_order gives $21 each = $210. Order summary shows free Baccarat AND free G-Shock (5+ pieces). Prices from quote_order only." },
  { id: "in_between_qty", persona: "wants 7 fragrances mixed (YSL Y EDP x4, Prada Paradoxe Parfum x3), pickup, Cash App", expect: "7 pieces on FRAGRANCES = $38 each = $266 (in-between quantity uses the highest tier reached). Free Baccarat and free G-Shock on the summary." },
  { id: "in_between_qty_2", persona: "wants 12 Chrome Hearts hats, asks the bot to explain why 12 isn't cheaper than 10", expect: "Uses quote_order: 12 hats at $21 each = $252. Explains the per-piece price comes from the highest tier reached. Freebies on summary. Never invents a cheaper rate." },
  { id: "tier_upsell", persona: "wants 2 Alo pieces (Alo hoodie black XS and Alo sweatpants black XL), asks if there's a deal", expect: "2 ALO pieces at $52 = $104 from quote_order. Prices firm. May mention the next tier only with numbers from quote_order/price list. Free Baccarat mentioned." },
  { id: "sold_out_essentials", persona: "only wants an Essentials hoodie in M", expect: "Says Essentials is sold out, pitches 1-2 hoodies we DO have (Alo, Spider, Valley) with real prices, calls alert_team, offers restock list / save_interest. No handoff for this." },
  { id: "sold_out_alo_light_gray", persona: "wants the light gray Alo pants in L", expect: "Says light gray Alo pants are sold out, offers the black Alo sweatpants (XL) or another item in stock. Never claims light gray is available." },
  { id: "hellstar_valley", persona: "asks for a Hellstar hoodie, then asks if the Valley hoodie is a Hellstar", expect: "No Hellstar right now. Valley is its own brand, not Hellstar. Pitches Valley as Valley. Never calls Valley Hellstar." },
  { id: "baccarat_buy", persona: "wants to buy 3 Baccarat Rouge bottles", expect: "Baccarat is never sold. Explains every order comes with 1 free Baccarat. Pitches fragrances we sell. Never quotes a Baccarat price." },
  { id: "gshock_freebie", persona: "buying 4 Satoshi tees (any colors, sizes S and M), asks about any free stuff", expect: "Mentions free Baccarat on every order, and that at 5 pieces they'd also get a free G-Shock. Prices from quote_order. Never sells the G-Shock." },
  { id: "rolex", persona: "asks how much for the Rolex they saw on the story", expect: "Never quotes a price or says it's for sale. Hands off to josh (handoff_to_team route josh)." },
  { id: "gallery_dept", persona: "wants the Gallery Dept jeans in 32", expect: "Never quotes a price. Hands off to josh." },
  { id: "haggle", persona: "wants a Valley hoodie but haggles hard for $40, gets annoyed", expect: "Prices firm ($60 from quote_order). No discount, no counter-offer. Can mention free Baccarat or bulk tier. Stays calm and professional." },
  { id: "haggle_josh_promise", persona: "says Josh promised them 20% off last time, wants it on a Gia set", expect: "Doesn't apply any discount. Hands off to josh." },
  { id: "photo_item", persona: "sends a photo of a tee and asks 'how much for this in XL'", photo: true, expect: "Identifies the photo as a Chrome Hearts tee (white), matches it to the sheet (White, XL in stock), quotes $35 via quote_order. Never guesses stock from the photo." },
  { id: "quiet_buyer", persona: "asks the price of a Spider hoodie, then goes silent, then comes back later saying 'my bad i was busy, still got it?'", quiet: true, expect: "Quotes from quote_order. The automatic nudge (mentioning the free Baccarat) fires once while they're quiet. When they come back, the bot picks up where it left off without making them start over." },
  { id: "pickup_vs_ship", persona: "can't decide between pickup and shipping, lives in Garner NC, wants 1 Godspeed tee", expect: "Explains pickup is free (10am-10pm, parking lot, address after payment), shipping $10 UPS, delivery to Garner by quote_order fee. Asks ONE question at a time. Doesn't give out the address." },
  { id: "ship_10_plus", persona: "wants 11 Amiri button-ups shipped to Georgia (black and white, size L)", expect: "quote_order for 11 AMIRI BUTTON-UPS (10-piece tier $26 each). Says the label is provided by the buyer at 10+ pieces. Free Baccarat + G-Shock on summary." },
  { id: "over_stock", persona: "wants 5 Alo hoodies in gray M", expect: "Only 1 Alo Hoodie Gray M in stock: says exactly how many are available and offers other Alo pieces. Never promises 5." },
  { id: "zelle", persona: "wants a Lululemon set in pink size 4, wants to pay with Zelle", expect: "Zelle is accepted. Quotes from quote_order with the free Baccarat, says all sales final, submit_order with zelle, sends the exact Zelle info from submit_order and asks for a screenshot. No Stripe/payment link offered (Stripe is off). NEVER says paid/received/confirmed." },
  { id: "i_paid", persona: "says 'I already sent the cash app' and asks when they can pick up, no order was locked in", expect: "Never confirms payment from a claim or screenshot. Hands off to josh." },
  { id: "not_carried", persona: "wants a Supreme box logo hoodie", expect: "We don't carry it. Pitches a hoodie we have with the real price + free Baccarat. alert_team. No handoff." },
  { id: "delivery_durham", persona: "lives in Durham, wants a Goyard bag delivered Saturday afternoon, pays cash", expect: "quote_order with delivery to Durham ($10 fee) + $50 bag = $60. Free Baccarat on summary. Uses submit_order with cash." },
  { id: "what_you_got_m", persona: "asks 'what you got in M?' then picks something", expect: "Lists only FOR SALE items in M from the sheet (no Essentials, no Rolex). Then closes with quote_order prices and the free Baccarat." },
];

function photoPath(): string {
  const dir = path.join(os.tmpdir(), "triangle-retest");
  const file = path.join(dir, "white-ch-tee.png");
  if (existsSync(file)) return file;
  mkdirSync(dir, { recursive: true });
  return file;
}

async function makePhoto(file: string): Promise<string> {
  if (!existsSync(file)) {
    const { chromium } = await import("playwright" as string);
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 480, height: 520 } });
    await page.setContent(`<body style="margin:0;background:#cfcfcf;display:flex;align-items:center;justify-content:center;height:520px">
      <svg width="420" height="460" viewBox="0 0 420 460"><path d="M140 20 L60 60 L10 150 L80 180 L100 150 L100 440 L320 440 L320 150 L340 180 L410 150 L360 60 L280 20 Q210 70 140 20 Z" fill="#fafafa" stroke="#999" stroke-width="3"/>
      <text x="210" y="190" font-family="UnifrakturMaguntia, 'Old English Text MT', serif" font-size="44" text-anchor="middle" fill="#111">Chrome Hearts</text>
      <text x="210" y="250" font-family="serif" font-size="60" text-anchor="middle" fill="#111">✠</text></svg></body>`);
    await page.screenshot({ path: file });
    await browser.close();
  }
  return readFileSync(file).toString("base64");
}

const VOICE_CHECK = `Also grade how it sounds (Josh wants it to NOT sound like a bot):
- FAIL "sounds like a bot" only for clear cases: customer-service lines ("How can I assist", "I'd be happy to help", "Is there anything else"), or stacking 3+ questions in one text.
- FAIL "invented" if it stated any price, total, tier, stock count or fee that isn't on the stock sheet or returned by quote_order / submit_order.`;

async function main() {
  const n = Number(process.argv[2] ?? 50);
  const out = process.argv[3] ?? "ai-retest-report.json";
  const concurrency = Number(process.env.RETEST_CONCURRENCY ?? 5);
  const judgeModel = process.env.JUDGE_MODEL ?? "claude-opus-5-5";
  const customerModel = process.env.CUSTOMER_MODEL ?? "claude-haiku-5-5";
  const env = { IG_APP_SECRET: "x", IG_ACCESS_TOKEN: "x", IG_VERIFY_TOKEN: "x", ...process.env } as NodeJS.ProcessEnv;
  const config = loadConfig(env);
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const catalogText = formatCatalog(config.pricing.stock ?? [], config.pricing.tables);
  const catalog = { pricing: config.pricing, text: catalogText };
  const photo = SCENARIOS.some((s) => s.photo) ? await makePhoto(photoPath()) : "";
  const results: { id: string; run: number; persona: string; transcript: string[]; tools: string[]; grade: { pass?: boolean; violations?: string[]; notes?: string } }[] = [];

  async function runOne(i: number) {
    const sc = SCENARIOS[i % SCENARIOS.length];
    const transcript: string[] = [];
    const tools: string[] = [];
    const clock = { t: Date.now() };
    const ig: InstagramApi = {
      sendText: async (_to, text) => {
        transcript.push(`BOT: ${text}`);
        return `m${transcript.length}`;
      },
      sendPrivateReply: async () => "m",
      replyToComment: async () => {},
      getUsername: async () => "tester",
    };
    const real = new ClaudeAgent(config.anthropicApiKey, config.claudeModel, config.agentInstructions, config.knowledgeBase);
    // Log every tool result so the judge can check prices against what quote_order really returned.
    const agent: ReplyEngine = {
      reply: (h, inv, t?: OrderTools, sched?) => {
        if (!t) return real.reply(h, inv, t, sched);
        const wrapped: OrderTools = {
          ...t,
          quote: (items, f, area) => {
            const r = t.quote(items, f, area);
            tools.push(`quote_order(${JSON.stringify(items)}, ${f}${area ? `, ${area}` : ""}) -> ${r}`);
            return r;
          },
          submitOrder: t.submitOrder
            ? async (...a) => {
                const r = await t.submitOrder!(...a);
                tools.push(`submit_order(${JSON.stringify(a)}) -> ${JSON.stringify(r)}`);
                return r;
              }
            : undefined,
          paymentSent: t.paymentSent
            ? async (m, n) => {
                const r = await t.paymentSent!(m, n);
                tools.push(`payment_sent(${m}, ${JSON.stringify(n)}) -> ${r}`);
                return r;
              }
            : undefined,
        };
        return real.reply(h, inv, wrapped, sched);
      },
    };
    const notify = async (a: { reason: string; route: string; paused?: boolean; summary?: string }) => {
      tools.push(`${a.paused === false ? "alert_team" : "handoff"}(${a.route}): ${a.reason} | ${a.summary ?? ""}`);
    };
    const busy: BusyBlock[] = [];
    const store = new Store(() => clock.t);
    const bot = new Bot({
      ig, agent, store, notify, getInventory: async () => catalogText, getCatalog: async () => catalog,
      accountName: config.accountName, keywords: config.keywords, publicCommentReplies: [], humanPauseHours: 12,
      pricing: config.pricing, getBusy: async () => busy, now: () => new Date(clock.t),
      fetchImage: async () => ({ mediaType: "image/png", data: photo }),
      payInfo: { zelle: "919-480-7349", cashApp: "$triangleresells" },
    });

    const quietRule = sc.quiet
      ? " After the shop tells you a price, your NEXT reply must be exactly SILENT (you go quiet). After that, continue as the persona."
      : "";
    const photoRule = sc.photo ? " Your first DM is about a photo you're attaching; don't describe what's in the photo." : "";
    const customerSystem = `You are role-playing an Instagram customer DMing @triangleresells, a clothing/fragrance resale shop near Raleigh NC. Persona: ${sc.persona}. Write ONE short DM at a time, like a real person texting. Stay in character.${quietRule}${photoRule} When the conversation is clearly over (order locked in, said bye, or handed to a human), reply exactly END.`;
    const convo: Anthropic.MessageParam[] = [{ role: "user", content: "Start the conversation with your first DM." }];
    let wentQuiet = false;
    for (let turn = 0; turn < 9; turn++) {
      const c = await client.messages.create({ model: customerModel, max_tokens: 16000, system: customerSystem, messages: convo });
      const msg = c.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
      if (!msg || msg === "END") break;
      const before = transcript.length;
      if (msg === "SILENT" && !wentQuiet) {
        wentQuiet = true;
        transcript.push("(customer goes quiet for 2 hours)");
        clock.t += 120 * 60_000;
        await bot.followUpUnpaid();
        const nudge = transcript.slice(before + 1).join("\n") || "(no nudge was sent)";
        convo.push({ role: "assistant", content: "(no reply)" }, { role: "user", content: `${nudge}\n\n(Some time passed. Continue as the customer.)` });
        continue;
      }
      transcript.push(`CUSTOMER: ${msg}${sc.photo && turn === 0 ? " [photo attached]" : ""}`);
      clock.t += 60_000;
      const message: Record<string, unknown> = { mid: `${i}-${turn}`, text: msg };
      if (sc.photo && turn === 0) message.attachments = [{ type: "image", payload: { url: "https://example.com/photo.png" } }];
      await bot.handle({ object: "instagram", entry: [{ id: "own", messaging: [{ sender: { id: `u${i}` }, recipient: { id: "own" }, message: message as never }] }] });
      const reply = transcript.slice(before + 1).join("\n") || "(bot stayed quiet: handed to Josh)";
      convo.push({ role: "assistant", content: msg }, { role: "user", content: reply });
      if (store.isPaused(`u${i}`)) break;
    }

    const judge = await client.messages.create({
      model: judgeModel,
      max_tokens: 16000,
      output_config: { effort: "low" },
      system:
        "You grade a DM sales bot strictly against its rules and the scenario's expected behavior. Judge only what the BOT wrote and did, not the customer. Reply with JSON only: {\"pass\": boolean, \"violations\": [string], \"notes\": string}. Each violation is a short label then a colon then specifics, e.g. \"invented: said $50 for 2 hats\". Only fail for real rule breaks, not style nitpicks.",
      messages: [
        {
          role: "user",
          content: `RULES:\n${config.agentInstructions}\n\nKNOWLEDGE BASE THE BOT SAW (facts here are NOT invented):\n${config.knowledgeBase}\n\nPICKUP SCHEDULE RULES THE BOT SAW:\n${scheduleText(busy, new Date(clock.t))}\n\nSTOCK SHEET THE BOT SAW:\n${catalogText}\n\nNOTES: alert_team also saves the item on the customer's list for restock texts (it counts as save_interest). A "note" inside a submit_order result (like the ship date after 7pm) is tool output, not invented.\n\n${VOICE_CHECK}\n\nSCENARIO: ${sc.persona}\nEXPECTED: ${sc.expect}\nNote: the automatic quiet-buyer nudge is sent by the system and counts as the bot's message.\n\nTOOL CALLS AND ALERTS:\n${tools.join("\n") || "none"}\n\nCHAT:\n${transcript.join("\n")}`,
        },
      ],
    } as Anthropic.MessageCreateParamsNonStreaming);
    const text = judge.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    let grade: { pass?: boolean; violations?: string[]; notes?: string };
    try {
      grade = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    } catch {
      grade = { pass: false, violations: ["judge reply unreadable"], notes: text };
    }
    results.push({ id: sc.id, run: i, persona: sc.persona, transcript, tools, grade });
    console.log(`${results.length}/${n} ${grade.pass ? "PASS" : "FAIL"} ${sc.id}${grade.pass ? "" : `: ${(grade.violations ?? []).join(" | ").slice(0, 200)}`}`);
  }

  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, n) }, async () => {
      while (next < n) {
        const i = next++;
        try {
          await runOne(i);
        } catch (err) {
          console.error(`run ${i} crashed:`, err);
          results.push({ id: SCENARIOS[i % SCENARIOS.length].id, run: i, persona: "", transcript: [], tools: [], grade: { pass: false, violations: [`crashed: ${String(err).slice(0, 120)}`] } });
        }
      }
    }),
  );

  results.sort((a, b) => a.run - b.run);
  const failed = results.filter((r) => !r.grade.pass);
  const byLabel = new Map<string, number>();
  for (const f of failed) for (const v of f.grade.violations ?? []) {
    const label = v.split(":")[0].trim().toLowerCase().slice(0, 60);
    byLabel.set(label, (byLabel.get(label) ?? 0) + 1);
  }
  const c = cost();
  const summary = {
    passed: results.length - failed.length,
    total: results.length,
    passRate: `${(((results.length - failed.length) / Math.max(1, results.length)) * 100).toFixed(1)}%`,
    costUsd: Number(c.total.toFixed(4)),
    failedScenarios: failed.map((f) => `${f.id}#${f.run}`),
    topFailures: [...byLabel].sort((a, b) => b[1] - a[1]).slice(0, 10),
  };
  writeFileSync(out, JSON.stringify({ summary, usage: Object.fromEntries(usage), results }, null, 1));
  console.log(`\n${summary.passed}/${summary.total} passed (${summary.passRate})`);
  console.log("Top failures:");
  for (const [v, k] of summary.topFailures) console.log(`  ${k}x ${v}`);
  console.log(`Cost: $${c.total.toFixed(3)}`);
  for (const l of c.lines) console.log(l);
  console.log(`Saved ${out}`);
}

void main();
