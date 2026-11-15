import type { Metadata } from "next";
import { Albert_Sans, IBM_Plex_Mono, Jost } from "next/font/google";
import { headers } from "next/headers";
import { cookieToInitialState } from "wagmi";
import { wagmiConfig } from "@/lib/wagmi";
import { MOTION_BOOT, MotionRoot } from "@/components/motion/MotionRoot";
import { X_HANDLE } from "@/components/social";
import { Providers } from "./providers";
import "./globals.css";

const display = Jost({ subsets: ["latin"], weight: ["300", "400", "500"], variable: "--font-display" });
const text = Albert_Sans({ subsets: ["latin"], weight: ["400", "600", "700"], variable: "--font-text" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["500", "700"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "Orrery · Bounded payments for AI agents",
  description: "Plot the caps your AI agents pay within, in USDG on Robinhood Chain. Whoever they pay can read the paying address and receive a signed reading.",
  metadataBase: new URL("https://orrery.tech"),
  openGraph: { title: "Orrery", description: "Every agent payment on a visible orbit.", url: "https://orrery.tech", siteName: "Orrery", images: [{ url: "/og.png", width: 1200, height: 630 }] },
  twitter: { card: "summary_large_image", ...(X_HANDLE ? { site: X_HANDLE } : {}), images: ["/og.png"] },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const initialState = cookieToInitialState(wagmiConfig, (await headers()).get("cookie"));
  return (
    <html lang="en" className={`${display.variable} ${text.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: MOTION_BOOT }} />
      </head>
      <body>
        <Providers initialState={initialState}>{children}</Providers>
        <MotionRoot />
      </body>
    </html>
  );
}
