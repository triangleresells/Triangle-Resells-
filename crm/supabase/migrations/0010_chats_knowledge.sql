-- Chats + Knowledge for the team's phone CRM (triangle-crm-q08b): every Instagram DM the bot sees or sends, and a
-- learning loop (a question the bot couldn't answer + the team's reply in the chat = a proposed answer; the team
-- approves it and the bot uses it from then on). The bot writes with the service key; team logins can only read,
-- and change things through the two functions below.

create table if not exists conversations (
  id text primary key,                         -- the buyer's Instagram user id
  business_id uuid not null default '7a1a0000-0000-4000-8000-000000000001',
  ig_user_id text not null,
  ig_handle text,
  last_message_at timestamptz not null default now(),
  needs_human boolean not null default false,  -- the bot handed the chat to the team
  bot_silent boolean not null default false,   -- a team member tapped "Take over": the bot stays quiet until released
  silenced_by text,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists conversations_last_idx on conversations (last_message_at desc);

create table if not exists messages (
  id bigserial primary key,
  business_id uuid not null default '7a1a0000-0000-4000-8000-000000000001',
  conversation_id text not null references conversations (id) on delete cascade,
  role text not null check (role in ('customer', 'bot', 'agent')),  -- agent = a team member typing in Instagram
  text text not null,
  ig_mid text unique,
  is_test boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists messages_conversation_idx on messages (conversation_id, created_at);

create table if not exists knowledge_base (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default '7a1a0000-0000-4000-8000-000000000001',
  question text not null,
  answer text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  source_conversation_id text references conversations (id) on delete set null,
  reviewed_by text,
  reviewed_at timestamptz,
  is_test boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists knowledge_status_idx on knowledge_base (status, created_at desc);

alter table conversations enable row level security;
alter table messages enable row level security;
alter table knowledge_base enable row level security;
drop policy if exists team_read on conversations;
drop policy if exists team_read on messages;
drop policy if exists team_read on knowledge_base;
create policy team_read on conversations for select to authenticated using (is_team());
create policy team_read on messages for select to authenticated using (is_team());
create policy team_read on knowledge_base for select to authenticated using (is_team());
grant select on conversations, messages, knowledge_base to authenticated;
grant all on conversations, messages, knowledge_base to service_role;
grant usage, select on sequence messages_id_seq to service_role;

-- "Take over (silence bot)" / "Release to bot" in the Chats tab.
create or replace function app_conversation_silence(p_id text, p_silent boolean) returns void
language plpgsql security definer set search_path = public as $$
declare who text;
begin
  select name into who from team_members where user_id = auth.uid();
  if who is null then raise exception 'not a team member' using errcode = '42501'; end if;
  update conversations set bot_silent = p_silent, silenced_by = case when p_silent then who end,
         needs_human = case when p_silent then needs_human else false end, updated_at = now()
   where id = p_id;
  if not found then raise exception 'chat not found' using errcode = 'P0002'; end if;
end $$;

-- Approve / Reject in the Knowledge tab. The bot only uses approved answers.
create or replace function app_knowledge_review(p_id uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare who text;
begin
  select name into who from team_members where user_id = auth.uid();
  if who is null then raise exception 'not a team member' using errcode = '42501'; end if;
  if p_status not in ('approved', 'rejected', 'pending') then raise exception 'bad status' using errcode = '22023'; end if;
  update knowledge_base set status = p_status, reviewed_by = who, reviewed_at = now() where id = p_id;
  if not found then raise exception 'entry not found' using errcode = 'P0002'; end if;
end $$;

revoke all on function app_conversation_silence(text, boolean), app_knowledge_review(uuid, text) from public, anon;
grant execute on function app_conversation_silence(text, boolean), app_knowledge_review(uuid, text) to authenticated;
