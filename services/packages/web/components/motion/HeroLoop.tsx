"use client";
/* eslint-disable @next/next/no-img-element */

import { useEffect, useRef, useState } from "react";

/**
 * The hero object as a silent loop. The still art is the poster and the first paint; the video takes over once it can
 * play, pauses while off screen, and is never loaded for visitors who asked for reduced motion or save data.
 */
export function HeroLoop({ poster, webm, mp4, alt, className }: { poster: string; webm: string; mp4: string; alt: string; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [motionOk, setMotionOk] = useState(false);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
    setMotionOk(!reduce && !saveData);
  }, []);

  useEffect(() => {
    const v = ref.current;
    if (!motionOk || !v) return;
    const io = new IntersectionObserver(([e]) => {
      if (e?.isIntersecting) void v.play().catch(() => {});
      else v.pause();
    });
    io.observe(v);
    return () => io.disconnect();
  }, [motionOk]);

  return (
    <div className={`hero-loop${playing ? " is-playing" : ""}${className ? ` ${className}` : ""}`}>
      <img className="hero-loop-still" src={poster} alt={alt} width={1800} height={1012} />
      {motionOk ? (
        <video ref={ref} className="hero-loop-video" muted loop playsInline preload="auto" poster={poster} aria-hidden="true" onPlaying={() => setPlaying(true)}>
          <source src={webm} type="video/webm" />
          <source src={mp4} type="video/mp4" />
        </video>
      ) : null}
    </div>
  );
}
