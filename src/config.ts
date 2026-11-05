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
    igAppSecret: required(env, "IG_APP_SECRET"),
    igAccessToken: required(env, "IG_ACCESS_TOKEN"),
    igVerifyToken: required(env, "IG_VERIFY_TOKEN"),
    igApiVersion: env.IG_API_VERSION?.trim() || "v23.0",
    anthropicApiKey: required(env, "ANTHROPIC_API_KEY"),
    claudeModel: env.CLAUDE_MODEL?.trim() || "claude-haiku-5-5",
    accountName,
    vendorSiteUrl,
    inventorySheetCsvUrl: env.INVENTORY_SHEET_CSV_URL?.trim() || "",
    handoffWebhookUrl: env.HANDOFF_WEBHOOK_URL?.trim() || "",
    humanPauseHours: Number(env.HUMAN_PAUSE_HOURS) || 12,
    stripeSecretKey: env.STRIPE_SECRET_KEY?.trim() || "",
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET?.trim() || "",
    checkoutSuccessUrl: env.CHECKOUT_SUCCESS_URL?.trim() || `https://${vendorSiteUrl.replace(/^https?:\/\//, "")}`,
    calendarWebhookUrl: env.CALENDAR_WEBHOOK_URL?.trim() || "",
    warehouseAddress: env.WAREHOUSE_ADDRESS?.trim() || "",
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
