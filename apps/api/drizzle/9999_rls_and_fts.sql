-- Hand-written SQL that drizzle-kit cannot express. Runs after generated migrations
-- (lexical order). Make sure the extensions exist first.
create extension if not exists pgcrypto;
create extension if not exists vector;
create extension if not exists pg_trgm;

-- Generated full-text column + index on messages. 'simple' config: no stemming,
-- works across languages (spec OD14, provisional).
alter table messages drop column if exists fts;
alter table messages
  add column fts tsvector generated always as (to_tsvector('simple', content_text)) stored;
create index if not exists messages_fts_idx on messages using gin (fts);
create index if not exists conversations_title_trgm_idx on conversations using gin (title gin_trgm_ops);

-- Seed provider registry.
insert into providers (id, display_name) values
  ('chatgpt', 'ChatGPT'), ('claude', 'Claude'), ('gemini', 'Gemini'), ('perplexity', 'Perplexity')
on conflict (id) do nothing;

-- Row-Level Security: a row is visible only if user_id matches the per-transaction variable.
do $$
declare t text;
begin
  foreach t in array array['provider_accounts','conversations','messages','attachments'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists user_isolation on %I', t);
    execute format(
      'create policy user_isolation on %I using (user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid) with check (user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid)',
      t);
  end loop;
end $$;

-- Limited role that RLS is actually enforced against. The connection role (e.g. Neon's
-- neondb_owner) may carry BYPASSRLS; withUser() does `SET LOCAL ROLE aimanager_app`
-- per transaction so policies apply without a second credential.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'aimanager_app') then
    create role aimanager_app nologin nobypassrls;
  end if;
end $$;
grant usage on schema public to aimanager_app;
grant select, insert, update, delete on all tables in schema public to aimanager_app;
grant usage on all sequences in schema public to aimanager_app;
-- Registry table is read-only for the app role.
revoke insert, update, delete on providers from aimanager_app;
-- Make sure the connecting role may SET ROLE to it.
do $$
begin
  execute format('grant aimanager_app to %I', current_user);
exception when others then
  raise notice 'grant aimanager_app skipped: %', sqlerrm;
end $$;
