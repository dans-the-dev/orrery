# Community Chat, Reward Pool and events (proposal)

Date: 2026-11-08 (WIB). Status: proposal for the owner's choices; nothing is built. Relayed by the Orrery session; the
owner picked "Chat + ide tambahan". Owner, quoted: "Community chat yg data chatnya tersimpan dan terbaca onchain bukan
di server jadi tidak bisa di hapus oleh siapapun. jadi untuk mengirim chat pengguna harus menyiapkan ORRY dulu dan
biaya chat tergantung dari harga ORRY/USDG agar lebih adil. dan ORRY yg di kirim akan masuk ke Reward Pool yg
nantinya bisa digunakan untuk community event seperti bug bounty dengan imbalan ORRY, atau event lain ... misalnya
pengguna teraktif dalam 7 hari terakhir di protokol mendapatkan reward berupa 1M ORRY yg event nya bisa di atur dan
dibuat oleh wallet treasury dan nominal rewardnya bisa di ambil dari reward pool. jika sudah dibuat maka ORRY yg
dijadikan reward akan di kunci hingga ada pemenang nya dalam rentang waktu yg di tentukan". Extras approved for the
spec: tips with a cut to the pool, staker-only rooms, on-chain usernames paid in ORRY, weekly quests from the pool,
agent promotion paid in ORRY and burned.

## 1. Design

