# Triangle AI DM Agent

Answers Instagram DMs for **@triangleresells** in Josh's voice, DMs anyone who comments a keyword (SHIP, RESTOCK, PRICE), sends the vendor link, and pings the team when a human needs to step in.

Uses Meta's official Instagram API, so there's no password sharing and no ban risk from bots.

## What it does

| Customer does | Bot does |
| --- | --- |
| Sends a DM | Replies in Josh's voice using the knowledge base and live inventory sheet |
| DMs just a keyword ("price") | Sends that keyword's first reply |
| Comments a keyword on a post | DMs them the keyword's first reply and comments "Sent you a DM!" |
| Is ready to buy, wants bulk, is upset, asks for a person, or asks something the bot doesn't know | Tells them someone's coming, pauses itself in that chat, and alerts the team |
| (A team member replies from the Instagram inbox) | Steps back in that chat for 12 hours |

## Editing the bot (no coding)

Everything the bot says comes from three files in `config/`. Edit on GitHub (open the file, tap the pencil), commit, and the host redeploys.

- **`knowledge-base.md`**: shipping, payment, policies, restock dates. No prices or stock (those come from the sheet).
- **`pricing.json`** / **`stock.csv`**: a SAVED SNAPSHOT of the warehouse sheet, used only if the sheet can't be read. Refresh with `npm run sync-sheet`. Shipping and delivery fees live in `pricing.json`.
- **`agent-instructions.md`**: voice, rules, when to hand off.
- **`keywords.json`**: comment keywords and their first replies.

**Stock and prices come only from the warehouse sheet** (TRIANGLERESELLS WAREHOUSE STOCK, tabs **BOT STOCK** and **BOT PRICES**). Change a Qty or price there and the bot picks it up within 2 minutes. Only rows marked FOR SALE are sold; FREEBIE rows (Baccarat, G-Shock) are added free; NOT FOR SALE rows and rows with a CONFIRM note or no price go to Josh.

## Setup

### 1. Instagram account
- The account must be a **professional (Business or Creator)** account.
- In the Instagram app: **Settings → Messages and story replies → Message controls → Connected tools → turn on "Allow access to messages."**

