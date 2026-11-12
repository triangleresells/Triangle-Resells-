import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseStockCsv } from "./catalog.js";
import type { PricingConfig } from "./pricing.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface KeywordRule {
  account: string;
  keyword: string;
  reply: string;
}

export interface Config {
  igAppSecret: string;
  /** Optional second secret (the Facebook app secret from App settings -> Basic). Webhooks signed with either are accepted. */
  metaAppSecret: string;
  igAccessToken: string;
  igVerifyToken: string;
  igApiVersion: string;
  anthropicApiKey: string;
  claudeModel: string;
  accountName: string;
  vendorSiteUrl: string;
  /** The whole Google service account key file (JSON, or base64 of it). Blank = use the saved snapshot. */
  googleServiceAccountJson: string;
  /** The warehouse sheet with the BOT STOCK and BOT PRICES tabs. */
  warehouseSheetId: string;
  /** Josh's sales tracker spreadsheet (one tab per month). */
  trackerSheetId: string;
  /** What the bot sends Zelle / Cash App buyers, e.g. "919-480-7349 (Josh ...)" and "$TriangleResells". Blank = Josh sends it. */
  payZelle: string;
  payCashApp: string;
  handoffWebhookUrl: string;
  humanPauseHours: number;
  /** Stripe payment links. Off unless STRIPE_ENABLED=true AND a key is set. Right now buyers pay cash, Cash App or Apple Pay. */
  stripeEnabled: boolean;
  stripeSecretKey: string;
  stripeWebhookSecret: string;
  checkoutSuccessUrl: string;
  calendarWebhookUrl: string;
  warehouseAddress: string;
  /** File for the bot's small database (chats, follow-ups, customer list). Blank = memory only. */
  stateFile: string;
  /** Master switch: the bot only sends DMs when BOT_ENABLED is "true". Anything else = OFF. */
  botEnabled: boolean;
  /** Minutes before a quoted buyer who went quiet gets one nudge. 0 = off. */
  quietNudgeMinutes: number;
  /** Josh has the chat but the buyer waited this long with no reply: the bot takes over. 0 = never. */
  takeoverMinutes: number;
  /** Wait ~42-58s before answering a cold DM (8-18s mid-conversation). HUMAN_REPLY_DELAY=false turns it off (4s debounce only). */
  humanReplyDelay: boolean;
  /** Password for the /admin customer list page. Blank = page off. */
  adminKey: string;
  pricing: PricingConfig;
  port: number;
  agentInstructions: string;
  knowledgeBase: string;
  keywords: KeywordRule[];
  publicCommentReplies: string[];
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`Missing required env var ${name}. See .env.example.`);
  return v;
}

/** Placeholder words Josh can type in Render for things not set up yet. They count as blank (feature off). */
const NOT_SET = new Set(["pending", "none", "skip", "na", "n/a", "-", "x", "tbd", "later"]);

/** An optional setting: blank or a placeholder like "pending" turns that feature off. */
export function optional(v: string | undefined): string {
  const t = v?.trim() ?? "";
  return NOT_SET.has(t.toLowerCase()) ? "" : t;
}

/** What kind of Instagram token is set, without revealing it (for Render's logs). */
export function describeToken(t: string): string {
  if (!t || NOT_SET.has(t.toLowerCase())) return "NOT SET (still a placeholder)";
  if (t.length < 50) return `looks too short (${t.length} characters), probably cut off when copying`;
  if (t.startsWith("IG")) return `Instagram token (starts with IG, ${t.length} characters)`;
  if (t.startsWith("EAA")) return `Facebook-style token (starts with EAA, ${t.length} characters): sending through graph.facebook.com`;
  return `unrecognized token (${t.length} characters)`;
}

/** TRIANGLERESELLS WAREHOUSE STOCK. */
export const DEFAULT_SHEET_ID = "1hZQltkbmqhN4acr959K7cNxUcvLW-P38Ut60O805wOw";

/** Saved snapshot of the sheet: prices from config/pricing.json, stock from config/stock.csv. */
export function loadPricing(): PricingConfig {
  const pricing = JSON.parse(readConfigFile("pricing.json")) as PricingConfig;
  let stock = "";
  try {
    stock = readConfigFile("stock.csv");
  } catch {
    // no snapshot: nothing can be sold until the sheet is read
  }
  return { ...pricing, stock: parseStockCsv(stock) };
}

