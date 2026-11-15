# Orrery Data (proposal with owner decisions)

Date: 2026-11-09 (WIB). Status: decided, not built. Relayed by the Orrery session, owner quoted: "jadi semua orang bisa
post datanya sendiri? bisa kamu carikan data publik yg bisa kita sediakan? kita yg menjadi provider nya di awal untuk
mengisi pasar awal, untuk resmi dari kita data data yg bisa di ambil jika bisa event terbaru, data onchain setiap event
untuk di verifikasi, data komunitas dll yg ada di sistem kita sebagai starter". Decisions R-49 to R-52.

## 1. What it is

A data market for agents on Orrery's own x402 facilitator (U6) and the merchant directory (utility 6): anyone lists
an x402 endpoint; agents pay per call within their Orrery caps. Orrery is the first, official provider. Source rule:
only chain-derived data or data from Orrery's own system; no resale of third-party APIs (CoinGecko and Open-Meteo
terms forbid it); Chainlink feed state (open, closed, stale) is derived data, raw answers are not redistributed until
Chainlink's terms are checked.

## 2. Official datasets (R-49)

| # | Dataset | Source | Wave |
| :-- | :--- | :--- | :--- |
| 1 | Agents: new ERC-8004 agents, verifications, endpoint probe history, policy changes, queued cap increases | chain + Orrery prober | D1 |
| 2 | Agent economy: x402 volume per agent and merchant, top merchants, daily trend | facilitator settlements | D1 |
| 3 | Stock corporate actions on 4663: multiplier changes, issuer pause and block events, feed open or closed state | chain | D1 |
| 4 | Stock liquidity: the stock/USDG v4 pools' depth and spread to the oracle | chain | D1 |
| 5 | Pons launches: new tokens, curve progress, graduations | chain | D1 |
| 6 | ORRY economy: TWAP, fees, burns, stake, leaderboard | chain + indexer | D1 |
| 7 | Chain health: block rate, gas, lag | chain | D1 |
| 8 | Orrery market results (Dark Pool clearing prices, volume per stock) | R1 contracts | D2 (with R1) |
| 9 | Community: chat, events, achievement winners, bug bounty | C1 contracts | D2 (with C1) |

Every record carries its source block and transaction hash; every response is EIP-712 signed by the data-signer key
(R-52) and verifiable in the SDK; access through the MCP server as well.

## 3. Payment (R-50)

Official data is paid in ORRY only, priced in USD at the hub TWAP (0.001 USD per call, guess, a config value), through
the facilitator with Permit2 (utility 11). The payee is `DataFeeSplitter`: anyone calls `split()`, which burns 70% of
its ORRY (`Burned(7, amount)`) and sends 30% to the Reward Pool for missions. The pool address is set once by the
treasury owner (48 hour delay); until then the 30% waits in the splitter and nothing else can move it. Staker discounts
apply as everywhere (USD tiers).

## 4. Third-party providers (R-51)

Open listing: a provider stakes ORRY worth a USD minimum (the merchant badge, utility 6) and lists its endpoint; the
facilitator takes 1% of each payment as Orrery revenue (USDG to the treasury, ORRY burned).

## 5. Waves

D1 with update wave 2 (facilitator, directory, MCP): datasets 1 to 7, the splitter, provider listing, data-signer key.
D2 with R1 and C1: datasets 8 and 9.

## 6. Invariants (draft)

- DA-1 Every served record names a block and transaction that exist on chain and contain the event it describes.
- DA-2 Every response is signed by the data-signer key, never by the check signer (separate key role, R-52).
- DA-3 `split()` burns exactly 70% (rounded down to the burn) and sends the rest to the pool; nothing else moves the
  splitter's ORRY; the pool address is set once.
- DA-4 No dataset contains third-party API data; the source list is in the code and the docs.
