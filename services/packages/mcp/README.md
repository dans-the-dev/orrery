# @orrery/mcp

Orrery for MCP clients. Check the agent behind a payment before you serve it, read an agent's policy record, query
signed onchain datasets, and let your own agent pay x402 endpoints from its float within the caps you set.

## Tools

| Tool | Cost | What it does |
| :--- | :--- | :--- |
| `orrery_pricing` | free | Check prices and Orrery Data pack prices |
| `orrery_signer_record`, `orrery_agent_record` | free | Public record of a signer or an ERC-8004 agent |
| `orrery_verify_check` | free | Verifies a signed check: signature, active check signer, validity window |
| `orrery_check_payer`, `orrery_check_agent` | one check | Signed check, verified on chain, with the credits left |
| `orrery_credits` | free | Credits, free checks left this month, data calls left |
| `orrery_data_catalog`, `orrery_data_providers` | free | Official datasets, third-party data providers |
| `orrery_data_query` | one data call | Signed records, verified before they are shown |
| `orrery_data_verify` | free | Verifies a data answer offline |
| `orrery_data_buy_pack` | one pack | Buys data calls in USDG, or in ORRY for 20% less |
| `orrery_allowance` | free | What your agent may still spend today |
| `orrery_ensure_float` | gas | Tops up the signer's float within the session caps |
| `orrery_pay_x402` | the URL's price | Pays an x402 URL from the float |

Paid tools report what is left and say so when it drops under 20% of a pack. A payment above
`ORRERY_MCP_MAX_PAYMENT_USD` (1 USD unless you set it) runs only when the call carries `confirm: true`.

## Setup

```json
{
  "mcpServers": {
    "orrery": {
      "command": "npx",
      "args": ["-y", "@orrery/mcp"],
      "env": {
        "ORRERY_API_KEY": "rc_...",
        "ORRERY_AGENT_KEY_FILE": "/home/you/.config/orrery/agent.key"
      }
    }
  }
}
```

- `ORRERY_API_KEY`: your Orrery API key (from a credit or data pack purchase, or rotated on orrery.tech).
- `ORRERY_API_KEY_FILE`: where a key issued by `orrery_data_buy_pack` is saved, with mode 600.
- `ORRERY_AGENT_KEY_FILE`: your agent's session signer key, in a file only you can read (`chmod 600`). The server refuses
  a file others can read. Agent tools need it; counterparty tools do not.
- `ORRERY_API_URL`, `ORRERY_RPC_URL`, `ORRERY_CHAIN_ID`, `ORRERY_ATTESTOR`, `ORRERY_MODULE`: Orrery on Robinhood
  Chain by default.

Data answers are signed by Orrery's data signer (EIP-712, domain "Orrery Data"); the server checks every answer against
the signer published at `/v1/data/signer` before it returns it.
