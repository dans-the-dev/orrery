"use client";

import { useAccountChain, useWallet } from "@/lib/orry/chain";
import { hasFees, hasShares, useEarnPositions } from "@/lib/orry/earn";

/**
 * Where this wallet's ORRY position lives, for the nav while every ORRY page is held: withdrawals, unstake, claims
 * and positions are never held, so a wallet that holds something can always reach them.
 */
export function usePositionHref(active = true): string | undefined {
  const { address } = useWallet();
  // Reads only when the nav needs it (every ORRY page held).
  const me = useAccountChain(active ? address : undefined);
  const { positions } = useEarnPositions(active ? address : undefined);
  if (!address || !active) return undefined;
  const has = (v?: bigint) => (v ?? 0n) > 0n;
  if (positions.some(hasFees) || has(me.rewardsEth) || has(me.rewardsOrry)) return "/claim";
  if (positions.some(hasShares)) return "/earn";
  if (has(me.stakeActive) || has(me.stakeLeaving)) return "/stake";
  return undefined;
}
