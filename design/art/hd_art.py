"""Turn the chosen HD photographs (design/mainspring/hd/<name>-<n>.webp, ElevenLabs flux-3-image, 1360x768, the picked variation only) into the
site's illustrations in services/packages/web/public/art:

- square views: the background-removed cutout (design/mainspring/hd/cutout/<name>.webp, ElevenLabs birefnet), trimmed
  to the object, centred on a transparent square with an even margin, 800x800 WebP with alpha, so the object floats
  on light and dark sections alike, like the hero orrery;
- plates (job-*): a centred 1024x768 crop, opaque WebP, rounded by the card's own CSS.

The pick per illustration is PICKS below (the variation number). Needs ImageMagick 7 (`magick`).
Run: python3 design/art/hd_art.py
"""
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "design/mainspring/hd"
OUT = ROOT / "services/packages/web/public/art"

PLATES = {"job-cap", "job-wait", "job-route"}
PICKS = {
    "gate-set": 2, "gate-pay": 1, "gate-check": 2, "gate-sign": 1,
    "job-cap": 1, "job-wait": 1, "job-route": 2,
    "agent-tag": 1, "signer-lookup": 1, "credits-pack": 1, "docs-manual": 2, "operator-console": 1,
    "orry-burn": 1, "orry-claim": 1, "orry-earn": 2, "orry-leaderboard": 2, "orry-stake": 1,
}


def run(*args):
    subprocess.run(["magick", *map(str, args)], check=True)


def build():
    for name, pick in PICKS.items():
        src = SRC / f"{name}-{pick}.webp"
        dst = OUT / f"{name}.webp"
        if name in PLATES:
            run(src, "-gravity", "center", "-crop", "1024x768+0+0", "+repage", "-quality", "84", "-define", "webp:method=6", dst)
            continue
        # Trim the cutout to the object, square it on transparency with an 8 percent margin, then 800x800.
        cut = SRC / "cutout" / f"{name}.webp"
        run(cut, "-trim", "+repage", "-background", "none", "-gravity", "center",
            "-resize", "736x736", "-extent", "800x800",
            "-quality", "88", "-define", "webp:method=6", "-define", "webp:alpha-quality=95", dst)
    print("wrote", len(PICKS), "illustrations to", OUT)


if __name__ == "__main__":
    build()
