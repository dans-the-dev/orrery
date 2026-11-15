-- Support queue: drafted replies to public Discord questions and X mentions. Answers from the docs and greetings are sent
-- at once (decided_by 'auto'); the rest wait for an Admin or Core Team member in #reply-queue. (source, source_id) makes a
-- message a single item, so nothing is drafted or sent twice; sent_id lets a sent reply be deleted.
create table if not exists support_items (
  id                bigserial   primary key,
  source            text        not null check (source in ('discord', 'x')),
  source_id         text        not null,
  channel_id        text,
  author            text        not null,
  text              text        not null,
  link              text        not null,
  category          text        not null,
  reason            text        not null default '',
  draft             text        not null default '',
  status            text        not null default 'pending' check (status in ('pending', 'sending', 'sent', 'skipped', 'failed', 'deleted')),
  queue_message_id  text        unique,
  decided_by        text,
  decided_at        timestamptz,
  sent_id           text,
  sent_ref          text,
  error             text,
  created_at        timestamptz not null default now(),
  unique (source, source_id)
);
create index if not exists support_items_created on support_items (created_at);

-- Small key-value state, for example the newest X mention already seen.
create table if not exists support_state (
  key         text        primary key,
  value       text        not null,
  updated_at  timestamptz not null default now()
);
