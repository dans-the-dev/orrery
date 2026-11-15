import Link from "next/link";
import { Brand } from "./Brand";
import { DISCORD_URL, X_HANDLE, X_URL } from "./social";

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="site-footer-main">
        <Brand />
        <p>Agent payments, bounded and on record.</p>
      </div>
      <nav className="site-footer-links" aria-label="Footer">
        <Link href="/dashboard">Dashboard</Link>
        <Link href="/signer">Signer readings</Link>
        <Link href="/docs">Docs</Link>
        {X_URL ? <a href={X_URL} target="_blank" rel="noreferrer">{X_HANDLE}</a> : null}
        {DISCORD_URL ? <a href={DISCORD_URL} target="_blank" rel="noreferrer">Discord</a> : null}
        <Link href="/terms">Terms</Link>
        <Link href="/privacy">Privacy</Link>
      </nav>
    </footer>
  );
}
