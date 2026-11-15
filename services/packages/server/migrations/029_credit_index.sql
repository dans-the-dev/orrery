-- Lane L4: read paths of the API and the epoch job.
create index if not exists attester_results_epoch on attester_results (epoch, agent_id);
create index if not exists attester_results_staker on attester_results (staker, epoch);
create index if not exists credit_events_address on credit_events (address, block_number);
create index if not exists credit_lines_agent on credit_lines (agent_id);
create index if not exists credit_lenders_lender on credit_lenders (lender);
create index if not exists credit_lines_router on credit_lines (router);