### 2. Meta app
1. Go to [developers.facebook.com](https://developers.facebook.com), create an app, and pick the use case **Manage messaging & content on Instagram**.
2. Open **Instagram → API setup with Instagram login**.
3. Under **Generate access tokens**, add @triangleresells and copy the token → `IG_ACCESS_TOKEN`.
4. Copy the **Instagram app secret** shown on that page → `IG_APP_SECRET`.
5. Make up any random password-like string → `IG_VERIFY_TOKEN`.

### 3. Claude API key
Create one at [console.anthropic.com](https://console.anthropic.com) → `ANTHROPIC_API_KEY`. This is billed separately from a Claude.ai subscription. DMs on Haiku cost very little per conversation.

### 4. Deploy (Render)
1. On [render.com](https://render.com), choose **New → Blueprint**, connect GitHub, and pick this repo. It reads `render.yaml`.
2. Paste in the secrets from steps 2–3.
3. Use a paid instance (Starter). Free instances fall asleep and miss DMs.
4. Copy your URL, for example `https://triangle-ai-dm.onrender.com`.

### 5. Warehouse sheet (Google service account, sheet stays private)
Never publish the sheet to the web. The bot reads it with a Google service account that only has Viewer access.
1. [console.cloud.google.com](https://console.cloud.google.com) → create a project (e.g. `triangle-dm-bot`).
2. **APIs & Services → Library → Google Sheets API → Enable.**
3. **IAM & Admin → Service Accounts → Create service account** (name `triangle-dm-bot`, no roles needed) → Done.
4. Open it → **Keys → Add key → Create new key → JSON**. A `.json` file downloads. Keep it out of this repo.
5. Copy its `client_email` (like `triangle-dm-bot@PROJECT.iam.gserviceaccount.com`). In the sheet: **Share** → paste that email → **Viewer** → uncheck "Notify" → Share.
6. On Render, paste the whole JSON file into `GOOGLE_SERVICE_ACCOUNT_JSON`. Check `https://YOUR-URL/health`: `"stock": "sheet"` means it's reading the live sheet; `"snapshot"` means it isn't (the logs say why).

### 6. Optional: handoff alerts
Create a Discord channel webhook (Channel settings → Integrations → Webhooks) or a Slack incoming webhook → `HANDOFF_WEBHOOK_URL`. Without it, alerts only show in the server logs.

### 6b. Payments
**Right now: no Stripe.** Buyers pay cash, Cash App or Apple Pay. The bot quotes (never its own math), sends the order summary, then locks in the order and hands it to Josh to collect payment (the chat pauses so Josh can take over).

Stripe links (off unless `STRIPE_ENABLED=true`):
1. Stripe Dashboard → Developers → API keys → **Create restricted key** with **Checkout Sessions: Write** → `STRIPE_SECRET_KEY`.
2. Developers → Webhooks → **Add endpoint** `https://YOUR-URL/stripe/webhook`, event **checkout.session.completed** → copy the signing secret → `STRIPE_WEBHOOK_SECRET`.
3. Set `WAREHOUSE_ADDRESS` to the storage lot, no unit number (e.g. `Ample Storage, 1260 Partin Rd, Raleigh, NC 27610`). Buyers get it only after they pay, told to meet in the parking lot.

When an order is paid, the bot DMs the buyer "paid ✅", adds a Google Calendar event, and alerts the team to log the sale and update the stock sheet.

### 6c. Google Calendar (paid orders)
Buyers can pay today and pick up a later day. Each paid order becomes an event on its pickup or ship day with the time, location, items and buyer.
1. Go to [script.google.com](https://script.google.com) signed in to the calendar's Google account → New project → paste `scripts/google-calendar.gs`.
2. Deploy → New deployment → **Web app**, Execute as **Me**, access **Anyone** → copy the URL → `CALENDAR_WEBHOOK_URL`.

**Blocking pickup times:** pickups are 10 AM to 10 PM, 30 minutes each. The bot reads this same calendar and never offers a time that overlaps an event. To block a time, add an event to the calendar. To close a whole day, add an all-day event with "closed" in the title. Paid pickups block their own slot automatically.

### 6d. Customer list and restock blasts
The bot saves every chat, pending follow-up and customer (username, what they wanted, what they bought) to a small database file on Render's disk (`render.yaml` sets it up), so a redeploy doesn't wipe anything.
1. Make up a long random password → `ADMIN_KEY` on Render.
2. Open `https://YOUR-URL/admin?key=YOUR_ADMIN_KEY` on your phone (bookmark it).
3. **Download everyone** gives you a spreadsheet. **Restock blast**: type words like "essentials hoodie" and your message, then hit Send.
   - Instagram only lets the bot DM people who messaged in the last 24 hours. The bot sends to those people. Everyone else is listed with a tap-to-DM link so you can message them yourself from the app.

### 7. Connect the webhook
In the Meta app: **Instagram → API setup with Instagram login → Configure webhooks**
- Callback URL: `https://YOUR-URL/webhook`
- Verify token: your `IG_VERIFY_TOKEN`
- Subscribe to **messages** and **comments** (and **message_echoes** if it's listed separately, so the bot knows when the team replies).

### 8. Go live
- While the Meta app is in **Development** mode, it only works for accounts added as testers in **App roles**. Test with a friend's account added as a tester, using the test script in the setup doc.
- To answer real customers, switch the app to **Live**. Meta requires **App Review** for `instagram_business_manage_messages` and `instagram_business_manage_comments` (record a short screen video of the bot working). Business verification may also be required.
- **The access token expires after about 60 days.** Refresh it in the Meta dashboard and update `IG_ACCESS_TOKEN` on Render before then.

## Running locally
```bash
cp .env.example .env   # fill it in
npm install
npm run dev
npm test
```
To get Instagram webhooks to your laptop, use a tunnel like `ngrok http 3000` and use that URL in step 7.

## Adding Triangle Scales and Triangle Sales
Deploy a second (and third) copy on Render from the same repo with a different `ACCOUNT_NAME` and that account's `IG_ACCESS_TOKEN`. Their keywords are already in `config/keywords.json`.

## Known limits
- Conversation memory resets when the server restarts or redeploys. The bot still works, it just forgets older context.
- Instagram only lets you message someone within 24 hours of their last message, and only one DM per comment.
- Comments trigger only on the keyword list; regular comments are ignored.
