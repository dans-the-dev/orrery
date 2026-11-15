"use client";

import { useEffect, useState } from "react";

/**
 * The hero object: a brass orrery. Three agents travel on their orbits around the sun; the dashed rose ring is the cap
 * none of them crosses. Planets move with SMIL animateMotion, which CSS cannot stop, so under prefers-reduced-motion
 * the component renders them at rest instead.
 */
const ORBITS = [
  { rx: 118, ry: 44, rot: -14, dur: 14, r: 9, fill: "#f1dca4", begin: "0s" },
  { rx: 176, ry: 68, rot: -14, dur: 22, r: 14, fill: "#8f7ff2", begin: "-6s" },
  { rx: 232, ry: 92, rot: -14, dur: 34, r: 11, fill: "#d8b25c", begin: "-20s" },
];
/** Server and browser round trig differently in the last digits; two decimals keep hydration identical. */
const q = (v: number) => Math.round(v * 100) / 100;
const CX = 300;
const CY = 300;

const ellipsePath = (rx: number, ry: number) =>
  `M ${CX - rx} ${CY} a ${rx} ${ry} 0 1 0 ${rx * 2} 0 a ${rx} ${ry} 0 1 0 ${-rx * 2} 0`;

function rest(rx: number, ry: number, rot: number, deg: number) {
  const t = (deg * Math.PI) / 180;
  const x = rx * Math.cos(t);
  const y = ry * Math.sin(t);
  const r = (rot * Math.PI) / 180;
  return { x: q(CX + x * Math.cos(r) - y * Math.sin(r)), y: q(CY + x * Math.sin(r) + y * Math.cos(r)) };
}

const STARS = Array.from({ length: 70 }, (_, i) => {
  const a = Math.sin(i * 12.9898) * 43758.5453;
  const b = Math.sin(i * 78.233) * 12543.123;
  return { x: q((a - Math.floor(a)) * 600), y: q((b - Math.floor(b)) * 600), r: i % 7 === 0 ? 1.6 : i % 3 === 0 ? 1.1 : 0.7, o: 0.35 + ((i * 37) % 60) / 100 };
});

export function OrreryHero({ label }: { label: string }) {
  const [still, setStill] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const set = () => setStill(mq.matches);
    set();
    mq.addEventListener("change", set);
    return () => mq.removeEventListener("change", set);
  }, []);

  return (
    <svg className="lp-hero-art orrery-hero" viewBox="0 0 600 600" role="img" aria-label={label}>
      <defs>
        <radialGradient id="oh-sky" cx="50%" cy="46%" r="54%">
          <stop offset="0" stopColor="#262d6b" />
          <stop offset=".72" stopColor="#161b45" />
          <stop offset="1" stopColor="#0d1030" />
        </radialGradient>
        <radialGradient id="oh-sun" cx="40%" cy="38%" r="70%">
          <stop offset="0" stopColor="#fff4cf" />
          <stop offset=".5" stopColor="#f1dca4" />
          <stop offset="1" stopColor="#c99a3e" />
        </radialGradient>
        <clipPath id="oh-clip">
          <circle cx={CX} cy={CY} r="286" />
        </clipPath>
      </defs>
      <circle cx={CX} cy={CY} r="286" fill="url(#oh-sky)" />
      <g clipPath="url(#oh-clip)">
        {STARS.map((s, i) => (
          <circle key={i} cx={s.x} cy={s.y} r={s.r} fill="#f5f3ff" opacity={s.o} />
        ))}
        <ellipse cx={CX} cy={CY} rx="262" ry="106" transform={`rotate(-14 ${CX} ${CY})`} fill="none" stroke="#f08a8a" strokeWidth="2" strokeDasharray="8 8" />
        {ORBITS.map((o) => (
          <path key={o.rx} d={ellipsePath(o.rx, o.ry)} transform={`rotate(${o.rot} ${CX} ${CY})`} fill="none" stroke="#d8b25c" strokeOpacity=".75" strokeWidth="1.6" />
        ))}
        <line x1={CX} y1={CY + 40} x2={CX} y2="560" stroke="#d8b25c" strokeWidth="6" strokeLinecap="round" />
        <path d={`M ${CX - 70} 560 Q ${CX} 540 ${CX + 70} 560`} fill="none" stroke="#d8b25c" strokeWidth="6" strokeLinecap="round" />
        <circle cx={CX} cy={CY} r="34" fill="url(#oh-sun)" />
        <circle cx={CX} cy={CY} r="46" fill="none" stroke="#f1dca4" strokeOpacity=".35" strokeWidth="1" />
        {ORBITS.map((o, i) => {
          if (still) {
            const p = rest(o.rx, o.ry, o.rot, [-40, 150, 20][i]!);
            return <circle key={o.rx} cx={p.x} cy={p.y} r={o.r} fill={o.fill} />;
          }
          return (
            <g key={o.rx} transform={`rotate(${o.rot} ${CX} ${CY})`}>
              <circle r={o.r} fill={o.fill}>
                <animateMotion dur={`${o.dur}s`} begin={o.begin} repeatCount="indefinite" path={ellipsePath(o.rx, o.ry)} />
              </circle>
            </g>
          );
        })}
      </g>
      <circle cx={CX} cy={CY} r="286" fill="none" stroke="#d8b25c" strokeWidth="3" />
      <circle cx={CX} cy={CY} r="276" fill="none" stroke="#f1dca4" strokeOpacity=".3" strokeWidth="1" />
      <g stroke="#d8b25c" strokeWidth="1.4">
        {Array.from({ length: 72 }, (_, i) => {
          const a = (i / 72) * Math.PI * 2;
          const l = i % 6 === 0 ? 10 : 4;
          return <line key={i} x1={q(CX + 286 * Math.cos(a))} y1={q(CY + 286 * Math.sin(a))} x2={q(CX + (286 - l) * Math.cos(a))} y2={q(CY + (286 - l) * Math.sin(a))} />;
        })}
      </g>
    </svg>
  );
}
