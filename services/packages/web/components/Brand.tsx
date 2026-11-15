import Link from "next/link";

/** The Orrery mark (a rose gold orbit with one body on it, around a centre) beside the spaced serif wordmark. */
export function BrandMark({ className = "brand-mark" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 40 40" aria-hidden="true" focusable="false">
      <circle cx="19" cy="21" r="16" fill="none" stroke="#d9967a" strokeWidth="1.4" />
      <circle cx="19" cy="21" r="2.2" fill="#d9967a" />
      <circle cx="31.6" cy="11.2" r="3.4" fill="#d9967a" />
    </svg>
  );
}

export function Brand({ href = "/" }: { href?: string }) {
  return (
    <Link className="brand" href={href} aria-label="Orrery home">
      <BrandMark />
      <span>Orrery</span>
    </Link>
  );
}
