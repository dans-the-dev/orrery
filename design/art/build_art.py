"""Orrery art set (the Mainspring theme, design/mainspring): every illustration is a piece of a fine watch, drawn in
rose gold with blued steel, ruby jewels and engraved navy dials. Square views are watches seen face on (case, crown,
minute track) or opened to their movement; the 400x300 plates are movement plates or small watches on a navy panel.
Writes the mark into services/packages/web/public/art and the vector drafts of the illustrations into design/art/vector
(the site uses the HD photographs from hd_art.py).

Run: python3 design/art/build_art.py
"""
import math
from pathlib import Path

OUT = Path(__file__).resolve().parents[2] / "services/packages/web/public/art"   # the mark only
# Vector drafts of the illustrations; the site ships the HD photographs built by hd_art.py.
VEC = Path(__file__).resolve().parent / "vector"

NIGHT = "#0f1a2e"
DEEP = "#0a1222"
BRASS = "#d9967a"       # rose gold
BRASS_SOFT = "#ebc2ae"
STEEL = "#4f6fa8"       # blued steel
FAINT = "rgba(235,194,174,.34)"
RUBY = "#c2384b"
ROSE_DARK = "#a8664b"


def defs(uid=""):
    return (f'<linearGradient id="k{uid}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f3c9b4"/><stop offset=".45" stop-color="{BRASS}"/><stop offset="1" stop-color="{ROSE_DARK}"/></linearGradient>'
            f'<radialGradient id="d{uid}" cx="44%" cy="38%" r="72%"><stop offset="0" stop-color="#1d3156"/><stop offset=".7" stop-color="{NIGHT}"/><stop offset="1" stop-color="{DEEP}"/></radialGradient>')


def watch_group(cx, cy, rc, body, dial=True, uid=""):
    """A watch seen face on: rose gold case, crown at three o'clock, minute track, engraved navy dial.
    rc is the case radius; the drawing is scaled from the 178 unit case of the square icons."""
    k = rc / 178
    rd = rc - 14 * k
    knurl = "".join(f'<line x1="{cx + rc + (6 + i * 4) * k:.1f}" y1="{cy - 15 * k:.1f}" x2="{cx + rc + (6 + i * 4) * k:.1f}" y2="{cy + 15 * k:.1f}"/>' for i in range(5))
    track = []
    for i in range(60):
        a = 2 * math.pi * i / 60 - math.pi / 2
        hour = i % 5 == 0
        l = (13 if i == 0 else 10 if hour else 4) * k
        r0 = rd - 6 * k
        x1, y1 = cx + r0 * math.cos(a), cy + r0 * math.sin(a)
        x2, y2 = cx + (r0 - l) * math.cos(a), cy + (r0 - l) * math.sin(a)
        w = max(0.8, (4 if i == 0 else 3 if hour else 1.2) * k)
        col = BRASS_SOFT if hour else FAINT
        track.append(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="{col}" stroke-width="{w:.1f}" stroke-linecap="round"/>')
    step = max(5, 7 * k)
    engrave = "".join(f'<circle cx="{cx}" cy="{cy}" r="{r:.1f}" fill="none" stroke="#e9ecef" stroke-opacity=".05"/>'
                      for r in [14 * k + step * j for j in range(int((rd - 38 * k) / step))])
    face = f'<circle cx="{cx}" cy="{cy}" r="{rd:.1f}" fill="url(#d{uid})"/>' + (engrave + "".join(track) if dial else "")
    return "".join([
        f'<clipPath id="c{uid}"><circle cx="{cx}" cy="{cy}" r="{rd:.1f}"/></clipPath>',
        f'<rect x="{cx + rc - 6 * k:.1f}" y="{cy - 8 * k:.1f}" width="{14 * k:.1f}" height="{16 * k:.1f}" rx="{3 * k:.1f}" fill="{ROSE_DARK}"/>',
        f'<rect x="{cx + rc + 2 * k:.1f}" y="{cy - 19 * k:.1f}" width="{22 * k:.1f}" height="{38 * k:.1f}" rx="{6 * k:.1f}" fill="url(#k{uid})"/>',
        f'<g stroke="{ROSE_DARK}" stroke-width="{1.4 * k:.1f}" opacity=".7">{knurl}</g>',
        f'<circle cx="{cx}" cy="{cy}" r="{rc}" fill="url(#k{uid})"/>',
        f'<circle cx="{cx}" cy="{cy}" r="{rc - 5 * k:.1f}" fill="none" stroke="#fff" stroke-opacity=".25" stroke-width="{1.5 * k:.1f}"/>',
        face,
        f'<g clip-path="url(#c{uid})">{body}</g>',
        f'<circle cx="{cx}" cy="{cy}" r="{rd:.1f}" fill="none" stroke="{DEEP}" stroke-width="{2 * k:.1f}"/>',
        f'<path d="M{cx - rd * 0.62:.1f} {cy - rd * 0.6:.1f} A{rd:.1f} {rd:.1f} 0 0 1 {cx + rd * 0.5:.1f} {cy - rd * 0.72:.1f}" fill="none" stroke="#fff" stroke-opacity=".08" stroke-width="{16 * k:.1f}" stroke-linecap="round"/>',
    ])


def watch(name, body, size=400, dial=True):
    c = size / 2
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}" role="img" aria-hidden="true">'
           f'<defs>{defs()}</defs>{watch_group(c, c, c - 22, body, dial)}</svg>')
    (VEC / f"{name}.svg").write_text(svg)


