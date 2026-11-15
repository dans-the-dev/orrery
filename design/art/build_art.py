"""Orrery art set: every illustration is a view through an eyepiece (a night disc) or a star plate (a night panel),
drawn in brass linework with violet and starlight accents. Writes SVGs into services/packages/web/public/art.

Run: python3 design/art/build_art.py
"""
import math
import random
from pathlib import Path

OUT = Path(__file__).resolve().parents[2] / "services/packages/web/public/art"

NIGHT = "#161b45"
DEEP = "#0d1030"
BRASS = "#d8b25c"
BRASS_SOFT = "#f1dca4"
VIOLET = "#8f7ff2"
STAR = "#f5f3ff"
FAINT = "rgba(241,220,164,.34)"


def stars(seed, w, h, n, cx=None, cy=None, r=None):
    rnd = random.Random(seed)
    out = []
    while len(out) < n:
        x, y = rnd.uniform(0, w), rnd.uniform(0, h)
        if r is not None and math.hypot(x - cx, y - cy) > r - 6:
            continue
        s = rnd.choice([0.7, 0.9, 1.1, 1.4, 1.8])
        o = rnd.uniform(0.35, 0.95)
        out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{s}" fill="{STAR}" opacity="{o:.2f}"/>')
    return "".join(out)


def sparkle(x, y, s, color=STAR):
    return (f'<path d="M{x} {y-s} Q{x} {y} {x+s} {y} Q{x} {y} {x} {y+s} Q{x} {y} {x-s} {y} Q{x} {y} {x} {y-s}Z" '
            f'fill="{color}"/>')


def eyepiece(name, seed, body, size=400):
    c = size / 2
    r = c - 8
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}" role="img" aria-hidden="true">
<defs>
<radialGradient id="g" cx="42%" cy="38%" r="70%"><stop offset="0" stop-color="#232a63"/><stop offset=".7" stop-color="{NIGHT}"/><stop offset="1" stop-color="{DEEP}"/></radialGradient>
<clipPath id="c"><circle cx="{c}" cy="{c}" r="{r}"/></clipPath>
</defs>
<circle cx="{c}" cy="{c}" r="{r}" fill="url(#g)"/>
<g clip-path="url(#c)">{stars(seed, size, size, 46, c, c, r)}{body}</g>
<circle cx="{c}" cy="{c}" r="{r}" fill="none" stroke="{BRASS}" stroke-width="3"/>
<circle cx="{c}" cy="{c}" r="{r-9}" fill="none" stroke="{FAINT}" stroke-width="1"/>
{ticks(c, c, r + 1, 48)}
</svg>'''
    (OUT / f"{name}.svg").write_text(svg)


def plate(name, seed, body, w=400, h=300):
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" aria-hidden="true">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1f255a"/><stop offset="1" stop-color="{DEEP}"/></linearGradient></defs>
<rect width="{w}" height="{h}" rx="26" fill="url(#g)"/>
{stars(seed, w, h, 40)}
<g fill="none" stroke="{FAINT}" stroke-width="1">{''.join(f'<line x1="{x}" y1="14" x2="{x}" y2="{h-14}" stroke-dasharray="2 6"/>' for x in range(50, w, 75))}</g>
{body}
<rect x="1.5" y="1.5" width="{w-3}" height="{h-3}" rx="25" fill="none" stroke="{BRASS}" stroke-width="2" opacity=".7"/>
</svg>'''
    (OUT / f"{name}.svg").write_text(svg)


def ticks(cx, cy, r, n):
    out = []
    for i in range(n):
        a = 2 * math.pi * i / n
        l = 7 if i % 4 == 0 else 3.5
        x1, y1 = cx + r * math.cos(a), cy + r * math.sin(a)
        x2, y2 = cx + (r - l) * math.cos(a), cy + (r - l) * math.sin(a)
        out.append(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}"/>')
    return f'<g stroke="{BRASS}" stroke-width="1.4">{"".join(out)}</g>'


def orbit(cx, cy, rx, ry, rot=0, dash=None, color=BRASS, w=1.6, op=1):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    return (f'<ellipse cx="{cx}" cy="{cy}" rx="{rx}" ry="{ry}" transform="rotate({rot} {cx} {cy})" fill="none" '
            f'stroke="{color}" stroke-width="{w}" opacity="{op}"{d}/>')


def on_ellipse(cx, cy, rx, ry, rot, deg):
    t = math.radians(deg)
    x, y = rx * math.cos(t), ry * math.sin(t)
    r = math.radians(rot)
    return cx + x * math.cos(r) - y * math.sin(r), cy + x * math.sin(r) + y * math.cos(r)


