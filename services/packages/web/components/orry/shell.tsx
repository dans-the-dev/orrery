import type { ReactNode } from "react";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { OrryTabs } from "./parts";

/** Frame of every ORRY page: site nav, the ORRY tab row, the page, the footer. */
export function OrryShell({ children, wide = true }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="product-page rc-page">
      <Nav />
      <main className={wide ? "app-main" : "docs-main"}>
        <OrryTabs />
        {children}
      </main>
      <Footer />
    </div>
  );
}