export function readConfigFile(name: string): string {
  return readFileSync(path.join(root, "config", name), "utf8");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const accountName = env.ACCOUNT_NAME?.trim() || "Triangle Resells";
  const vendorSiteUrl = env.VENDOR_SITE_URL?.trim() || "triangleresells.com";

  const fill = (s: string) =>
    s.replaceAll("{{ACCOUNT_NAME}}", accountName).replaceAll("{{VENDOR_SITE_URL}}", vendorSiteUrl);

  const kw = JSON.parse(readConfigFile("keywords.json")) as {
    keywords: KeywordRule[];
    publicCommentReplies?: string[];
  };

  return {
    igAppSecret: required(env, "IG_APP_SECRET").replace(/\s+/g, ""),
    metaAppSecret: optional(env.META_APP_SECRET).replace(/\s+/g, ""),
    igAccessToken: required(env, "IG_ACCESS_TOKEN").replace(/\s+/g, ""),
    igVerifyToken: required(env, "IG_VERIFY_TOKEN"),
    igApiVersion: env.IG_API_VERSION?.trim() || "v23.0",
    anthropicApiKey: required(env, "ANTHROPIC_API_KEY"),
    claudeModel: env.CLAUDE_MODEL?.trim() || "claude-haiku-5-5",
    accountName,
    vendorSiteUrl,
    googleServiceAccountJson: optional(env.GOOGLE_SERVICE_ACCOUNT_JSON),
    warehouseSheetId: optional(env.WAREHOUSE_SHEET_ID) || DEFAULT_SHEET_ID,
    trackerSheetId: optional(env.TRACKER_SHEET_ID) || "1ks_DjoGUucVHgzf7mhx9P1B1HTySaNxWbGGsteQ1eGI",
    payZelle: env.PAY_ZELLE?.trim() || "",
    payCashApp: env.PAY_CASHAPP?.trim() || "$triangleresells",
    handoffWebhookUrl: optional(env.HANDOFF_WEBHOOK_URL),
    // HUMAN_PAUSE_MINUTES wins if set (e.g. 5); otherwise HUMAN_PAUSE_HOURS; default 12 hours.
    humanPauseHours: Number(env.HUMAN_PAUSE_MINUTES) > 0 ? Number(env.HUMAN_PAUSE_MINUTES) / 60 : Number(env.HUMAN_PAUSE_HOURS) || 12,
    stripeEnabled: /^(true|on|yes|1)$/i.test(env.STRIPE_ENABLED?.trim() ?? "") && !!optional(env.STRIPE_SECRET_KEY),
    stripeSecretKey: optional(env.STRIPE_SECRET_KEY),
    stripeWebhookSecret: optional(env.STRIPE_WEBHOOK_SECRET),
    checkoutSuccessUrl: env.CHECKOUT_SUCCESS_URL?.trim() || `https://${vendorSiteUrl.replace(/^https?:\/\//, "")}`,
    calendarWebhookUrl: optional(env.CALENDAR_WEBHOOK_URL),
    warehouseAddress: env.WAREHOUSE_ADDRESS?.trim() || "",
    stateFile: env.STATE_FILE?.trim() || "",
    adminKey: optional(env.ADMIN_KEY),
    humanReplyDelay: (env.HUMAN_REPLY_DELAY ?? "true").trim().toLowerCase() !== "false",
    takeoverMinutes: env.TAKEOVER_MINUTES?.trim() ? Math.max(0, Number(env.TAKEOVER_MINUTES) || 0) : 5,
    quietNudgeMinutes: env.QUIET_NUDGE_MINUTES?.trim() ? Math.max(0, Number(env.QUIET_NUDGE_MINUTES) || 0) : 90,
    botEnabled: /^(true|on|yes|1)$/i.test(env.BOT_ENABLED?.trim() ?? ""),
    pricing: loadPricing(),
    port: Number(env.PORT) || 3000,
    agentInstructions: fill(readConfigFile("agent-instructions.md")),
    knowledgeBase: fill(readConfigFile("knowledge-base.md")),
    keywords: kw.keywords.filter(
      (k) => k.account.toLowerCase() === accountName.toLowerCase(),
    ),
    publicCommentReplies: kw.publicCommentReplies ?? [],
  };
}
