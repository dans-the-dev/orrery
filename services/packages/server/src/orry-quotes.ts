import { randomBytes } from "node:crypto";
import { getAddress, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  QUOTE_MEDIAN_WINDOW_SECONDS,
  creditsQuoteTypes,
  orryCreditsFor,
  orryUsdForCredits,
  treasuryDomain,
  verificationQuoteTypes,
  type QuotePrice,
  type OrryChecksQuoteResponse,
  type OrryCreditsQuoteResponse,
  type OrryVerificationQuoteResponse,
} from "@orrery/shared";
import type { Chain } from "./chain.js";
import type { Config } from "./config.js";
import type { Sql } from "./db.js";
import { quotePrice, orryForUsd, type Ratio } from "./orry-price.js";

/**
 * Signed ORRY quotes for `OrreryTreasury.burnForCredits` and `verifyWithOrry` (build spec §5, R-9). The quote
 * signer key is its own role (config). Every quote is stored before it is returned, so a `CreditsPaid` grants checks
 * only for a quote this API issued. Expiry is at most 120 seconds after the chain's latest block time.
 */

export type QuoteFailure = { ok: false; status: 503; error: string };

const UNAVAILABLE: Record<string, string> = {
  hub_not_registered: "ORRY checkout opens when the ORRY pool is live. Try again later.",
  no_price: "The ORRY pool has no price yet. Try again later.",
  not_enough_samples: "ORRY prices are still being sampled. Try again in a few minutes.",
};

const priceView = (ratio: Ratio, basis: "spot" | "median", samples: number): QuotePrice => ({
  orryPerUsd: ((1_000_000n * ratio.num) / ratio.den).toString(),
  basis,
  samples,
  windowSeconds: QUOTE_MEDIAN_WINDOW_SECONDS,
});

async function prepare(cfg: Config, chain: Chain, sql: Sql, usd: bigint) {
  // checkout can open at runtime on a server started without a quote key: refuse plainly rather than sign nothing
  if (!cfg.quoteSignerKey) return { ok: false as const, status: 503 as const, error: "Checkout with ORRY is not available right now." };
  const price = await quotePrice(cfg, chain, sql);
  if (!price.ok) return { ok: false as const, status: 503 as const, error: UNAVAILABLE[price.reason]! };
  // The treasury checks `expiry >= block.timestamp`, so the lifetime counts from the chain's clock.
  const block = await chain.public.getBlock();
  const expiry = block.timestamp + BigInt(cfg.orry!.quoteTtlSeconds);
  const orryAmount = orryForUsd(usd, price.ratio);
  const quoteId = toHex(randomBytes(32));
  const signer = privateKeyToAccount(cfg.quoteSignerKey!);
  return { ok: true as const, price, expiry, orryAmount, quoteId, signer, domain: treasuryDomain(cfg.chainId, getAddress(cfg.orry!.treasury)) };
}

export async function quoteCredits(
  cfg: Config,
  chain: Chain,
  sql: Sql,
  buyer: Address,
  packs: number,
): Promise<{ ok: true; body: OrryCreditsQuoteResponse } | QuoteFailure> {
  const usd = BigInt(packs) * cfg.packPrice;
  const p = await prepare(cfg, chain, sql, usd);
  if (!p.ok) return p;
  const message = { buyer, packs, orryAmount: p.orryAmount, quoteId: p.quoteId, expiry: p.expiry };
  await sql`insert into orry_quotes (quote_id, kind, buyer, packs, orry_amount, expiry)
    values (${p.quoteId.toLowerCase()}, 'credits', ${buyer.toLowerCase()}, ${packs}, ${p.orryAmount.toString()}, ${p.expiry.toString()})`;
  const signature = await p.signer.signTypedData({ domain: p.domain, types: creditsQuoteTypes, primaryType: "CreditsQuote", message });
  return {
    ok: true,
    body: {
      kind: "credits",
      quote: { buyer, packs, orryAmount: p.orryAmount.toString(), quoteId: p.quoteId, expiry: Number(p.expiry) },
      credits: orryCreditsFor(packs, cfg.packSize).toString(),
      signature,
      signer: p.signer.address,
      domain: p.domain,
      decimals: 18,
      usdValue: usd.toString(),
      usdDecimals: 6,
      price: priceView(p.price.ratio, p.price.basis, p.price.samples),
    },
  };
}

/**
 * Pay-as-you-go checks (R-44 item 13): `checks` × the standard credits per check, priced at the ORRY pack rate (625
 * credits per 1 USD, rounded up). Signed as a `CreditsQuote` whose `packs` is the number of checks; the credits are
 * stored with the quote and granted from there.
 */
export async function quoteChecks(
  cfg: Config,
  chain: Chain,
  sql: Sql,
  buyer: Address,
  checks: number,
): Promise<{ ok: true; body: OrryChecksQuoteResponse } | QuoteFailure> {
  const credits = BigInt(checks) * BigInt(cfg.pricing.creditsPerCheck);
  const usd = orryUsdForCredits(credits, cfg.packPrice, cfg.packSize);
  const p = await prepare(cfg, chain, sql, usd);
  if (!p.ok) return p;
  const message = { buyer, packs: checks, orryAmount: p.orryAmount, quoteId: p.quoteId, expiry: p.expiry };
  await sql`insert into orry_quotes (quote_id, kind, buyer, packs, credits, orry_amount, expiry)
    values (${p.quoteId.toLowerCase()}, 'checks', ${buyer.toLowerCase()}, ${checks}, ${credits.toString()}, ${p.orryAmount.toString()}, ${p.expiry.toString()})`;
  const signature = await p.signer.signTypedData({ domain: p.domain, types: creditsQuoteTypes, primaryType: "CreditsQuote", message });
  return {
    ok: true,
    body: {
      kind: "checks",
      quote: { buyer, packs: checks, orryAmount: p.orryAmount.toString(), quoteId: p.quoteId, expiry: Number(p.expiry) },
      checks,
      credits: credits.toString(),
      signature,
      signer: p.signer.address,
      domain: p.domain,
      decimals: 18,
      usdValue: usd.toString(),
      usdDecimals: 6,
      price: priceView(p.price.ratio, p.price.basis, p.price.samples),
    },
  };
}

export async function quoteVerification(
  cfg: Config,
  chain: Chain,
  sql: Sql,
  payer: Address,
  agentId: bigint,
): Promise<{ ok: true; body: OrryVerificationQuoteResponse } | QuoteFailure> {
  const usd = cfg.orry!.verificationUsd;
  const p = await prepare(cfg, chain, sql, usd);
  if (!p.ok) return p;
  const message = { payer, agentId, orryAmount: p.orryAmount, quoteId: p.quoteId, expiry: p.expiry };
  await sql`insert into orry_quotes (quote_id, kind, buyer, agent_id, orry_amount, expiry)
    values (${p.quoteId.toLowerCase()}, 'verification', ${payer.toLowerCase()}, ${agentId.toString()}, ${p.orryAmount.toString()}, ${p.expiry.toString()})`;
  const signature = await p.signer.signTypedData({ domain: p.domain, types: verificationQuoteTypes, primaryType: "VerificationQuote", message });
  return {
    ok: true,
    body: {
      kind: "verification",
      quote: { payer, agentId: agentId.toString(), orryAmount: p.orryAmount.toString(), quoteId: p.quoteId as Hex, expiry: Number(p.expiry) },
      signature,
      signer: p.signer.address,
      domain: p.domain,
      decimals: 18,
      usdValue: usd.toString(),
      usdDecimals: 6,
      price: priceView(p.price.ratio, p.price.basis, p.price.samples),
    },
  };
}
