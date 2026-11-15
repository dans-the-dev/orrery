-- Pay-as-you-go checks (R-44 item 13): a quote for a number of checks paid in ORRY through the same
-- `OrreryTreasury.burnForCredits` as a pack. The contract's `packs` carries the number of checks, so the credits to grant
-- are fixed in the stored quote at quote time and granted from there, never recomputed from the event.
alter table orry_quotes drop constraint if exists orry_quotes_kind_check;
alter table orry_quotes add constraint orry_quotes_kind_check check (kind in ('credits', 'verification', 'checks'));
alter table orry_quotes add column if not exists credits bigint;

alter table orry_credit_grants add column if not exists kind text not null default 'credits' check (kind in ('credits', 'checks'));
