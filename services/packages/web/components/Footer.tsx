import Link from "next/link";
import { DISCORD_URL, X_HANDLE, X_URL } from "@/lib/config";
import { Brand } from "./Brand";

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="site-footer-main">
        <Brand />
        <p>Public limits for agent payments.</p>
      </div>
      <nav className="site-footer-links" aria-label="Footer">
        <Link href="/dashboard">Dashboard</Link>
        <Link href="/signer">Signer lookup</Link>
        <Link href="/docs">Docs</Link>
        <a href={X_URL} target="_blank" rel="noreferrer">{X_HANDLE}</a>
        <a href={DISCORD_URL} target="_blank" rel="noreferrer">Discord</a>
        <Link href="/terms">Terms</Link>
        <Link href="/privacy">Privacy</Link>
      </nav>
    </footer>
  );
}
