# ORRY pairs beyond ETH (proposal)

Date: 2026-11-08 (WIB). Status: proposal for the owner's choices; nothing is built. Relayed by the Orrery session,
owner quoted: "apakah bisa kita mendukung pair lain selain eth? misalnya solana, hype dll", and the owner answered "A"
(forward now) to the Orrery session's outline: several ORRY/X hub pools on one hook, ORRY/ETH and ORRY/USDG first,
SOL, HYPE and others only once an official bridged token with depth and a price feed exists on 4663.

## 1. Facts on 4663 (2026-11-08)

- Chainlink feeds on 4663 (`https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json`, 62 feeds): crypto
  feeds are BTC, BTC.B, cbBTC, LBTC, WBTC, ETH, LINK, USDC, USDT, wstETH, weETH, syrupUSDC (each 24 h heartbeat, 0.5%);
  the rest are equities. There is no SOL or HYPE feed.
- Bridged SOL or HYPE tokens: see section 5 (scan of every Uniswap v4 pool's currencies).
- `OrreryHook` is not deployed; its oracle (R-28) is merged in `orry/integration`. The hook is immutable once
  deployed, so multi-pair support has to be in it before the ORRY deployment.

## 2. Design

| Part | Today (single hub) | Multi-pair |
| :--- | :--- | :--- |
| Hook | accepts one key (ETH/ORRY) | a registry of hubs, one per quote token X (ORRY/X, fee 0.85% + 0.15%, spacing 200); same-block guard and price observations kept per hub |
| Adding a pair | not possible | `proposePair(X, feed)` by the pair admin (the treasury owner key, one wallet), `executePair(X)` after a delay and within 7 days; at most a fixed number of pairs; X must have a Chainlink USD feed that answers; nothing can change or remove a pair, its fee or its vault |
| Earn | one vault | one `EarnVault` per hub, created by a factory once the pair is registered; LPs choose the pair; `ClaimAll` and the lens read the factory's list |
| Hub fees | ETH and ORRY to the router | per hub, X and ORRY to the router; ORRY: half to stakers, half burned (unchanged); ETH: unchanged; any other X: to the buyback, which buys ORRY in the ORRY/X hub (one hop, half-fee cap, same-block guard), half to stakers and half burned |
| Treasury buyback | USDG to ETH (hop 1 pools) then ETH to ORRY | with an ORRY/USDG hub: USDG to ORRY in one hop, which removes hop 1 and its manipulation finding (F-1); the ETH path stays for when the USDG hub is shallow |
| ORRY price (R-28 TWAP) | ETH hub mean tick times Chainlink ETH/USD | the USDG hub's mean tick directly once it has 30 minutes of history; the ETH path otherwise |
| Services and web | one hub | hubs listed from the hook; Earn page with one card per pair |

Admin power added: the pair admin may only propose and execute new pairs, under the delay and the cap. It has no power
over deposits, swaps, fees or existing pairs (R-10).

Cost: every ORRY contract except staking and the treasury changes (hook, vault, ClaimAll, lens, router, buyback), plus
services, web and the deploy script. The ORRY deployment waits for that work, its tests and its mutation runs.

## 3. Choices for the owner

Asked in the orchestrating session; answers recorded in `docs/ORRY-BUILD-SPEC.md` section 1.

## 4. Invariants this adds (draft)

- P-1 Only registered pairs can be initialized through the hook; a pair is registered only by `executePair` after its
  delay and within its window; the number of pairs never exceeds the cap.
- P-2 No function changes or removes a registered pair, its fee or its vault.
- P-3 Each hub's same-block guard and observations depend only on that hub's swaps (H-5 to H-8 per hub).
- P-4 Fees collected from hub X reach the router as X and ORRY, exactly the claims (H-3 per hub).
- P-5 Every non-ETH, non-ORRY token the router receives ends as ORRY bought in its own hub, half to stakers and half
  burned; nothing else can move it.
- P-6 One Earn vault per hub; a vault only ever holds its own hub's position (E-1 to E-6 per vault).

## 5. Scan of bridged tokens

`Initialize` events of the 4663 PoolManager up to block 109,181,237: 1,134,360 pools over 716,782 distinct tokens,
mostly launchpad coins. Reading every symbol was not done; it is not needed for the decision, since R-36 and R-38 admit a
pair only with a Chainlink feed on 4663, and there is no SOL or HYPE feed.

## 6. Owner answers (2026-11-08)

R-35 ETH and USDG pairs at launch; R-36 new pairs by the treasury wallet after 48 hours, at most 8, feed required;
R-37 other-pair fees turned into ORRY (half to stakers, half burned); R-38 SOL and HYPE wait for an official feed.
