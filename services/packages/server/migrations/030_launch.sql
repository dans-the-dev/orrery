-- Lane L5, Agent Launch (docs/updates/L5-LAUNCH-SPEC.md): events of AgentLaunch and SpokeHook and the PoolManager swaps
-- of the spoke pools (one table, cursor 'launch' in indexer_state), and the tables derived from them. Amounts are
-- numeric base units (ORRY and coins: 18 decimals).

create table if not exists launch_events (
  block_number bigint      not null,
  log_index    integer     not null,
  tx_hash      text        not null,
  address      text        not null,
  event        text        not null,
  args         jsonb       not null,
  block_time   timestamptz not null,
  primary key (block_number, log_index)
);
create index if not exists launch_events_event on launch_events(event, address);

create table if not exists launch_coins (
  coin              text        primary key,
  agent_id          numeric     not null unique,
  creator           text        not null,
  pool_id           text        not null unique,
  name              text        not null,
  symbol            text        not null,
  launched_time     timestamptz not null,
  launched_block    bigint      not null,
  launched_tx       text        not null,
  public_open_at    bigint      not null,
  liquidity         numeric     not null,
  pooled            numeric     not null,
  first_buy_orry   numeric     not null default 0,
  first_buy_coins   numeric     not null default 0,
  last_sqrt_price   numeric,
  volume_orry      numeric     not null default 0,
  trades            integer     not null default 0,
  early_buys        integer     not null default 0,
  fees_distributed  numeric     not null default 0,
  creator_fees      numeric     not null default 0,
  earn_fees         numeric     not null default 0,
  owner_fees        numeric     not null default 0,
  burned            numeric     not null default 0,
  creator_claimed   numeric     not null default 0
);
create index if not exists launch_coins_time on launch_coins(launched_time desc);

create table if not exists launch_trades (
  tx_hash    text        not null,
  log_index  integer     not null,
  block_number bigint    not null,
  coin       text        not null,
  kind       text        not null check (kind in ('early', 'buy', 'sell')),
  account    text        not null,
  orry      numeric     not null,
  coins      numeric     not null,
  block_time timestamptz not null,
  primary key (tx_hash, log_index)
);
create index if not exists launch_trades_coin on launch_trades(coin, block_number desc, log_index desc);
