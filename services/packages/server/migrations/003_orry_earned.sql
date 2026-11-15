-- Earned all time = claimed plus pending, both measured at one block: the block the derived tables are complete through.
-- Pairing claimed totals indexed to one block with pending read at another left a fresh claim in neither term.

-- Highest block the ORRY indexer has applied. A re-index moves indexer_state back, never this: the derived totals already
-- hold every event up to it, so this is the block they are complete through until the cursor passes it again.
create table if not exists orry_height (
  id         boolean primary key default true check (id),
  high_block bigint  not null
);

-- The earners leaderboard reads these, written by the snapshot job at one block per account.
alter table orry_accounts
  add column if not exists earned_eth   numeric not null default 0,
  add column if not exists earned_orry numeric not null default 0,
  add column if not exists earned_block bigint,
  drop column if exists pending_eth,
  drop column if exists pending_orry;
