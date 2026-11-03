import { ClaudeAgent } from "./ai.js";
import { Bot } from "./bot.js";
import { loadConfig } from "./config.js";
import { webhookNotifier } from "./handoff.js";
import { InstagramClient } from "./instagram.js";
import { InventorySheet } from "./inventory.js";
import { createServer } from "./server.js";
import { Store } from "./store.js";

const config = loadConfig();
const store = new Store();
const inventory = new InventorySheet(config.inventorySheetCsvUrl);

const bot = new Bot({
  ig: new InstagramClient(config.igAccessToken, config.igApiVersion),
  agent: new ClaudeAgent(config.anthropicApiKey, config.claudeModel, config.agentInstructions, config.knowledgeBase),
  store,
  notify: webhookNotifier(config.handoffWebhookUrl),
  getInventory: () => inventory.get(),
  accountName: config.accountName,
  keywords: config.keywords,
  publicCommentReplies: config.publicCommentReplies,
  humanPauseHours: config.humanPauseHours,
  debounceMs: 4000,
});

setInterval(() => store.cleanup(), 60 * 60 * 1000).unref();

createServer(bot, { appSecret: config.igAppSecret, verifyToken: config.igVerifyToken }).listen(config.port, () => {
  console.log(
    `[server] ${config.accountName} DM agent listening on :${config.port} ` +
      `(${config.keywords.length} keywords, model ${config.claudeModel}, ` +
      `inventory sheet ${config.inventorySheetCsvUrl ? "on" : "off"})`,
  );
});
