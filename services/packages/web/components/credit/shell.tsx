"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { CREDIT_ROUTES } from "@/lib/credit/api";
import { COMING_SOON, SOON_TAG } from "@/lib/orry/config";
import { useReleases } from "@/lib/orry/releases";
import "./credit.css";

/** Second row of navigation across the lane L4 pages. Held pages stay listed, marked "Coming soon". */
export function CreditTabs() {
  const path = usePathname();
  const releases = useReleases();
  return (
    <nav className="rc-tabs" aria-label="Credit sections">
      {CREDIT_ROUTES.map((r) => {
        const live = !releases.ready || releases.isLive(r.feature);
        const current = path === r.href || path.startsWith(`${r.href}/`);
        return (
          <Link key={r.href} href={r.href} aria-current={current ? "page" : undefined} className={live ? undefined : "is-held"}>
            {r.label}
            {live ? null : <small>{COMING_SOON}</small>}
          </Link>
        );
      })}
    </nav>
  );
}

/** Frame of every lane L4 page: site nav, the tab row, the page, the footer. */
export function CreditShell({ children }: { children: ReactNode }) {
  return (
    <div className="product-page rc-page cr-page">
      <Nav />
      <main className="app-main">
        <CreditTabs />
        {children}
      </main>
      <Footer />
    </div>
  );
}

/** The dashboard sidebar's one entry for lane L4 (no top-level site nav entry, board rule). */
export function CreditSideLink() {
  const releases = useReleases();
  const first = CREDIT_ROUTES.find((r) => releases.isLive(r.feature));
  const held = releases.ready && !first;
  return (
    <Link href={first?.href ?? CREDIT_ROUTES[0]!.href} className={held ? "is-held" : undefined}>
      <svg className="dsh-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 7h16v11H4z" />
        <path d="M4 11h16" />
        <path d="M8 15h3" />
      </svg>
      <span>Agent credit</span>
      {held ? <small>{SOON_TAG}</small> : null}
    </Link>
  );
}
