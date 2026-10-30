"""
Turns a scene recording (.webm from the web Record button) into a 1920x1080 MP4 for sites
that want one, such as LinkedIn.

    uv run --project agent python tools/to_mp4.py ~/Downloads/tech-news.webm [-o out.mp4] [--size 1920x1080]

Scales the picture to exactly that size (the browser can only record at the window's size, and
won't scale up), re-encodes to H.264 and AAC, and writes a proper duration, which Chrome's WebM
leaves out. Needs ffmpeg on the PATH.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("webm", type=Path)
    parser.add_argument("-o", "--out", type=Path, help="default: next to the .webm, as .mp4")
    parser.add_argument("--size", default="1920x1080", help="WIDTHxHEIGHT (default 1920x1080)")
    args = parser.parse_args()

    if not args.webm.exists():
        sys.exit(f"{args.webm} doesn't exist")
    width, height = (int(n) for n in args.size.lower().split("x"))
    out = args.out or args.webm.with_suffix(".mp4")
    # Fit inside the size and pad any leftover with the stage colour, in case the window wasn't
    # quite 16:9; a constant 30 fps, since recordings have a variable frame rate.
    fit = (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease:flags=lanczos,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=0x15171f,setsar=1,fps=30"
    )
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(args.webm), "-vf", fit,
         "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(out)],
        check=True,
    )
    print(f"Wrote {out} ({width}x{height})")


if __name__ == "__main__":
    main()
