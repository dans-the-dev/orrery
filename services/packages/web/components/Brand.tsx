/* eslint-disable @next/next/no-img-element */
import Link from "next/link";

/** The Orrery mark (the limiter ring) beside the wordmark. */
export function Brand({ href = "/" }: { href?: string }) {
  return (
    <Link className="brand" href={href} aria-label="Orrery home">
      <img src="/art/mark.svg" alt="" width={30} height={30} />
      <span>orrery</span>
    </Link>
  );
}
