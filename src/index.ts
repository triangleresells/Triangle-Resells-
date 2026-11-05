import { ClaudeAgent } from "./ai.js";
import { Bot } from "./bot.js";
import { loadConfig } from "./config.js";
import { webhookNotifier } from "./handoff.js";
import { InstagramClient } from "./instagram.js";
import { InventorySheet } from "./inventory.js";
import { createServer } from "./server.js";
import { handlePaidOrder, webhookCalendar } from "./orders.js";
import { FileSaver } from "./persist.js";
import { BusyCalendar } from "./schedule.js";
import { Store } from "./store.js";
import { StripeCheckout } from "./stripe.js";

const config = loadConfig();
const store = new Store();
// Small database: chats, pending follow-ups and the customer list survive redeploys.
const saver = new FileSaver(config.stateFile, store);
saver.load();
saver.watch();
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, () => {
    saver.saveNow();
    process.exit(0);
  });
}
const inventory = new InventorySheet(config.inventorySheetCsvUrl);
// Josh's calendar: paid pickups plus any time he blocks off. The bot never offers those times.
const busyCalendar = new BusyCalendar(config.calendarWebhookUrl);

const notify = webhookNotifier(config.handoffWebhookUrl);
const bot = new Bot({
  ig: new InstagramClient(config.igAccessToken, config.igApiVersion),
  agent: new ClaudeAgent(config.anthropicApiKey, config.claudeModel, config.agentInstructions, config.knowledgeBase),
  store,
  notify,
  getInventory: () => inventory.get(),
  accountName: config.accountName,
  keywords: config.keywords,
  publicCommentReplies: config.publicCommentReplies,
  humanPauseHours: config.humanPauseHours,
  debounceMs: 4000,
  pricing: config.pricing,
  checkout: config.stripeSecretKey ? new StripeCheckout(config.stripeSecretKey, config.checkoutSuccessUrl) : undefined,
  getBusy: () => busyCalendar.get(),
});
const calendar = webhookCalendar(config.calendarWebhookUrl);

setInterval(() => store.cleanup(), 60 * 60 * 1000).unref();
// One follow-up DM when a payment link expires unpaid.
setInterval(() => void bot.followUpUnpaid().catch((err) => console.error("[bot] follow-ups failed:", err)), 60 * 1000).unref();

createServer(bot, {
  appSecret: config.igAppSecret,
  verifyToken: config.igVerifyToken,
  stripeWebhookSecret: config.stripeWebhookSecret,
  admin: { key: config.adminKey, customers: () => store.allCustomers(), blast: (m, s) => bot.blast(m, s) },
  onPaidOrder: (order) => {
    bot.markPaid(order.igUserId, order.summary, order.total);
    return handlePaidOrder(order, {
      sendDm: (id, text) => bot.sendDm(id, text),
      calendar,
      notify,
      warehouseAddress: config.warehouseAddress,
      accountName: config.accountName,
    });
  },
}).listen(config.port, () => {
  console.log(
    `[server] ${config.accountName} DM agent listening on :${config.port} ` +
      `(${config.keywords.length} keywords, model ${config.claudeModel}, ` +
      `inventory sheet ${config.inventorySheetCsvUrl ? "on" : "off"}, ` +
      `stripe ${config.stripeSecretKey ? "on" : "off"}, calendar ${config.calendarWebhookUrl ? "on" : "off"}, ` +
      `database ${config.stateFile || "off (memory only)"}, admin page ${config.adminKey ? "on" : "off"})`,
  );
});