def plate(name, body, w=400, h=300):
    """A navy panel with the faint engraving of the page ground and a rose gold hairline."""
    waves = "".join(
        f'<path d="M0 {y} ' + " ".join(f"Q{x + 22.5} {y + (-9 if (x // 45) % 2 == 0 else 9)} {x + 45} {y}" for x in range(0, w, 45)) + '" />'
        for y in range(14, h, 14))
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" aria-hidden="true">'
           f'<defs>{defs()}<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#17263f"/><stop offset="1" stop-color="{DEEP}"/></linearGradient>'
           f'<clipPath id="p"><rect width="{w}" height="{h}" rx="26"/></clipPath></defs>'
           f'<rect width="{w}" height="{h}" rx="26" fill="url(#g)"/>'
           f'<g clip-path="url(#p)" fill="none" stroke="#e9ecef" stroke-opacity=".045">{waves}</g>'
           f'{body}'
           f'<rect x="1.5" y="1.5" width="{w - 3}" height="{h - 3}" rx="25" fill="none" stroke="{BRASS}" stroke-width="2" opacity=".7"/></svg>')
    (VEC / f"{name}.svg").write_text(svg)


def polar(cx, cy, r, deg):
    """Clock angle: 0 is twelve o'clock, clockwise."""
    a = math.radians(deg - 90)
    return cx + r * math.cos(a), cy + r * math.sin(a)


def arc(cx, cy, r, d0, d1, color=BRASS, w=6, extra=""):
    x0, y0 = polar(cx, cy, r, d0)
    x1, y1 = polar(cx, cy, r, d1)
    large = 1 if (d1 - d0) % 360 > 180 else 0
    return (f'<path d="M{x0:.1f} {y0:.1f} A{r} {r} 0 {large} 1 {x1:.1f} {y1:.1f}" fill="none" stroke="{color}" '
            f'stroke-width="{w}" stroke-linecap="round"{extra}/>')


def leaf_hand(cx, cy, length, deg, width, color=BRASS_SOFT):
    """A dauphine hand: a long narrow leaf from a short tail to the tip."""
    tip = polar(cx, cy, length, deg)
    tail = polar(cx, cy, -length * 0.16, deg)
    base = polar(cx, cy, length * 0.28, deg)
    a = math.radians(deg)
    ox, oy = width * math.cos(a), width * math.sin(a)
    l = (base[0] - ox, base[1] - oy)
    r = (base[0] + ox, base[1] + oy)
    return (f'<path d="M{tail[0]:.1f} {tail[1]:.1f} L{l[0]:.1f} {l[1]:.1f} L{tip[0]:.1f} {tip[1]:.1f} L{r[0]:.1f} {r[1]:.1f}Z" '
            f'fill="{color}" stroke="{ROSE_DARK}" stroke-width="1" stroke-linejoin="round"/>')


