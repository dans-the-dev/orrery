-- Discord (stage 1 and 2): what the notifier already posted, one-time verification nonces, and wallet links.
create table if not exists discord_posts (
  kind      text        not null,
  key       text        not null,
  posted_at timestamptz not null default now(),
  primary key (kind, key)
);

create table if not exists discord_nonces (
  nonce           text        primary key,
  discord_user_id text        not null,
  expires_at      timestamptz not null,
  used            boolean     not null default false
);

create table if not exists discord_links (
  discord_user_id text        primary key,
  address         text        not null,
  roles           text[]      not null default '{}',
  linked_at       timestamptz not null default now(),
  checked_at      timestamptz not null default now()
);
create index if not exists discord_links_address on discord_links(address);
