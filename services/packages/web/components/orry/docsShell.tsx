import type { ReactNode } from "react";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { DocsTabs } from "./docs";
import { OrryHead } from "./parts";

/** Frame of the ORRY guides: site nav, guide tabs, header, prose body. */
export function DocsShell({ kicker, title, lead, children }: { kicker: string; title: string; lead: ReactNode; children: ReactNode }) {
  return (
    <div className="product-page rc-page">
      <Nav />
      <main className="docs-main">
        <DocsTabs />
        <OrryHead kicker={kicker} title={title} lead={lead} />
        <div className="docs-body rc-docs">{children}</div>
      </main>
      <Footer />
    </div>
  );
}