def jewel(x, y, r):
    return (f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r + 3}" fill="{BRASS}"/><circle cx="{x:.1f}" cy="{y:.1f}" r="{r}" fill="{RUBY}"/>'
            f'<circle cx="{x - r * 0.35:.1f}" cy="{y - r * 0.35:.1f}" r="{r * 0.35:.1f}" fill="#fff" opacity=".55"/>')


def screw(x, y, r=7, rot=30):
    """A blued steel screw head with its slot."""
    a = math.radians(rot)
    dx, dy = r * 0.8 * math.cos(a), r * 0.8 * math.sin(a)
    return (f'<circle cx="{x}" cy="{y}" r="{r}" fill="{STEEL}" stroke="#2a3d63" stroke-width="1.2"/>'
            f'<line x1="{x - dx:.1f}" y1="{y - dy:.1f}" x2="{x + dx:.1f}" y2="{y + dy:.1f}" stroke="{DEEP}" stroke-width="{max(1.5, r * 0.28):.1f}" stroke-linecap="round"/>')


def gear(cx, cy, r, teeth, rot=0, fill=BRASS, spokes=4):
    pts = []
    for i in range(teeth * 4):
        a = math.radians(rot) + 2 * math.pi * i / (teeth * 4)
        rr = r if (i % 4) in (1, 2) else r - r * 0.12 - 3
        pts.append(f"{cx + rr * math.cos(a):.1f},{cy + rr * math.sin(a):.1f}")
    rim = r * 0.74
    arms = "".join(
        f'<line x1="{cx}" y1="{cy}" x2="{cx + rim * math.cos(math.radians(rot) + k * 2 * math.pi / spokes):.1f}" '
        f'y2="{cy + rim * math.sin(math.radians(rot) + k * 2 * math.pi / spokes):.1f}"/>' for k in range(spokes))
    return (f'<polygon points="{" ".join(pts)}" fill="{fill}" stroke="{ROSE_DARK}" stroke-width="1.2" stroke-linejoin="round"/>'
            f'<circle cx="{cx}" cy="{cy}" r="{rim:.1f}" fill="{NIGHT}"/>'
            f'<g stroke="{fill}" stroke-width="{max(3, r * 0.11):.1f}" stroke-linecap="round">{arms}</g>'
            f'<circle cx="{cx}" cy="{cy}" r="{rim:.1f}" fill="none" stroke="{fill}" stroke-width="3"/>')


def spiral(cx, cy, r0, r1, turns, color=BRASS_SOFT, w=2, start=0):
    n = int(turns * 72)
    pts = []
    for i in range(n + 1):
        t = i / n
        r = r0 + (r1 - r0) * t
        x, y = polar(cx, cy, r, start + 360 * turns * t)
        pts.append(f"{x:.1f} {y:.1f}")
    return f'<path d="M{" L".join(pts)}" fill="none" stroke="{color}" stroke-width="{w}" stroke-linecap="round" stroke-linejoin="round"/>'


def coin(x, y, r=14, label="$"):
    return (f'<circle cx="{x}" cy="{y}" r="{r}" fill="{BRASS_SOFT}" stroke="{BRASS}" stroke-width="2"/>'
            f'<text x="{x}" y="{y + r * 0.38:.1f}" text-anchor="middle" font-family="Arial,sans-serif" font-weight="700" font-size="{r * 1.05:.0f}" fill="{DEEP}">{label}</text>')


def check(x, y, s=1.0, color=BRASS_SOFT):
    return f'<path d="M{x-12*s} {y} L{x-3*s} {y+9*s} L{x+14*s} {y-10*s}" fill="none" stroke="{color}" stroke-width="{4*s}" stroke-linecap="round" stroke-linejoin="round"/>'


