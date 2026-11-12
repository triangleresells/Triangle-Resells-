# Triangle AI DM Agent

AI that answers Instagram DMs for Triangle Resells (@triangleresells), DMs people who comment keywords, and hands chats to the team. Owner: Josh. Built from the "Triangle AI DM Agent Setup" Claude Doc.

## How it works
Instagram → Meta webhook → `POST /webhook` (signature checked) → `src/bot.ts`:
- **DM**: bare keyword ("price") → canned keyword reply. Anything else → Claude (`src/ai.ts`) with the agent instructions + knowledge base + optional live Google Sheet.
- **Comment with a keyword** → one private-reply DM (Instagram allows one per comment, within 7 days) + a public "Sent you a DM!" reply.
- **Handoff**: Claude calls the `handoff_to_team` tool → bot pauses in that chat for `HUMAN_PAUSE_MINUTES` (720 = 12 hours in render.yaml; `HUMAN_PAUSE_HOURS` if minutes isn't set) and posts to `HANDOFF_WEBHOOK_URL` (Discord/Slack).
- **Team typed in the inbox** (an echo the bot didn't send) → bot pauses in that chat.
- Reply timing (`ReplyTiming` in `src/bot.ts`): waits a random 42-58s on a cold DM (first message, or they were gone 1+ min), 8-18s in a live back-and-forth, and shows "typing..." before answering. A burst of texts gets one reply. `HUMAN_REPLY_DELAY=false` falls back to the old 4s debounce.
- Orders (`src/desk.ts`, `OrderDesk`): stock only comes off BOT STOCK once an order is PAID. `submit_order` (cash, Cash App, Zelle) → BOOKED label (`stockOff: false`), calendar event, alert to Josh, and the bot sends the Cash App/Zelle info (`PAY_CASHAPP`, `PAY_ZELLE`). Stripe paid (card/Apple Pay) → stock off (the lines stored in the session metadata), PAID label, logged in the sales tracker. On `/admin` Josh taps Mark paid (stock off, logs the sale), Done (stock off and logs if not yet, clears the label), Cancel (stock goes back only if it was paid) or "Clear all PAID labels" (end of day; BOOKED ones stay). Unpaid BOOKED orders and open card links hold their pieces from other buyers inside the bot. Instagram's own DM labels can't be set through Meta's API, so the labels live on `/admin`.
- Stripe: one live link per buyer. A changed order (or a switch to Cash App/Zelle/cash) expires the old Checkout Session before a new one is made; if the old one was already paid, no new link and the chat goes to Josh. Each paid session is handled once (`store.firstTime("stripe:<id>")`, saved to disk). Sandbox keys (`sk_test_`) only unless `STRIPE_ALLOW_LIVE=true`; sandbox payments send the DM, calendar event and a `[TEST]` alert but never touch BOT STOCK, labels or the sales tracker.
- Payment rules (enforced in code, `submitOrder` in `src/bot.ts`): cash = pickup only; cash + delivery → handoff to Josh; shipping needs the full address (`ship_to`) and is never cash. "I paid"/screenshots → `payment_sent` alerts Josh; the bot never confirms a payment.
- BOT STOCK is the master stock list. Columns: Category, Brand, Item, Color, Size, Qty, Price List, Status (FOR SALE / FREEBIE / NOT FOR SALE / INCOMING), Notes, Cost. INCOMING rows are shown to the AI but can't be quoted or ordered.

## Where to change things (no code needed)
- `config/agent-instructions.md`: voice, flow, rules, handoff cases. `{{ACCOUNT_NAME}}` and `{{VENDOR_SITE_URL}}` are filled from env.
- `config/knowledge-base.md`: the only facts the bot knows. Update restock dates weekly.
- `config/keywords.json`: comment/DM keyword triggers, per account. Only rows matching `ACCOUNT_NAME` load.
- Stock and prices: ONLY the warehouse sheet's BOT STOCK and BOT PRICES tabs, read with a Google service account (`GOOGLE_SERVICE_ACCOUNT_JSON`, `src/sheet.ts`). Never publish the sheet to the web. `config/stock.csv` and the tables in `config/pricing.json` are a snapshot (`npm run sync-sheet`) used when the sheet can't be read. Parsing and stock/freebie rules: `src/catalog.ts`.
- Payments: cash, Cash App and Zelle through `submit_order`; card/Apple Pay through Stripe links when `STRIPE_ENABLED=true` (off until Stripe ID verification is done).

## Commands
- `npm run dev`: run locally with reload (needs `.env`, see `.env.example`)
- `npm test`: vitest suite, no network or API keys needed
- `npm run typecheck`, `npm run build`, `npm start`
- `npm run sync-sheet`: refresh the snapshot from the sheet (needs the service account key)
- `npm run ai-retest -- 50`: real-AI retest, 50 simulated chats graded by Claude (needs `ANTHROPIC_API_KEY`, costs API credit)
- `npm run e2e-payments`: end-to-end card/Cash App payment run through the real server with signed Stripe webhooks, fake Stripe/Instagram/sheet (no network, no keys)

## Rules for working in this repo
- Never commit `.env`, tokens, API keys or the Google service account JSON. Secrets live in the host's env settings.
- Use only Meta's official Instagram API (graph.instagram.com, Instagram Login). No scraping, no logging in with passwords.
- The bot must never invent prices, stock, restock dates, shipping times, or discounts, and never promise income. Keep those rules in `agent-instructions.md` when editing it.
- DMs are plain text, max 1,000 chars per message (`splitMessage` handles longer).
- Conversation state, pending follow-ups and the customer list live in `src/store.ts` and are saved to one JSON file (`STATE_FILE`, on Render's disk at `/var/data`) by `src/persist.ts`. Never commit that file (it's customer data; `data/` is gitignored). Restock blasts only DM people who messaged in the last 24 hours (Instagram's rule).
- Run `npm test` and `npm run typecheck` before committing. Add a test in `tests/bot.test.ts` for new behavior.
- Expanding to Triangle Scales / Triangle Sales: deploy another copy with a different `ACCOUNT_NAME` and that account's token.
