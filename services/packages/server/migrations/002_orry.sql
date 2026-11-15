-- ORRY services schema (docs/ORRY-BUILD-SPEC.md section 5). Amounts are numeric base units.

-- Every event of the ORRY contracts and the hub pool's PoolManager Swap events, at the confirmation depth.
create table if not exists orry_events (
  block_number bigint      not null,
  log_index    integer     not null,
  tx_hash      text        not null,
  address      text        not null,
  source       text        not null check (source in ('hook', 'vault', 'staking', 'router', 'treasury', 'buyback', 'pool')),
  event        text        not null,
  args         jsonb       not null,
  block_time   timestamptz not null,
  primary key (block_number, log_index)
);
create index if not exists orry_events_event_time on orry_events(event, block_time);

-- Earning balance per address, derived from staking events in order.
create table if not exists orry_stakers (
  address       text    primary key,
  plain_active  numeric not null default 0 check (plain_active >= 0),
  plain_leaving numeric not null default 0 check (plain_leaving >= 0),
  agent_active  numeric not null default 0 check (agent_active >= 0)
);
create index if not exists orry_stakers_earning on orry_stakers((plain_active + agent_active));

-- Agent positions keyed as in OrryStaking: (agentId, owner at stake time); one staker at a time.
create table if not exists orry_agent_positions (
  agent_id  numeric not null,
  owner     text    not null,
  staker    text    not null,
  active    numeric not null default 0 check (active >= 0),
  leaving   numeric not null default 0 check (leaving >= 0),
  locked_until bigint not null default 0,
  primary key (agent_id, owner)
);
create index if not exists orry_agent_positions_staker on orry_agent_positions(staker);

-- Per address: Earn shares, claimed totals (events), pending (read from OrryLens by the snapshot job).
create table if not exists orry_accounts (
  address        text        primary key,
  earn_shares    numeric     not null default 0 check (earn_shares >= 0),
  claimed_eth    numeric     not null default 0,
  claimed_orry  numeric     not null default 0,
  pending_eth    numeric     not null default 0,
  pending_orry  numeric     not null default 0,
  snapshot_at    timestamptz,
  dirty          boolean     not null default true
);

-- Hub and USD pool slot0 samples for the 30 minute quote median.
create table if not exists orry_price_samples (
  id            bigserial   primary key,
  sampled_at    timestamptz not null,
  block_number  bigint      not null,
  hub_sqrt      numeric     not null,
  usd_sqrt      numeric     not null
);
create index if not exists orry_price_samples_at on orry_price_samples(sampled_at);

-- Quotes the API signed; a CreditsPaid grants checks only when it matches one of these.
create table if not exists orry_quotes (
  quote_id      text        primary key,
  kind          text        not null check (kind in ('credits', 'verification')),
  buyer         text        not null,
  packs         integer,
  agent_id      numeric,
  orry_amount  numeric     not null,
  expiry        bigint      not null,
  created_at    timestamptz not null default now(),
  used_tx       text
);

-- One row per CreditsPaid quoteId: checks granted once, or recorded as unmatched with 0 checks.
create table if not exists orry_credit_grants (
  quote_id      text        primary key,
  buyer         text        not null,
  packs         integer     not null,
  orry_amount  numeric     not null,
  credits       bigint      not null,
  matched       boolean     not null,
  tx_hash       text        not null,
  block_number  bigint      not null,
  created_at    timestamptz not null default now()
);
