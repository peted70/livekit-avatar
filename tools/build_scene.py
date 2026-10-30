"""
Builds a scene from a script: voices each line and writes scene.json for the web scene player.

    uv run --project agent python tools/build_scene.py scenes/hello.md [--revoice N ...]

Writes web/public/scenes/<name>/ (ignored by git): one mp3 per line and scene.json. Lines are
cached, so rebuilding after an edit only voices the lines that changed; --revoice N takes another
go at script line N. Reads ELEVEN_API_KEY from agent/.env.local (never printed).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from dotenv import dotenv_values

from check_elevenlabs import ROOT
from scene_script import ScriptError, load
from scene_timings import scene
from scene_voice import scene_dir, voice_scene


def describe(e: dict) -> str:
    """One event, briefly: "happy@0.00", or "guest gaze→pete@0.00" for someone else's."""
    msg = e["msg"]
    what = f"gaze→{msg['target'] or 'camera'}" if msg["type"] == "gaze" else msg["name"]
    who = f"{e['performer']} " if "performer" in e else ""
    return f"{who}{what}@{e['t']:.2f}"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("script", type=Path)
    parser.add_argument("--revoice", type=int, nargs="*", default=[], metavar="N", help="script line numbers to voice again")
    args = parser.parse_args()

    try:
        script = load(args.script)
    except ScriptError as err:
        sys.exit(f"{args.script}: {err}")
    key = dotenv_values(ROOT / "agent" / ".env.local").get("ELEVEN_API_KEY")
    if not key:
        sys.exit("ELEVEN_API_KEY isn't set in agent/.env.local")

    out_dir = scene_dir(args.script)
    built = scene(script, voice_scene(script, out_dir, key, set(args.revoice)))
    (out_dir / "scene.json").write_text(json.dumps(built, indent=1), encoding="utf-8")

    for line in built["lines"]:
        events = ", ".join(describe(e) for e in line["events"])
        print(f"line {line['number']:<3} {line['speaker']:<10} {line['duration']:5.2f}s  {events}")
    print(f"\nWrote {out_dir.relative_to(ROOT) / 'scene.json'}. Play it at http://localhost:5173/?scene={args.script.stem}")


if __name__ == "__main__":
    main()