def subdial(cx, cy, r, hand_deg, stop_deg=None):
    """A small chronograph register: ring, ticks, one hand, and an optional ruby stop."""
    ticks = "".join(
        f'<line x1="{polar(cx, cy, r - 3, d)[0]:.1f}" y1="{polar(cx, cy, r - 3, d)[1]:.1f}" x2="{polar(cx, cy, r - (8 if d % 90 == 0 else 5), d)[0]:.1f}" y2="{polar(cx, cy, r - (8 if d % 90 == 0 else 5), d)[1]:.1f}"/>'
        for d in range(0, 360, 30))
    hx, hy = polar(cx, cy, r - 7, hand_deg)
    stop = ""
    if stop_deg is not None:
        sx, sy = polar(cx, cy, r - 4, stop_deg)
        stop = arc(cx, cy, r - 4, 0, stop_deg, BRASS, 2.5, ' opacity=".9"') + f'<circle cx="{sx:.1f}" cy="{sy:.1f}" r="3.6" fill="{RUBY}"/>'
    return (f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{DEEP}" stroke="{BRASS_SOFT}" stroke-opacity=".5" stroke-width="1.5"/>'
            + "".join(f'<circle cx="{cx}" cy="{cy}" r="{rr}" fill="none" stroke="#e9ecef" stroke-opacity=".06"/>' for rr in range(5, int(r) - 4, 4))
            + f'<g stroke="{FAINT}" stroke-width="1.4" stroke-linecap="round">{ticks}</g>' + stop
            + f'<line x1="{cx}" y1="{cy}" x2="{hx:.1f}" y2="{hy:.1f}" stroke="{BRASS_SOFT}" stroke-width="2.4" stroke-linecap="round"/>'
            + f'<circle cx="{cx}" cy="{cy}" r="3" fill="{BRASS}"/>')


def loupe(lx, ly, lr, inner):
    """A watchmaker's loupe: rose gold barrel to the lower right, a lens over whatever `inner` draws."""
    return (f'<path d="M{lx + lr * 0.5:.1f} {ly + lr * 0.85:.1f} L{lx + lr * 1.5:.1f} {ly + lr * 2:.1f} L{lx + lr * 2.1:.1f} {ly + lr * 1.45:.1f} L{lx + lr * 0.88:.1f} {ly + lr * 0.5:.1f} Z" '
            f'fill="url(#k)" stroke="{ROSE_DARK}" stroke-width="2" stroke-linejoin="round"/>'
            f'<circle cx="{lx}" cy="{ly}" r="{lr}" fill="#22385f"/>' + inner +
            f'<circle cx="{lx}" cy="{ly}" r="{lr}" fill="none" stroke="url(#k)" stroke-width="{lr * 0.15:.1f}"/>'
            f'<path d="M{lx - lr * 0.62:.1f} {ly - lr * 0.48:.1f} A{lr * 0.78:.1f} {lr * 0.78:.1f} 0 0 1 {lx + lr * 0.05:.1f} {ly - lr * 0.78:.1f}" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="{lr * 0.09:.1f}" stroke-linecap="round"/>')


def rosette(cx, cy, ring, r, op=".28", step=15):
    return "".join(
        f'<circle cx="{cx + ring * math.cos(math.radians(a)):.1f}" cy="{cy + ring * math.sin(math.radians(a)):.1f}" r="{r}" fill="none" stroke="{BRASS_SOFT}" stroke-opacity="{op}" stroke-width="1.2"/>'
        for a in range(0, 360, step))


