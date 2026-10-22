#!/usr/bin/env python3
"""Prepare real YouTube-card screenshots for the OCR benchmark.

The screenshots in the user's download folder show a YouTube card: the 16:9
thumbnail on top and the title/channel below it.  OCR in the extension only
sees the thumbnail, so we crop the top 16:9 area and discard the title.  Only
screenshots that contain the full thumbnail are usable.

The downloaded screenshots stay local (fixtures/ is git-ignored).  The
generated sources.json contains only video ids and provenance and can be
committed.
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

NAME_RE = re.compile(r"^(\d{6})_([A-Za-z0-9_-]{11})_(.+?)(?:_([a-z0-9-]+))?\.jpg$")


def font(size: int):
    for candidate in ("/System/Library/Fonts/Supplemental/Arial.ttf",
                      "/System/Library/Fonts/Helvetica.ttc"):
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            pass
    return ImageFont.load_default()


def main() -> None:
    here = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default="/Users/andriibashtoviy/Downloads/YouTube Blocker")
    ap.add_argument("--out", default=str(here / "fixtures"))
    args = ap.parse_args()

    source = Path(args.source)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    by_id: dict[str, list[dict]] = {}
    for path in sorted(source.rglob("*.jpg")):
        m = NAME_RE.match(path.name)
        if not m:
            continue
        stamp, video_id, kind, label = m.groups()
        with Image.open(path) as im:
            width, height = im.size
        thumb_height = round(width * 9 / 16)
        if height < thumb_height:
            continue
        item = {
            "videoId": video_id,
            "source": str(path.relative_to(source)),
            "kind": kind,
            "label": label or "",
            "timestamp": stamp,
            "width": width,
            "height": height,
            "thumbHeight": thumb_height,
        }
        by_id.setdefault(video_id, []).append(item)

    chosen: list[dict] = []
    for video_id, items in sorted(by_id.items()):
        # Prefer the widest screenshot; then the one with the least title noise.
        item = sorted(items, key=lambda x: (-x["width"], x["height"] - x["thumbHeight"]))[0]
        path = source / item["source"]
        with Image.open(path) as im:
            thumb = im.crop((0, 0, item["width"], item["thumbHeight"]))
            target = out / f"{video_id}.jpg"
            thumb.convert("RGB").save(target, "JPEG", quality=95)
        chosen.append({**item, "fixture": target.name})

    # Contact sheets: 5 columns, labels below each thumbnail.
    tile_w, thumb_h, label_h, gap = 320, 180, 34, 12
    cols = 5
    rows_per_sheet = 4
    per_sheet = cols * rows_per_sheet
    fnt = font(15)
    for sheet_index in range(0, len(chosen), per_sheet):
        batch = chosen[sheet_index:sheet_index + per_sheet]
        rows = (len(batch) + cols - 1) // cols
        sheet = Image.new("RGB", (cols * (tile_w + gap) + gap,
                                  rows * (thumb_h + label_h + gap) + gap), "white")
        draw = ImageDraw.Draw(sheet)
        for i, item in enumerate(batch):
            x = gap + (i % cols) * (tile_w + gap)
            y = gap + (i // cols) * (thumb_h + label_h + gap)
            with Image.open(out / item["fixture"]) as im:
                im = im.resize((tile_w, thumb_h), Image.LANCZOS)
                sheet.paste(im, (x, y))
            draw.text((x, y + thumb_h + 6), item["videoId"], fill="black", font=fnt)
        number = sheet_index // per_sheet + 1
        sheet.save(out / f"_contact-{number}.jpg", "JPEG", quality=90)

    (here / "sources.json").write_text(
        json.dumps({"source": str(source), "count": len(chosen), "items": chosen},
                   ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"{len(chosen)} unique thumbnails -> {out}")
    print(f"{len(chosen)} sources -> {here / 'sources.json'}")


if __name__ == "__main__":
    main()
