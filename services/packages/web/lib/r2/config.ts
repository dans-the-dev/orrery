import type { RcoreFeature } from "../rcore/config";

/** Lane L3 pages (docs/updates/L3-R2-SPEC.md section 7). Each opens with its release switch feature. */
export const R2_ROUTES: { feature: Extract<RcoreFeature, "predict" | "limit-orders" | "shield" | "paymaster">; href: string; label: string }[] = [
  { feature: "predict", href: "/predict", label: "Predict" },
  { feature: "limit-orders", href: "/limit-orders", label: "Limit orders" },
  { feature: "shield", href: "/shield", label: "Shield" },
  { feature: "paymaster", href: "/gas", label: "Gas in RCORE" },
];

/** Burn sources added by lane L3, for the burn page. */
export const R2_BURN_SOURCES: Record<number, string> = {
  30: "Prediction markets created",
  31: "Prediction fees paid in RCORE",
  32: "Limit order fees paid in RCORE",
  33: "Gas premium paid in RCORE",
};

/** Tip choices for the keeper that fills a limit order, in basis points of the order's USDG value. */
export const LIMIT_TIPS_BPS = [0, 10, 25, 50] as const;
/** Expiry choices for a limit order, in days (the API accepts at most 30). */
export const LIMIT_EXPIRY_DAYS = [1, 7, 30] as const;
