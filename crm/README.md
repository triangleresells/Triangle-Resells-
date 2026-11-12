# Triangle Resells CRM v1

One database (Supabase) for the team and the AI DM bot. Web app on Netlify.

- `supabase/migrations/`: the database. Every write is a Postgres function, so a change and its activity-log line
  are saved together or not at all. Actor = the logged-in team member, or "Bot" for the DM bot.
- `src/api/`: the API the bot calls (`/api/*`, Netlify Function), authenticated with `CRM_BOT_API_KEY`.
- `tests/`: run against a local Postgres (PGlite, no Docker needed): `npm test`.

Env (Netlify, never committed): `SUPABASE_URL`, `SUPABASE_ANON_KEY` (public), `SUPABASE_SERVICE_ROLE_KEY`, `CRM_BOT_API_KEY`,
`BOT_ASSISTANT_URL` (the bot's Render address, for the Assistant tab).

Tabs: Calendar, Assistant (chat that acts as you), Money, Stock, Customers, Cash.
