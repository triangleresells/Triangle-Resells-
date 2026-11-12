import { ClaudeAgent } from "./ai.js";
import { crmClient } from "./crm.js";
import { CrmSync } from "./crmsync.js";
import { StockSync } from "./stocksync.js";
import { Bot, DEFAULT_REPLY_TIMING } from "./bot.js";
import { describeToken, loadConfig } from "./config.js";
import { formatCatalog } from "./catalog.js";
import { GoogleSheetsReader, LiveCatalog, parseServiceAccount } from "./sheet.js";
import { OrderDesk, SalesLog, StockKeeper } from "./desk.js";
import { webhookNotifier } from "./handoff.js";
import { InstagramClient } from "./instagram.js";
import { createServer } from "./server.js";
import { handlePaidOrder, calendarEditor, webhookCalendar } from "./orders.js";
import { FileSaver } from "./persist.js";
import { BusyCalendar } from "./schedule.js";
import { Store } from "./store.js";
import { StripeCheckout } from "./stripe.js";

const config = loadConfig();
const store = new Store();
// Small database: chats, pending follow-ups and the customer list survive redeploys.
const saver = new FileSaver(config.stateFile, store);
saver.load();
const shortened = store.capPauses(config.humanPauseHours);
if (shortened) console.log(`[bot] shortened ${shortened} paused chat(s) to the new ${Math.round(config.humanPauseHours * 60)}-minute pause`);
if (store.pausedChats().length) console.log(`[bot] ${store.pausedChats().length} chat(s) paused for a human right now: ${store.pausedChats().join(", ")}`);
saver.watch();
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, () => {
    saver.saveNow();
    process.exit(0);
  });
}
// Stock and prices: the warehouse sheet's BOT STOCK and BOT PRICES tabs, read with a Google service account.
// Until the service account is set up (or if Google is down), the saved snapshot in config/ is used.
const serviceAccount = parseServiceAccount(config.googleServiceAccountJson);
if (config.googleServiceAccountJson && !serviceAccount) console.error("[sheet] GOOGLE_SERVICE_ACCOUNT_JSON isn't a valid service account key file. Using the saved snapshot.");
const snapshot = { pricing: config.pricing, text: formatCatalog(config.pricing.stock ?? [], config.pricing.tables), source: "snapshot" as const };
const sheets = serviceAccount ? new GoogleSheetsReader(serviceAccount, config.warehouseSheetId) : undefined;
const catalog = new LiveCatalog(snapshot, sheets);
void catalog.get(); // warm up, and log right away if the sheet isn't shared with the service account
// Josh's calendar: paid pickups plus any time he blocks off. The bot never offers those times.
const busyCalendar = new BusyCalendar(config.calendarWebhookUrl);

const notify = webhookNotifier(config.handoffWebhookUrl);
const calendar = webhookCalendar(config.calendarWebhookUrl);
// Locked-in orders: stock off BOT STOCK, on the calendar, Josh alerted, sales tracker once paid.
// Triangle CRM: every locked-in order also becomes a CRM booking; reschedules, cancels and "I paid" go there too.
const crm = config.crmApiUrl && config.crmBotApiKey ? crmClient(config.crmApiUrl, config.crmBotApiKey) : undefined;
console.log(`[crm] ${crm ? "connected to " + new URL(config.crmApiUrl).host : "off (CRM_API_URL / CRM_BOT_API_KEY not set)"}`);
const stockKeeper = sheets ? new StockKeeper(sheets, () => catalog.refresh()) : undefined;
const desk = new OrderDesk({
  store,
  notify,
  crm,
  crmAssignee: config.crmAssignee,
  accountName: config.accountName,
  stock: stockKeeper,
  sales: sheets ? new SalesLog(sheets, config.trackerSheetId) : undefined,
  calendar,
  stockRows: async () => (await catalog.get()).pricing.stock ?? [],
});
const bot = new Bot({
  crm,
  calendarEdit: calendarEditor(config.calendarWebhookUrl),
  ig: new InstagramClient(config.igAccessToken, config.igApiVersion),
  agent: new ClaudeAgent(config.anthropicApiKey, config.claudeModel, config.agentInstructions, config.knowledgeBase),
  store,
  notify,
  getInventory: async () => (await catalog.get()).text,
  getCatalog: () => catalog.get(),
  accountName: config.accountName,
  keywords: config.keywords,
  publicCommentReplies: config.publicCommentReplies,
  humanPauseHours: config.humanPauseHours,
  debounceMs: 4000,
  // Waits ~42-58s on a cold DM and ~8-18s in a live back-and-forth, so it doesn't answer like a bot.
  replyTiming: config.humanReplyDelay ? DEFAULT_REPLY_TIMING : undefined,
  pricing: config.pricing,
  checkout: config.stripeEnabled ? new StripeCheckout(config.stripeSecretKey, config.checkoutSuccessUrl) : undefined,
  getBusy: () => busyCalendar.get(),
  enabled: () => config.botEnabled,
  quietNudgeMinutes: config.quietNudgeMinutes,
  takeoverMinutes: config.takeoverMinutes,
  desk,
  payInfo: { zelle: config.payZelle, cashApp: config.payCashApp },
});

