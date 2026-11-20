#!/usr/bin/env python3
"""Generate the WhatsApp Web brand assets.

The icon is a house-shaped chat bubble: Home Assistant's house silhouette plus
WhatsApp's speech-bubble tail and phone handset, on a Home Assistant-blue tile
with a WhatsApp-green handset disc.

Run from the repository root:
    python3 scripts/make_brand_assets.py
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "brand-source"
INTEGRATION_BRAND = ROOT / "custom_components" / "whatsapp_web" / "brand"
ADDON_DIR = ROOT / "whatsapp_bridge"
PHONE_SVG = SOURCE_DIR / "handset.svg"

GREEN = (37, 211, 102, 255)          # WhatsApp green
GREEN_DARK = (29, 168, 81, 255)
BLUE = (24, 188, 242, 255)           # Home Assistant blue
BLUE_DARK = (15, 155, 199, 255)
WHITE = (255, 255, 255, 255)

S = 4  # supersampling factor
BASE = 1024


def px(value: float) -> int:
    return int(round(value * S))


def load_handset(size: int) -> Image.Image | None:
    """Rasterise the phone glyph with rsvg-convert when it is available."""
    renderer = shutil.which("rsvg-convert")
    if not renderer or not PHONE_SVG.exists():
        return None
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "handset.png"
        subprocess.run(
            [
                renderer,
                "-w",
                str(size),
                "-h",
                str(size),
                str(PHONE_SVG),
                "-o",
                str(out),
            ],
            check=True,
            capture_output=True,
        )
        return Image.open(out).convert("RGBA").copy()


def draw_glyph(size: int = BASE * S) -> Image.Image:
    """Draw the white house/bubble glyph on transparency."""
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    # Roof (wide eaves, sharp peak).
    draw.polygon(
        [px(196), px(476), px(512), px(196), px(828), px(476)],
        fill=WHITE,
    )

    # House body, which also acts as the speech bubble.
    draw.rounded_rectangle(
        [px(300), px(430), px(724), px(760)],
        radius=px(96),
        fill=WHITE,
    )

    # Bubble tail at the bottom left.
    draw.polygon(
        [px(344), px(742), px(344), px(842), px(474), px(742)],
        fill=WHITE,
    )
    draw.ellipse(
        [px(326), px(824), px(362), px(860)],
        fill=WHITE,
    )

    # Blue disc in the middle of the house.
    draw.ellipse(
        [px(386), px(470), px(638), px(722)],
        fill=GREEN,
        outline=GREEN_DARK,
        width=px(5),
    )

    # WhatsApp-style phone handset inside the green disc.
    handset = load_handset(px(165))
    if handset is not None:
        image.alpha_composite(
            handset,
            (px(512) - handset.width // 2, px(596) - handset.height // 2),
        )
    else:
        for dot_x in (446, 512, 578):
            draw.ellipse(
                [px(dot_x - 23), px(573), px(dot_x + 23), px(619)],
                fill=WHITE,
            )

    return image


def draw_icon() -> Image.Image:
    """Draw the rounded-square app icon."""
    image = Image.new("RGBA", (BASE * S, BASE * S), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    draw.rounded_rectangle(
        [px(28), px(28), px(996), px(996)],
        radius=px(224),
        fill=BLUE,
        outline=BLUE_DARK,
        width=px(10),
    )

    glyph = draw_glyph()
    image.alpha_composite(glyph)
    return image


def draw_logo() -> Image.Image:
    """Draw a 500x200 green lockup with the glyph and a wordmark."""
    width, height = 500, 200
    image = Image.new("RGBA", (width * S, height * S), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    draw.rounded_rectangle(
        [0, 0, width * S - 1, height * S - 1],
        radius=28 * S,
        fill=BLUE,
        outline=BLUE_DARK,
        width=3 * S,
    )

    glyph = draw_glyph().crop(
        (px(180), px(180), px(844), px(932))
    )
    target_height = 150 * S
    target_width = round(glyph.width * target_height / glyph.height)
    glyph = glyph.resize((target_width, target_height), Image.Resampling.LANCZOS)
    image.alpha_composite(glyph, (18 * S, 25 * S))

    bold_path = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
    regular_path = "/System/Library/Fonts/Supplemental/Arial.ttf"
    try:
        title_font = ImageFont.truetype(bold_path, 46 * S)
        subtitle_font = ImageFont.truetype(regular_path, 26 * S)
    except OSError:
        title_font = ImageFont.load_default(size=46 * S)
        subtitle_font = ImageFont.load_default(size=26 * S)

    text_x = 190 * S
    draw.text((text_x, 44 * S), "WhatsApp", font=title_font, fill=WHITE)
    draw.text(
        (text_x + 2 * S, 112 * S),
        "for Home Assistant",
        font=subtitle_font,
        fill=(224, 247, 255, 235),
    )

    return image


def save(image: Image.Image, path: Path, size: tuple[int, int]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    resized = image.resize(size, Image.Resampling.LANCZOS)
    resized.save(path, format="PNG", optimize=True)
    print(f"wrote {path.relative_to(ROOT)} ({size[0]}x{size[1]})")


def main() -> None:
    icon = draw_icon()
    logo = draw_logo()

    save(icon, SOURCE_DIR / "icon-1024.png", (1024, 1024))
    save(icon, INTEGRATION_BRAND / "icon.png", (512, 512))
    save(icon, INTEGRATION_BRAND / "dark_icon.png", (512, 512))
    save(icon, ADDON_DIR / "icon.png", (256, 256))

    save(logo, SOURCE_DIR / "logo-500x200.png", (500, 200))
    save(logo, INTEGRATION_BRAND / "logo.png", (500, 200))
    save(logo, INTEGRATION_BRAND / "dark_logo.png", (500, 200))
    save(logo, ADDON_DIR / "logo.png", (250, 100))


if __name__ == "__main__":
    main()
