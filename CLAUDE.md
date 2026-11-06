# Triangle AI DM Agent

AI that answers Instagram DMs for Triangle Resells (@triangleresells), DMs people who comment keywords, and hands chats to the team. Owner: Josh. Built from the "Triangle AI DM Agent Setup" Claude Doc.

## How it works
Instagram → Meta webhook → `POST /webhook` (signature checked) → `src/bot.ts`:
- **DM**: bare keyword ("price") → canned keyword reply. Anything else → Claude (`src/ai.ts`) with the agent instructions + knowledge base + optional live Google Sheet.
- **Comment with a keyword** → one private-reply DM (Instagram allows one per comment, within 7 days) + a public "Sent you a DM!" reply.
- **Handoff**: Claude calls the `handoff_to_team` tool → bot pauses in that chat for `HUMAN_PAUSE_MINUTES` (720 = 12 hours in render.yaml; `HUMAN_PAUSE_HOURS` if minutes isn't set) and posts to `HANDOFF_WEBHOOK_URL` (Discord/Slack).
- **Team typed in the inbox** (an echo the bot didn't send) → bot pauses in that chat.
- Quick back-to-back texts are debounced (4s) into one reply.

## Where to change things (no code needed)
- `config/agent-instructions.md`: voice, flow, rules, handoff cases. `{{ACCOUNT_NAME}}` and `{{VENDOR_SITE_URL}}` are filled from env.
- `config/knowledge-base.md`: the only facts the bot knows. Update restock dates weekly.
- `config/keywords.json`: comment/DM keyword triggers, per account. Only rows matching `ACCOUNT_NAME` load.
- Live prices/stock: a Google Sheet published as CSV (`INVENTORY_SHEET_CSV_URL`). Any columns; it overrides the knowledge base when they disagree.

## Commands
- `npm run dev`: run locally with reload (needs `.env`, see `.env.example`)
- `npm test`: vitest suite, no network or API keys needed
- `npm run typecheck`, `npm run build`, `npm start`

## Rules for working in this repo
- Never commit `.env`, tokens, or API keys. Secrets live in the host's env settings.
- Use only Meta's official Instagram API (graph.instagram.com, Instagram Login). No scraping, no logging in with passwords.
- The bot must never invent prices, stock, restock dates, shipping times, or discounts, and never promise income. Keep those rules in `agent-instructions.md` when editing it.
- DMs are plain text, max 1,000 chars per message (`splitMessage` handles longer).
- Conversation state, pending follow-ups and the customer list live in `src/store.ts` and are saved to one JSON file (`STATE_FILE`, on Render's disk at `/var/data`) by `src/persist.ts`. Never commit that file (it's customer data; `data/` is gitignored). Restock blasts only DM people who messaged in the last 24 hours (Instagram's rule).
- Run `npm test` and `npm run typecheck` before committing. Add a test in `tests/bot.test.ts` for new behavior.
- Expanding to Triangle Scales / Triangle Sales: deploy another copy with a different `ACCOUNT_NAME` and that account's token.
