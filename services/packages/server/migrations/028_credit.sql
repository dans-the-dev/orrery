-- Lane L4: third-party attesters and Orrery Credit (docs/updates/L4-CREDIT-SPEC.md 6). Amounts are base units.

-- Every event of the attester registry, its fee splitter, the Credit factory, its pools and their routers.
create table if not exists credit_events (
  block_number bigint      not null,
  log_index    integer     not null,
  tx_hash      text        not null,
  address      text        not null,
  source       text        not null check (source in ('registry', 'splitter', 'factory', 'pool', 'router')),
  event        text        not null,
  args         jsonb       not null,
  block_time   timestamptz not null,
  primary key (block_number, log_index)
);

-- Forwarded attester results, one row per ResultForwarded (the epoch job compares them per agent).
create table if not exists attester_results (
  block_number       bigint      not null,
  log_index          integer     not null,
  epoch              bigint      not null,
  staker             text        not null,
  agent_id           numeric     not null,
  probe_key          text        not null,
  observed_at        bigint      not null,
  endpoints_live     boolean     not null,
  registration_valid boolean     not null,
  domain_verified    boolean     not null,
  counted            boolean     not null,
  block_time         timestamptz not null,
  primary key (block_number, log_index)
);

-- Pools and the lines opened in them (state is read live; these rows only name the contracts to read).
create table if not exists credit_pools (
  pool          text        primary key,
  pool_index    integer     not null,
  params        jsonb       not null,
  created_block bigint      not null,
  retired       boolean     not null default false
);

create table if not exists credit_lines (
  pool        text    not null,
  agent_id    numeric not null,
  bond_owner  text    not null,
  router      text    not null,
  opened_block bigint not null,
  primary key (pool, agent_id)
);

-- Lenders seen per pool (positions are read live).
create table if not exists credit_lenders (
  pool    text not null,
  lender  text not null,
  primary key (pool, lender)
);