| Contract | Behaviour |
| :--- | :--- |
| `OrryChat` | `post(room, text, replyTo)` emits `Posted(id, room, author, replyTo, text)`; the text lives in the event log, which every node keeps and nobody can edit or delete; no text in storage (cost). Text at most 1,000 bytes (guess). Fee: `postFeeUsd` (0.01 USD, guess) converted to ORRY at the hub TWAP (R-28) and pulled from the poster, then sent to the Reward Pool (or split with a burn, owner's choice). Rooms: open rooms, and staker rooms whose minimum stake is read from `OrryStaking.earningBalance`. `tip(id, amount)` sends ORRY to the author with a cut (5%, guess) to the pool. `promote(agentId, hours)` pays ORRY (USD priced) that is burned, and the web pins the promoted agent for that time |
| `OrryNames` | one name per address, unique, paid in ORRY at a USD price (1 USD, guess) to the pool; change for the same fee; no expiry |
| `RewardPool` | receives ORRY from chat fees, tip cuts and names. The event admin (the treasury wallet, as the owner said) calls `createEvent(kind, amount, deadline, rulesHash)`, which locks `amount` out of the free balance. Winners are set by `publishWinners(id, winners, amounts)` before the deadline; payout opens after a public check window, during which the admin may replace the list once to fix a mistake. With no winners by the deadline, `expire(id)` returns the locked amount to the pool, never to the treasury. Nothing else can move pool ORRY. Bug bounties, the "most active in 7 days" event and weekly quests all use this one engine; `rulesHash` commits to the event's rules at creation |

Activity events: the indexer computes the ranking from chain data with the rules committed in `rulesHash`, publishes
the list and the data behind it, and the admin publishes the winners on chain; anyone can recompute it during the
check window.

## 2. Facts and limits

- An event log is on chain and readable by anyone through a node; the indexer is only a cache that anyone can rebuild.
- Undeletable also covers spam and unlawful content. The chain keeps everything either way; what a site renders is its
  own choice.
- "Most active" counted in transactions is cheap to farm with many wallets; counted in protocol fees paid it costs the
  farmer real fees.
- Gas per message: to be measured on 4663 (L2 execution plus L1 data); the text length bound keeps it small.

## 3. Choices for the owner

Asked in the orchestrating session; answers recorded in `docs/ORRY-BUILD-SPEC.md` section 1.

## 4. Invariants (draft)

- C-1 A message is only an event; no function edits or deletes one; each post pays exactly the fee at the TWAP price.
- C-2 Pool ORRY leaves only as a payout to published winners of an event after its check window, or stays in the
  pool; the free balance plus locked amounts equals the pool's ORRY balance.
- C-3 An event's locked amount is paid out in full to its winners, or returns to the free balance after expiry.
- C-4 Only the event admin creates events and publishes winners; it cannot withdraw pool ORRY any other way.
- C-5 Staker rooms accept a post only when the poster's earning stake is at least the room's minimum at that moment.
- C-6 Names are unique; a name fee and a tip cut reach the pool exactly; promotion fees are burned exactly.

## 5. Missions and Achievement Board (owner, 2026-11-08)

Relayed by the Orrery session: the owner approved the missions list ("A teruskan") and asked for an Achievement Board
every user can reach, funded from the Reward Pool, quoted: "dari reward pool tapi tambahkan batasan berapa banyak user
yg bisa claim. dan jumlahnya langsung dihitung misalnya 1K ORRY untuk 1000 orang jika misi mudah, dan daftar penerima
akan tampil di leaderboard berdasarkan waktu tercepat. semakin sulit maka semakin banyak hadiah dan semakin sedikit
penerima nya"; asset "Bisa dipilih per achievement". Decisions R-40 to R-43.

Missions (event kinds on the R-33 engine; measured by fees, locked value or time held, never transaction count):
Earn (hold a position of at least X for 7 days without withdrawing; highest time-weighted position; first deposit in
the period held to the end), Stake (no unstake request in the period; move up a fee tier; largest stake behind one
verified agent), Agents (register, set caps and complete verification; caps active 7 days without pause or revoke; most
x402 USDG paid by a verified agent; most paid signed checks as a merchant), Markets (top fees in Dark Pool, Private Swap
or Stocks; most fees paid in ORRY; traded on 3 venues; prediction accuracy with a minimum count in R2), Burn (largest
ORRY burned through products; a small reward per recorded `distribute` run), Chat (most ORRY tips received; tiered bug
bounty; best guide chosen by the treasury wallet), Seasonal (most active 7 days by fees, R-34; 7 day streak of paid
activity). No raffle (R-43). Fairness: at most one prize per wallet per event; rules committed in `rulesHash` exclude
fresh or circularly funded wallets.

Achievement Board (contract `OrryAchievements`, beside `RewardPool`):

| Rule | Behaviour |
| :--- | :--- |
| Creation | The treasury wallet creates an achievement with `asset`, `rewardPerUser`, `maxRecipients`, `deadline`, `kind`, `rulesHash`; `rewardPerUser × maxRecipients` is locked from the pool's free balance of that asset at creation, at most 25% of it (as R-33). An asset the pool does not hold cannot be used (R-42, the page shows it as Coming soon) |
| Completion | On-chain kinds (R-41): `claim(id)` checks the condition through a verifier contract (for example stake or lock at least X since a time, agent verified) and pays at once. Listed kinds: the treasury wallet publishes completers with completion times; after the 48 hour check window each listed address can `claim(id)` |
| Order and cap | First come, first served by completion time (on-chain: the claim's block; listed: the published time); payouts stop at `maxRecipients`; one claim per address per achievement |
| Leftover | At the deadline, unclaimed slots return to the pool's free balance, never to the treasury |
| Display | Reward per person and the recipients' leaderboard by completion time; no remaining-slot counter (R-40) |
| Lock achievements | "Lock ORRY to earn ETH or another asset" needs an on-chain lock contract and a non-ORRY reward, so it starts as Coming soon (the owner's own words) |

Invariants: A-1 locked = rewardPerUser × maxRecipients at creation, from the free balance of that asset, at most 25%;
A-2 paid ≤ maxRecipients × rewardPerUser and one payout per address; A-3 after the deadline every unpaid slot returns to
the free balance; A-4 an on-chain claim pays only when its verifier condition holds at that block; A-5 a listed claim
pays only after the check window and only to a listed address; A-6 nothing else moves pool assets (C-2 extended per
asset).