setInterval(() => store.cleanup(), 60 * 60 * 1000).unref();
// One follow-up DM when a payment link expires unpaid.
// CRM -> bot: changes the team makes in the CRM (reschedule, cancel, paid, done, new bookings) flow back every 15s.
if (crm && sheets && stockKeeper) {
  // Stock: the CRM keeps the live count; BOT STOCK is synced both ways every minute.
  const stockSync = new StockSync({ crm, io: sheets, keeper: stockKeeper });
  void stockSync.tick();
  setInterval(() => void stockSync.tick(), 60 * 1000).unref();
} else if (crm) {
  console.log("[stock-sync] off: needs the Google service account (GOOGLE_SERVICE_ACCOUNT_JSON) to read and write BOT STOCK");
}
if (crm) {
  const sync = new CrmSync({
    crm, store, desk, calendarEdit: calendarEditor(config.calendarWebhookUrl),
    tellBuyer: (ig, text) => bot.messageBuyer(ig, text), notify, accountName: config.accountName,
  });
  setInterval(() => void sync.tick(), 15 * 1000).unref();
}
// Josh went quiet on a chat he had: after TAKEOVER_MINUTES the bot answers the waiting buyer.
setInterval(() => void bot.takeOverStalled().catch((err) => console.error("[bot] takeover failed:", err)), 30 * 1000).unref();
setInterval(() => void bot.followUpUnpaid().catch((err) => console.error("[bot] follow-ups failed:", err)), 60 * 1000).unref();

createServer(bot, {
  appSecret: config.igAppSecret,
  extraAppSecrets: [config.metaAppSecret],
  verifyToken: config.igVerifyToken,
  stripeWebhookSecret: config.stripeEnabled ? config.stripeWebhookSecret : "",
  health: async () => {
    const c = await catalog.get();
    return { botEnabled: config.botEnabled, stock: c.source, forSaleRows: (c.pricing.stock ?? []).filter((r) => r.status === "for_sale" && r.qty > 0).length };
  },
  admin: {
    key: config.adminKey,
    customers: () => store.allCustomers(),
    blast: (m, s) => bot.blast(m, s),
    unpauseAll: () => store.unpauseAll(),
    labels: { all: () => store.allLabels(), markPaid: (id) => desk.markPaid(id), done: (id) => desk.done(id), doneAll: () => desk.doneAll(), cancel: (id) => desk.cancel(id) },
  },
  onPaidOrder: async (order) => {
    await bot.markPaid(order.igUserId, order.summary, order.total, [order.fulfillment, order.fulfillDate, order.fulfillTime].filter(Boolean).join(" "), order.fulfillment);
    return handlePaidOrder(order, {
      sendDm: (id, text) => bot.sendDm(id, text),
      calendar,
      notify,
      warehouseAddress: config.warehouseAddress,
      accountName: config.accountName,
    });
  },
}).listen(config.port, () => {
  console.log(config.botEnabled ? "[bot] ON: replying to DMs" : "[bot] OFF: not sending any DMs (set BOT_ENABLED=true on Render to turn it on)");
  console.log(`[instagram] access token: ${describeToken(config.igAccessToken)}`);
  console.log(
    `[server] ${config.accountName} DM agent listening on :${config.port} ` +
      `(${config.keywords.length} keywords, model ${config.claudeModel}, ` +
      `stock sheet ${serviceAccount ? `via ${serviceAccount.client_email}` : "off (saved snapshot)"}, ` +
      `stripe ${config.stripeEnabled ? "on" : "off (cash, Cash App, Apple Pay via Josh)"}, calendar ${config.calendarWebhookUrl ? "on" : "off"}, ` +
      `database ${config.stateFile || "off (memory only)"}, admin page ${config.adminKey ? "on" : "off"})`,
  );
});
