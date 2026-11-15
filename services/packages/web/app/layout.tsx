import type { Metadata } from "next";
import { Figtree, JetBrains_Mono, Sora } from "next/font/google";
import { headers } from "next/headers";
import { cookieToInitialState } from "wagmi";
import { wagmiConfig } from "@/lib/wagmi";
import { MOTION_BOOT, MotionRoot } from "@/components/motion/MotionRoot";
import { Providers } from "./providers";
import "./globals.css";

const display = Sora({ subsets: ["latin"], weight: ["500", "600", "700"], variable: "--font-display" });
const text = Figtree({ subsets: ["latin"], weight: ["400", "600", "700"], variable: "--font-text" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["500", "700"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "Orrery · Public limits for agent payments",
  description: "Set public spending limits for the agents you run. Anyone who receives a payment can check the paying address and get a signed answer.",
  metadataBase: new URL("https://orrery.tech"),
  openGraph: { title: "Orrery", description: "Public limits for agent payments.", url: "https://orrery.tech", siteName: "Orrery", images: [{ url: "/og.png", width: 1200, height: 630 }] },
  twitter: { card: "summary_large_image", site: "@OrreryHQ", images: ["/og.png"] },
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
