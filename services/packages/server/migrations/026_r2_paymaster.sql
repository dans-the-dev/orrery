-- Lane L3, the ORRY paymaster (utility 12, docs/updates/L3-R2-SPEC.md section 5): prepaid ORRY per smart account and
-- every operation charged, per paymaster (one per EntryPoint).

create table if not exists paymaster_accounts (
  paymaster text    not null,
  account   text    not null,
  deposited numeric not null default 0,
  withdrawn numeric not null default 0,
  charged   numeric not null default 0,
  ops       integer not null default 0,
  primary key (paymaster, account)
);
create index if not exists paymaster_accounts_account on paymaster_accounts(account);

create table if not exists paymaster_ops (
  paymaster   text        not null,
  tx_hash     text        not null,
  log_index   integer     not null,
  account     text        not null,
  gas_cost    numeric     not null,
  charged     numeric     not null,
  premium     numeric     not null,
  block_time  timestamptz not null,
  primary key (paymaster, tx_hash, log_index)
);
create index if not exists paymaster_ops_account on paymaster_ops(account, block_time desc);
