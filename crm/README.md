# Triangle Resells CRM v1

One database (Supabase) for the team and the AI DM bot. Web app on Netlify.

- `supabase/migrations/`: the database. Every write is a Postgres function, so a change and its activity-log line
  are saved together or not at all. Actor = the logged-in team member, or "Bot" for the DM bot.
- `src/api/`: the API the bot calls (`/api/*`, Netlify Function), authenticated with `CRM_BOT_API_KEY`.
- `tests/`: run against a local Postgres (PGlite, no Docker needed): `npm test`.

Env (Netlify, never committed): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CRM_BOT_API_KEY`.
