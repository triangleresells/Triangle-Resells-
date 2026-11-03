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

- **`knowledge-base.md`**: prices, shipping, payment, restock dates. **Update restock dates every week.**
- **`agent-instructions.md`**: voice, rules, when to hand off.
- **`keywords.json`**: comment keywords and their first replies.

For prices and stock that change daily, use a Google Sheet instead (step 5 below).

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

### 5. Optional: live inventory sheet
1. Make a Google Sheet with whatever columns you want. A good layout: `Item | Brand | Category | Price | Sizes | In stock | Restock date | Notes`.
2. **File → Share → Publish to web**, choose the sheet, pick **CSV**, then publish and copy the link → `INVENTORY_SHEET_CSV_URL`.
3. The team edits the sheet and the bot picks up changes within 5 minutes. It trusts the sheet over the knowledge base.

### 6. Optional: handoff alerts
Create a Discord channel webhook (Channel settings → Integrations → Webhooks) or a Slack incoming webhook → `HANDOFF_WEBHOOK_URL`. Without it, alerts only show in the server logs.

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
