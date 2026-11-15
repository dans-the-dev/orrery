-- Multi-pair hubs (R-35 to R-38, orry/spec d01fb2c and 6e2c836): one hub per quote token, one Earn vault per hub,
-- claims and earnings per asset. Numbered 010 to leave 004 to 009 to the wave R1 market migrations. A development
-- database indexed by the single-hub build needs a fresh ORRY index (nothing ORRY is deployed).

alter table orry_events drop constraint if exists orry_events_source_check;
alter table orry_events add constraint orry_events_source_check
  check (source in ('hook', 'vault', 'factory', 'staking', 'router', 'treasury', 'buyback', 'pool'));

-- The hook's registry (append-only), in registration order. quote 0x00…00 is native ETH.
create table if not exists orry_hubs (
  position           integer primary key,
  quote              text    not null unique,
  pool_id            text    not null unique,
  usd_feed           text    not null,
  orry_is_currency0 boolean not null
);

-- The vault factory's list (append-only): one Earn vault per quote.
create table if not exists orry_vaults (
  position integer primary key,
  vault    text    not null unique,
  quote    text    not null unique
);

create table if not exists orry_earn_shares (
  address text    not null,
  vault   text    not null,
  shares  numeric not null default 0 check (shares >= 0),
  primary key (address, vault)
);

-- Claimed totals per asset (Earn fees in each vault's quote and ORRY; stake rewards in ETH and ORRY).
create table if not exists orry_claimed (
  address text    not null,
  asset   text    not null,
  amount  numeric not null default 0,
  primary key (address, asset)
);

-- Earned all time per asset for the earners board, written by the snapshot at one block per account.
create table if not exists orry_earned (
  address text    not null,
  asset   text    not null,
  amount  numeric not null default 0,
  primary key (address, asset)
);

alter table orry_accounts
  drop column if exists earn_shares,
  drop column if exists claimed_eth,
  drop column if exists claimed_orry,
  drop column if exists earned_eth,
  drop column if exists earned_orry;

-- Quote price samples as ORRY base units per USDG base unit (num / den): from the ORRY/USDG hub when it has a price,
-- else the ETH hub times an ETH/USDG pool.
alter table orry_price_samples
  add column if not exists ratio_num numeric,
  add column if not exists ratio_den numeric;
delete from orry_price_samples where ratio_num is null;
