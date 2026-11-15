"use client";

import type { ReactNode } from "react";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import "./launch.css";

/** Frame of every Agent Launch page: site nav, the page, the footer. Reached from the dashboard sidebar (no new top nav
 * entry, board rule). */
export function LaunchShell({ children }: { children: ReactNode }) {
  return (
    <div className="product-page rc-page launch-page">
      <Nav />
      <main className="app-main">{children}</main>
      <Footer />
    </div>
  );
}

/** Where every spoke trade's 1% goes (T6): the product's own figure. */
export function FeeSplit({ label }: { label?: string }) {
  return (
    <figure className="ln-split" aria-label="The 1% trade fee, divided: 50% agent account, 20% Earn depositors, 15% burned, 15% Orrery">
      {label ? <figcaption className="ln-split-label">{label}</figcaption> : null}
      <span className="s-agent" style={{ flexBasis: "50%" }} />
      <span className="s-earn" style={{ flexBasis: "20%" }} />
      <span className="s-burn" style={{ flexBasis: "15%" }} />
      <span className="s-owner" style={{ flexBasis: "15%" }} />
      <ol>
        <li><b>50%</b>Agent account</li>
        <li><b>20%</b>Earn</li>
        <li><b>15%</b>Burned</li>
        <li><b>15%</b>Orrery</li>
      </ol>
    </figure>
  );
}