def build():
    OUT.mkdir(parents=True, exist_ok=True)
    VEC.mkdir(parents=True, exist_ok=True)
    C = 200

    # Plot: the operator sets the hands inside a bound marked on the dial (rose sector, ruby stop at the cap)
    sx, sy = polar(C, C, 150, 0)
    ex, ey = polar(C, C, 150, 130)
    watch("gate-set",
          f'<path d="M{C} {C} L{sx:.1f} {sy:.1f} A150 150 0 0 1 {ex:.1f} {ey:.1f} Z" fill="{BRASS}" opacity=".16"/>'
          f'<path d="M{sx:.1f} {sy:.1f} A150 150 0 0 1 {ex:.1f} {ey:.1f}" fill="none" stroke="{BRASS}" stroke-width="6" stroke-linecap="round"/>'
          f'<circle cx="{ex:.1f}" cy="{ey:.1f}" r="9" fill="{RUBY}" stroke="{BRASS_SOFT}" stroke-width="2"/>'
          + leaf_hand(C, C, 92, 40, 7) + leaf_hand(C, C, 128, 108, 5) + jewel(C, C, 7))
    # Pay: the movement turns; a coin leaves the train
    watch("gate-pay",
          gear(168, 222, 70, 22, 6) + gear(262, 154, 40, 13, 14, BRASS_SOFT, 3) +
          jewel(168, 222, 8) + jewel(262, 154, 6) +
          f'<path d="M108 132 A92 92 0 0 1 176 104" fill="none" stroke="{BRASS_SOFT}" stroke-width="3" stroke-dasharray="3 8" stroke-linecap="round"/>'
          f'<path d="M170 96 L182 104 L168 112" fill="none" stroke="{BRASS_SOFT}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>'
          + coin(294, 254, 22), dial=False)
    # Read: a watchmaker's loupe over the dial magnifies one jewel and the track
    lx, ly, lr = 206, 186, 80
    mag = []
    for i, a in enumerate(range(-150, -29, 12)):
        long = i % 3 == 0
        r1, r2 = 66, 66 - (18 if long else 9)
        mag.append(f'<line x1="{lx + r1 * math.cos(math.radians(a)):.1f}" y1="{ly + r1 * math.sin(math.radians(a)):.1f}" '
                   f'x2="{lx + r2 * math.cos(math.radians(a)):.1f}" y2="{ly + r2 * math.sin(math.radians(a)):.1f}" '
                   f'stroke="{BRASS_SOFT}" stroke-width="{4 if long else 2}" stroke-linecap="round"/>')
    watch("gate-check",
          leaf_hand(C, C, 86, 320, 6) + leaf_hand(C, C, 118, 70, 4) +
          f'<path d="M{lx + 40} {ly + 68} L{lx + 120} {ly + 160} L{lx + 168} {ly + 116} L{lx + 70} {ly + 40} Z" fill="url(#k)" stroke="{ROSE_DARK}" stroke-width="2" stroke-linejoin="round"/>'
          f'<circle cx="{lx}" cy="{ly}" r="{lr}" fill="#22385f"/>'
          + "".join(mag) + jewel(lx, ly + 8, 16) +
          f'<circle cx="{lx}" cy="{ly}" r="{lr}" fill="none" stroke="url(#k)" stroke-width="12"/>'
          f'<path d="M{lx - 50} {ly - 38} A62 62 0 0 1 {lx + 4} {ly - 62}" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="7" stroke-linecap="round"/>')
    # Sign: the caseback, a rose engine rosette with the hallmark seal at its centre
    watch("gate-sign",
          rosette(C, C, 46, 96) + f'<circle cx="{C}" cy="{C}" r="60" fill="url(#k)"/>'
          f'<circle cx="{C}" cy="{C}" r="50" fill="none" stroke="{ROSE_DARK}" stroke-width="2" stroke-dasharray="2 5"/>'
          + check(C, C + 2, 2.1, DEEP), dial=False)

    # Jobs: plates 400x300
    # Bound the spend: one watch, three registers (per payment, per day, float), each hand short of its ruby stop
    plate("job-cap", watch_group(196, 150, 116, subdial(196, 104, 30, 70, 120) + subdial(150, 168, 30, 150, 210) + subdial(242, 168, 30, 40, 100) + jewel(196, 150, 4), uid=""))
    # Let every rise show: a one hour bezel; the waiting hour is traced in rose gold before the hand may move on
    plate("job-wait", watch_group(196, 150, 116,
                                  arc(196, 150, 78, 0, 250, BRASS, 8) + arc(196, 150, 78, 250, 360, FAINT, 8, ' stroke-dasharray="2 9"') +
                                  leaf_hand(196, 150, 70, 250, 5) + leaf_hand(196, 150, 44, 20, 6) + jewel(196, 150, 5)))
    # Chart the path: a movement plate in perlage; the route runs only through the jewels it names
    perlage = "".join(f'<circle cx="{x}" cy="{y}" r="15" fill="none" stroke="{BRASS_SOFT}" stroke-opacity=".1"/>'
                      for y in range(20, 300, 22) for x in range(20 + (11 if (y // 22) % 2 else 0), 400, 22))
    route = [(72, 214), (134, 142), (206, 184), (268, 106), (334, 150)]
    path = " L".join(f"{x} {y}" for x, y in route)
    plate("job-route",
          f'<g clip-path="url(#p)">{perlage}</g>'
          f'<path d="M{path}" fill="none" stroke="{BRASS}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>'
          f'<path d="M{path}" fill="none" stroke="{BRASS_SOFT}" stroke-width="1.5" stroke-dasharray="2 7" stroke-linecap="round"/>'
          + "".join(jewel(x, y, 8) for x, y in route)
          + "".join(screw(x, y, 8, r) for x, y, r in [(108, 66, 20), (300, 238, 45), (184, 254, 70), (352, 58, 120)]))

    # Audiences and page heads
    # Operators: the agent's watch, its identity engraved on a cartouche under twelve
    watch("agent-tag",
          f'<rect x="132" y="96" width="136" height="50" rx="12" fill="url(#k)" stroke="{ROSE_DARK}" stroke-width="1.5"/>'
          + jewel(156, 121, 6) +
          f'<rect x="176" y="111" width="74" height="7" rx="3.5" fill="{DEEP}" opacity=".75"/><rect x="176" y="125" width="48" height="6" rx="3" fill="{DEEP}" opacity=".45"/>'
          + leaf_hand(C, C, 84, 215, 6) + leaf_hand(C, C, 118, 140, 4) + jewel(C, C, 7))
    # Merchants: the loupe over the hallmark of a caseback
    watch("signer-lookup",
          rosette(C, C, 46, 96, ".14") +
          loupe(188, 184, 78, f'<circle cx="188" cy="184" r="44" fill="url(#k)"/><circle cx="188" cy="184" r="36" fill="none" stroke="{ROSE_DARK}" stroke-width="2" stroke-dasharray="2 5"/>' + check(188, 186, 1.6, DEEP)),
          dial=False)
    # Credits: a stack of rose gold coins before the mainspring barrel's toothed wheel
    disc = lambda y: (f'<path d="M{C-70} {y} L{C-70} {y+15} A70 21 0 0 0 {C+70} {y+15} L{C+70} {y} Z" fill="{ROSE_DARK}"/>'
                      f'<ellipse cx="{C}" cy="{y}" rx="70" ry="21" fill="url(#k)" stroke="{ROSE_DARK}" stroke-width="1.5"/>'
                      f'<ellipse cx="{C}" cy="{y}" rx="52" ry="14" fill="none" stroke="#fff" stroke-opacity=".3"/>')
    watch("credits-pack",
          gear(C, 150, 104, 34, 4, "#2a3d63", 5) +
          "".join(disc(286 - i * 23) for i in range(5)) + jewel(C, 194, 7),
          dial=False)
    # Docs: the watchmaker's manual, a gear on one page and a dial on the other
    teeth = "".join(f'<line x1="{polar(144, 206, 30, d)[0]:.1f}" y1="{polar(144, 206, 30, d)[1]:.1f}" x2="{polar(144, 206, 37, d)[0]:.1f}" y2="{polar(144, 206, 37, d)[1]:.1f}"/>' for d in range(0, 360, 20))
    watch("docs-manual",
          f'<path d="M86 140 Q140 120 198 146 L198 282 Q140 258 86 278Z" fill="{BRASS_SOFT}"/>'
          f'<path d="M314 140 Q260 120 202 146 L202 282 Q260 258 314 278Z" fill="#f1e3da"/>'
          f'<g fill="none" stroke="{DEEP}" stroke-width="1.6" stroke-linecap="round"><circle cx="144" cy="206" r="30"/><circle cx="144" cy="206" r="9"/>{teeth}'
          f'<circle cx="258" cy="204" r="34"/><line x1="258" y1="204" x2="258" y2="180"/><line x1="258" y1="204" x2="276" y2="214"/></g>'
          f'<circle cx="258" cy="204" r="3.5" fill="{RUBY}"/>'
          f'<g stroke="{DEEP}" stroke-opacity=".35" stroke-width="1.5" stroke-linecap="round"><line x1="104" y1="256" x2="180" y2="262"/><line x1="220" y1="262" x2="296" y2="256"/></g>',
          dial=False)
    # Operator console: a power reserve, today's spend drawn toward the ruby stop of the daily cap
    watch("operator-console",
          arc(C, 186, 100, 240, 480, FAINT, 12) + arc(C, 186, 100, 240, 330, BRASS, 12) +
          f'<circle cx="{polar(C, 186, 100, 480)[0]:.1f}" cy="{polar(C, 186, 100, 480)[1]:.1f}" r="9" fill="{RUBY}" stroke="{BRASS_SOFT}" stroke-width="2"/>'
          + leaf_hand(C, 186, 92, 330, 6) + jewel(C, 186, 7) + subdial(C, 282, 26, 210))

    # Token pages
    # Burn: an hourglass; supply runs out of the top bulb for good
    watch("orry-burn",
          f'<rect x="138" y="94" width="124" height="14" rx="5" fill="url(#k)"/><rect x="138" y="292" width="124" height="14" rx="5" fill="url(#k)"/>'
          f'<g stroke="{BRASS}" stroke-width="5" stroke-linecap="round"><line x1="150" y1="108" x2="150" y2="292"/><line x1="250" y1="108" x2="250" y2="292"/></g>'
          f'<path d="M164 108 C164 168 196 188 196 200 C196 212 164 232 164 292 L236 292 C236 232 204 212 204 200 C204 188 236 168 236 108 Z" fill="#e9ecef" fill-opacity=".07" stroke="{BRASS_SOFT}" stroke-opacity=".6" stroke-width="2"/>'
          f'<path d="M176 150 Q200 162 224 150 C219 172 205 188 200 195 C195 188 181 172 176 150 Z" fill="{BRASS}"/>'
          f'<line x1="200" y1="196" x2="200" y2="262" stroke="{BRASS}" stroke-width="2.5" stroke-dasharray="4 4"/>'
          f'<path d="M170 292 Q200 244 230 292 Z" fill="{BRASS}"/>',
          dial=False)
    # Claim: two trains, Earn fees and Stake rewards, wind one barrel, the wallet
    watch("orry-claim",
          gear(140, 136, 40, 13, 8) + gear(260, 136, 40, 13, 20, BRASS_SOFT, 3) + jewel(140, 136, 5) + jewel(260, 136, 5) +
          f'<path d="M150 182 Q160 226 178 238" fill="none" stroke="{BRASS_SOFT}" stroke-width="3" stroke-dasharray="3 7" stroke-linecap="round"/>'
          f'<path d="M250 182 Q240 226 222 238" fill="none" stroke="{BRASS_SOFT}" stroke-width="3" stroke-dasharray="3 7" stroke-linecap="round"/>'
          f'<circle cx="{C}" cy="268" r="50" fill="url(#k)"/><circle cx="{C}" cy="268" r="40" fill="{DEEP}"/>'
          + spiral(C, 268, 7, 36, 3.2, BRASS_SOFT, 2.2) + jewel(C, 268, 5),
          dial=False)
    # Earn: the balance wheel beats, and swap fees arrive with every tick
    watch("orry-earn",
          f'<circle cx="{C}" cy="{C}" r="86" fill="none" stroke="url(#k)" stroke-width="12"/>'
          f'<g stroke="{BRASS}" stroke-width="5" stroke-linecap="round">'
          + "".join(f'<line x1="{C}" y1="{C}" x2="{polar(C, C, 82, d)[0]:.1f}" y2="{polar(C, C, 82, d)[1]:.1f}"/>' for d in (20, 140, 260)) + '</g>'
          + "".join(screw(*map(lambda v: round(v, 1), polar(C, C, 86, d)), 5, d) for d in (80, 200, 320))
          + spiral(C, C, 10, 58, 4.5, BRASS_SOFT, 1.6) + jewel(C, C, 7)
          + "".join(f'<g opacity="{o}"><circle cx="{polar(C, C, 130, d)[0]:.1f}" cy="{polar(C, C, 130, d)[1]:.1f}" r="11" fill="{BRASS_SOFT}" stroke="{BRASS}" stroke-width="2"/></g>'
                    for d, o in ((30, 1), (62, .8), (94, .6), (126, .4))),
          dial=False)
    # Leaderboard: three baton markers of the dial, the tallest set with a ruby
    bars = [(118, 92, ".55"), (182, 146, "1"), (246, 66, ".55")]
    watch("orry-leaderboard",
          "".join(f'<rect x="{x}" y="{282 - h}" width="36" height="{h}" rx="7" fill="url(#k)" opacity="{o}" stroke="{ROSE_DARK}" stroke-width="1.2"/>' for x, h, o in bars)
          + jewel(200, 112, 10) + f'<line x1="104" y1="284" x2="296" y2="284" stroke="{BRASS_SOFT}" stroke-opacity=".5" stroke-width="2"/>')
    # Stake: the mainspring wound in its barrel, held by the click on the ratchet wheel
    watch("orry-stake",
          f'<circle cx="{C}" cy="{C}" r="132" fill="none" stroke="url(#k)" stroke-width="14"/>'
          + spiral(C, C, 22, 116, 5.5, BRASS, 4) +
          f'<circle cx="{C}" cy="{C}" r="22" fill="url(#k)"/>' + jewel(C, C, 7)
          + gear(282, 104, 30, 16, 0, BRASS_SOFT, 3) +
          f'<path d="M318 140 L292 128" stroke="{STEEL}" stroke-width="7" stroke-linecap="round"/>' + screw(320, 142, 6, 60),
          dial=False)

    # Mark, "Orbit O": a cut serif O with one orbit crossing in front of it and a body on that orbit, on a navy tile.
    # Same drawing as components/Brand.tsx (its 40 unit box, scaled); concepts in design/mainspring/logo/.
    mark = "\n".join([
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96">',
        '<defs><mask id="g"><rect width="40" height="40" fill="#fff"/>'
        '<path d="M39 20A19 5.4 0 0 1 1 20" fill="none" stroke="#000" stroke-width="4" transform="rotate(-22 20 20)"/></mask></defs>',
        f'<rect width="96" height="96" rx="24" fill="{NIGHT}"/>',
        '<g transform="translate(14 14) scale(1.7)">',
        f'<path mask="url(#g)" fill="{BRASS}" fill-rule="evenodd" transform="rotate(-14 20 20)" '
        'd="M4.2 20a15.8 16.4 0 1 0 31.6 0a15.8 16.4 0 1 0-31.6 0ZM10.4 20a9.6 12.9 0 1 0 19.2 0a9.6 12.9 0 1 0-19.2 0Z"/>',
        f'<path d="M37.2 21.6A19 5.4 0 0 1 1 20" fill="none" stroke="{BRASS}" stroke-width="1.5" stroke-linecap="round" transform="rotate(-22 20 20)"/>',
        f'<circle cx="36.6" cy="12.9" r="2.6" fill="{BRASS}"/>',
        "</g>",
        "</svg>",
    ])
    (OUT / "mark.svg").write_text(mark)
    print("wrote", len(list(VEC.glob("*.svg"))), "vector drafts to", VEC, "and the mark to", OUT)


if __name__ == "__main__":
    build()
