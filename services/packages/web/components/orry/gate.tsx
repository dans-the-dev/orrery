"use client";

import type { ReactNode } from "react";
import type { OrryFeature } from "@/lib/orry/config";
import { useReleases } from "@/lib/orry/releases";

/**
 * Shows `children` while the feature is open and `held` while it is held, as the runtime release switch says. Until the
 * first answer it shows a short wait, so an open page never flashes "Coming soon" first.
 */
export function FeatureGate({ feature, held, children }: { feature: OrryFeature; held: ReactNode; children: ReactNode }) {
  const r = useReleases();
  if (!r.ready) return <div className="rc-gate-wait" aria-busy="true" aria-label="Loading" />;
  return <>{r.isLive(feature) ? children : held}</>;
}
