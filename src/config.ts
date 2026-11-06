import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
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
  inventorySheetCsvUrl: string;
  handoffWebhookUrl: string;
  humanPauseHours: number;
  stripeSecretKey: string;
  stripeWebhookSecret: string;
  checkoutSuccessUrl: string;
  calendarWebhookUrl: string;
  warehouseAddress: string;
  /** File for the bot's small database (chats, follow-ups, customer list). Blank = memory only. */
  stateFile: string;
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
    inventorySheetCsvUrl: optional(env.INVENTORY_SHEET_CSV_URL),
    handoffWebhookUrl: optional(env.HANDOFF_WEBHOOK_URL),
    // HUMAN_PAUSE_MINUTES wins if set (e.g. 5); otherwise HUMAN_PAUSE_HOURS; default 12 hours.
    humanPauseHours: Number(env.HUMAN_PAUSE_MINUTES) > 0 ? Number(env.HUMAN_PAUSE_MINUTES) / 60 : Number(env.HUMAN_PAUSE_HOURS) || 12,
    stripeSecretKey: optional(env.STRIPE_SECRET_KEY),
    stripeWebhookSecret: optional(env.STRIPE_WEBHOOK_SECRET),
    checkoutSuccessUrl: env.CHECKOUT_SUCCESS_URL?.trim() || `https://${vendorSiteUrl.replace(/^https?:\/\//, "")}`,
    calendarWebhookUrl: optional(env.CALENDAR_WEBHOOK_URL),
    warehouseAddress: env.WAREHOUSE_ADDRESS?.trim() || "",
    stateFile: env.STATE_FILE?.trim() || "",
    adminKey: optional(env.ADMIN_KEY),
    pricing: JSON.parse(readConfigFile("pricing.json")) as PricingConfig,
    port: Number(env.PORT) || 3000,
    agentInstructions: fill(readConfigFile("agent-instructions.md")),
    knowledgeBase: fill(readConfigFile("knowledge-base.md")),
    keywords: kw.keywords.filter(
      (k) => k.account.toLowerCase() === accountName.toLowerCase(),
    ),
    publicCommentReplies: kw.publicCommentReplies ?? [],
  };
}