def planet(x, y, r, fill=VIOLET, ring=False):
    s = f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r}" fill="{fill}"/><circle cx="{x - r*0.3:.1f}" cy="{y - r*0.3:.1f}" r="{r*0.45:.1f}" fill="#fff" opacity=".22"/>'
    if ring:
        s += f'<ellipse cx="{x:.1f}" cy="{y:.1f}" rx="{r*1.9:.1f}" ry="{r*0.55:.1f}" transform="rotate(-18 {x:.1f} {y:.1f})" fill="none" stroke="{BRASS_SOFT}" stroke-width="2"/>'
    return s


def sun(x, y, r=16):
    rays = "".join(
        f'<line x1="{x + (r+5)*math.cos(a):.1f}" y1="{y + (r+5)*math.sin(a):.1f}" x2="{x + (r+12)*math.cos(a):.1f}" y2="{y + (r+12)*math.sin(a):.1f}"/>'
        for a in [i * math.pi / 6 for i in range(12)])
    return f'<circle cx="{x}" cy="{y}" r="{r}" fill="{BRASS}"/><circle cx="{x}" cy="{y}" r="{r*0.55}" fill="{BRASS_SOFT}"/><g stroke="{BRASS}" stroke-width="2" stroke-linecap="round">{rays}</g>'


def coin(x, y, r=14, label="$"):
    return (f'<circle cx="{x}" cy="{y}" r="{r}" fill="{BRASS_SOFT}" stroke="{BRASS}" stroke-width="2"/>'
            f'<text x="{x}" y="{y + r*0.38:.1f}" text-anchor="middle" font-family="Jost,Arial,sans-serif" font-weight="600" font-size="{r*1.05:.0f}" fill="{DEEP}">{label}</text>')


def telescope(x, y, s=1.0, rot=-28):
    return (f'<g transform="translate({x} {y}) rotate({rot}) scale({s})">'
            f'<rect x="-70" y="-13" width="120" height="26" rx="6" fill="{BRASS}"/>'
            f'<rect x="50" y="-17" width="26" height="34" rx="5" fill="{BRASS_SOFT}"/>'
            f'<rect x="-92" y="-8" width="24" height="16" rx="4" fill="{BRASS}"/>'
            f'<line x1="-10" y1="13" x2="-34" y2="70" stroke="{BRASS}" stroke-width="5" stroke-linecap="round"/>'
            f'<line x1="-10" y1="13" x2="14" y2="70" stroke="{BRASS}" stroke-width="5" stroke-linecap="round"/>'
            f'</g>')


def check(x, y, s=1.0, color=BRASS_SOFT):
    return f'<path d="M{x-12*s} {y} L{x-3*s} {y+9*s} L{x+14*s} {y-10*s}" fill="none" stroke="{color}" stroke-width="{4*s}" stroke-linecap="round" stroke-linejoin="round"/>'


def constellation(pts, color=BRASS_SOFT, w=1.6, dash=None):
    d = " ".join(("M" if i == 0 else "L") + f"{x} {y}" for i, (x, y) in enumerate(pts))
    dd = f' stroke-dasharray="{dash}"' if dash else ""
    return f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{w}" opacity=".8"{dd}/>' + "".join(sparkle(x, y, 7) for x, y in pts)


def build():
    OUT.mkdir(parents=True, exist_ok=True)
    C = 200

    # Set: dividers drawing the bound around a planet's orbit
    eyepiece("gate-set", 1,
             orbit(C, C, 120, 120, dash="6 7", color=BRASS) + orbit(C, C, 78, 78, color=FAINT) +
             planet(C, C, 26) +
             f'<g stroke="{BRASS_SOFT}" stroke-width="4" stroke-linecap="round"><line x1="{C}" y1="{C}" x2="{C+84}" y2="{C-84}"/><line x1="{C}" y1="{C}" x2="{C+118}" y2="{C-22}"/></g>'
             f'<circle cx="{C}" cy="{C}" r="7" fill="{BRASS}"/>')
    # Pay: a coin carried along the orbit
    px, py = on_ellipse(C, C, 120, 62, -16, -40)
    eyepiece("gate-pay", 2,
             orbit(C, C, 120, 62, -16) + sun(C, C, 18) + coin(px, py, 18) +
             orbit(C, C, 120, 62, -16, dash="2 9", color=BRASS_SOFT, w=3, op=.6))
    # Check: the telescope takes a reading of one star
    eyepiece("gate-check", 3,
             telescope(170, 236, 1.05) + sparkle(296, 120, 22, BRASS_SOFT) +
             f'<circle cx="296" cy="120" r="38" fill="none" stroke="{VIOLET}" stroke-width="2" stroke-dasharray="4 5"/>')
    # Sign: a constellation closing into a signed mark
    eyepiece("gate-sign", 4,
             constellation([(110, 250), (150, 170), (210, 210), (270, 130), (300, 180)]) +
             f'<circle cx="250" cy="270" r="34" fill="{BRASS}"/>' + check(250, 270, 1.3, DEEP))

    # Jobs: plates 400x300
    plate("job-cap", 5,
          orbit(200, 150, 150, 70, -6, dash="7 6", color="#f08a8a", w=2) + orbit(200, 150, 112, 50, -6) +
          orbit(200, 150, 72, 32, -6, color=FAINT) + sun(200, 150, 14) +
          planet(*on_ellipse(200, 150, 112, 50, -6, 30), 13) + planet(*on_ellipse(200, 150, 72, 32, -6, 200), 9, BRASS_SOFT))
    hands = f'<g stroke="{BRASS_SOFT}" stroke-width="4" stroke-linecap="round"><line x1="200" y1="150" x2="200" y2="82"/><line x1="200" y1="150" x2="248" y2="150"/></g>'
    arc = f'<path d="M200 62 A88 88 0 0 1 288 150" fill="none" stroke="{VIOLET}" stroke-width="10" stroke-linecap="round" opacity=".85"/>'
    plate("job-wait", 6,
          f'<circle cx="200" cy="150" r="88" fill="none" stroke="{BRASS}" stroke-width="2"/>' + ticks(200, 150, 88, 60) +
          arc + hands + f'<circle cx="200" cy="150" r="7" fill="{BRASS}"/>')
    plate("job-route", 7,
          constellation([(70, 220), (130, 150), (205, 185), (265, 105), (335, 140)]) +
          "".join(f'<circle cx="{x}" cy="{y}" r="5" fill="none" stroke="{FAINT}" stroke-width="1.5"/>' for x, y in [(110, 70), (300, 240), (180, 255), (350, 60)]))

    # Audiences and page heads
    eyepiece("agent-tag", 8,
             planet(C, C, 46, VIOLET, ring=True) +
             f'<g transform="translate(270 110) rotate(18)"><rect x="-38" y="-18" width="76" height="36" rx="9" fill="{BRASS_SOFT}"/><circle cx="-22" cy="0" r="5" fill="{DEEP}"/><rect x="-10" y="-5" width="36" height="10" rx="3" fill="{DEEP}" opacity=".7"/></g>'
             f'<line x1="232" y1="128" x2="214" y2="160" stroke="{BRASS_SOFT}" stroke-width="2"/>')
    eyepiece("signer-lookup", 9,
             planet(150, 170, 34, "#6f62d6") + orbit(150, 170, 70, 26, -20, color=FAINT) +
             f'<circle cx="240" cy="236" r="64" fill="rgba(143,127,242,.16)" stroke="{BRASS}" stroke-width="7"/>'
             f'<line x1="286" y1="282" x2="330" y2="326" stroke="{BRASS}" stroke-width="14" stroke-linecap="round"/>' + check(240, 236, 1.6))
    disc = lambda y: (f'<path d="M{C-72} {y} L{C-72} {y+16} A72 22 0 0 0 {C+72} {y+16} L{C+72} {y} Z" fill="{BRASS}"/>'
                      f'<ellipse cx="{C}" cy="{y}" rx="72" ry="22" fill="{BRASS_SOFT}" stroke="{BRASS}" stroke-width="2"/>')
    eyepiece("credits-pack", 10,
             "".join(disc(276 - i * 24) for i in range(5)) + sparkle(C, 156, 14, DEEP) +
             "".join(sparkle(C + dx, 110 + dy, 9, BRASS_SOFT) for dx, dy in [(-92, -10), (96, -22), (82, 40)]))
    eyepiece("docs-manual", 11,
             f'<path d="M86 140 Q140 120 198 146 L198 282 Q140 258 86 278Z" fill="{BRASS_SOFT}"/>'
             f'<path d="M314 140 Q260 120 202 146 L202 282 Q260 258 314 278Z" fill="#efe6c8"/>'
             + constellation([(112, 200), (140, 172), (172, 210)], DEEP, 1.4) + orbit(258, 208, 34, 16, -10, color=DEEP, w=1.6) +
             f'<circle cx="258" cy="208" r="6" fill="{DEEP}"/>')
    eyepiece("operator-console", 12,
             f'<circle cx="{C}" cy="{C}" r="118" fill="none" stroke="{BRASS}" stroke-width="2"/>' + ticks(C, C, 118, 72) +
             f'<circle cx="{C}" cy="{C}" r="84" fill="none" stroke="{FAINT}" stroke-width="10"/>'
             f'<path d="M{C} {C-84} A84 84 0 0 1 {C+73} {C+42}" fill="none" stroke="{VIOLET}" stroke-width="10" stroke-linecap="round"/>'
             f'<line x1="{C}" y1="{C}" x2="{C+60}" y2="{C-88}" stroke="{BRASS_SOFT}" stroke-width="4" stroke-linecap="round"/>' + sun(C, C, 12))

    # Token pages
    eyepiece("orry-burn", 13,
             f'<path d="M96 300 Q180 240 286 124" fill="none" stroke="{BRASS_SOFT}" stroke-width="18" stroke-linecap="round" opacity=".25"/>'
             f'<path d="M120 286 Q190 236 280 132" fill="none" stroke="{BRASS}" stroke-width="7" stroke-linecap="round"/>'
             f'<circle cx="288" cy="122" r="20" fill="{BRASS_SOFT}"/><circle cx="288" cy="122" r="9" fill="#fff"/>')
    eyepiece("orry-claim", 14,
             f'<path d="M120 236 A82 82 0 0 0 280 236" fill="{BRASS}" opacity=".9"/><path d="M134 236 A68 68 0 0 0 266 236" fill="{NIGHT}"/>'
             + sparkle(C, 150, 24, BRASS_SOFT) + f'<line x1="{C}" y1="60" x2="{C}" y2="118" stroke="{BRASS_SOFT}" stroke-width="2" stroke-dasharray="3 6"/>')
    eyepiece("orry-earn", 15,
             sun(C, C, 22) + orbit(C, C, 108, 108, color=FAINT) +
             planet(*on_ellipse(C, C, 108, 108, 0, -30), 18) + planet(*on_ellipse(C, C, 108, 108, 0, 150), 14, BRASS_SOFT) +
             f'<path d="M{C+60} {C-110} A124 124 0 0 1 {C+124} {C}" fill="none" stroke="{VIOLET}" stroke-width="5" stroke-linecap="round"/>')
    eyepiece("orry-leaderboard", 16,
             "".join(f'<rect x="{x}" y="{300-h}" width="56" height="{h}" rx="10" fill="{c}"/>' + sparkle(x + 28, 300 - h - 26, s, BRASS_SOFT)
                     for x, h, c, s in [(92, 110, "#3a3f86", 11), (172, 170, VIOLET, 16), (252, 80, "#3a3f86", 9)]))
    eyepiece("orry-stake", 17,
             planet(C, C, 40, VIOLET) + orbit(C, C, 86, 86, color=BRASS) + orbit(C, C, 126, 126, dash="4 7", color=FAINT) +
             planet(*on_ellipse(C, C, 86, 86, 0, -50), 11, BRASS_SOFT) + planet(*on_ellipse(C, C, 126, 126, 0, 120), 8, BRASS_SOFT) +
             f'<path d="M{C} {C+40} L{C} {C+132}" stroke="{BRASS}" stroke-width="5"/><path d="M{C-26} {C+112} Q{C} {C+140} {C+26} {C+112}" fill="none" stroke="{BRASS}" stroke-width="5" stroke-linecap="round"/>')

    # Mark: a brass sun with two orbits and one planet, on a night tile
    mark = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96">
<rect width="96" height="96" rx="24" fill="{NIGHT}"/>
<ellipse cx="48" cy="48" rx="34" ry="14" transform="rotate(-24 48 48)" fill="none" stroke="{BRASS}" stroke-width="4"/>
<ellipse cx="48" cy="48" rx="20" ry="20" fill="none" stroke="{BRASS_SOFT}" stroke-width="2" opacity=".55"/>
<circle cx="48" cy="48" r="9" fill="{BRASS}"/>
<circle cx="76.5" cy="34.5" r="7" fill="{VIOLET}"/>
</svg>'''
    (OUT / "mark.svg").write_text(mark)
    print("wrote", len(list(OUT.glob("*.svg"))), "svgs to", OUT)


if __name__ == "__main__":
    build()
