"""
Voices a scene script's lines with ElevenLabs, one mp3 per line, all at the same loudness.

    uv run --project agent python tools/scene_voice.py scenes/hello.md [--revoice N ...]

Each line is voiced with timestamps (per-character times, for the scene's timings) and cached by
a hash of its text, voice and model, so editing one line only re-voices that line. Delivery
varies between generations, so --revoice N voices script line N again until it lands.

Voices differ in level (a clone can come out 10 dB quieter than a library voice), so every line
is brought to the same loudness: TARGET_LUFS, or lower if some line can't get there without its
peaks passing PEAK_CEILING. Each line gets one fixed gain, which leaves the timing alone. Writes web/public/scenes/<name>/ (ignored by git). Reads ELEVEN_API_KEY
from agent/.env.local (never printed).
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from dotenv import dotenv_values

from check_elevenlabs import ROOT, request
from scene_script import Line, Script, load

MODEL = "eleven_v4"
TARGET_LUFS = -16.0
PEAK_CEILING = -1.0  # dBTP


@dataclass
class VoicedLine:
    line: Line
    #: The normalised audio, relative to the scene folder.
    audio: str
    duration: float
    #: ElevenLabs alignment: characters (matching line.text) with start and end seconds.
    alignment: dict
    loudness_before: float
    gain: float


def scene_dir(script_path: Path) -> Path:
    return ROOT / "web" / "public" / "scenes" / script_path.stem


def voice_scene(script: Script, out_dir: Path, key: str, revoice: set[int] = frozenset()) -> list[VoicedLine]:
    cache = out_dir / "cache"
    cache.mkdir(parents=True, exist_ok=True)
    takes = []
    for line in script.lines:
        voice = script.cast[line.speaker].voice
        raw, alignment = _voice(key, line.text, voice, cache, fresh=line.number in revoice)
        takes.append((line, raw, alignment, *measure(raw)))
    # The loudest level every line can reach with its peaks under the ceiling.
    level = min([TARGET_LUFS] + [loudness + PEAK_CEILING - peak for *_, loudness, peak in takes])

    voiced = []
    for i, (line, raw, alignment, loudness, _) in enumerate(takes, start=1):
        name = f"{i:03d}-{line.speaker}.mp3"
        _apply_gain(raw, out_dir / name, level - loudness)
        voiced.append(VoicedLine(line, name, _duration(out_dir / name), alignment, loudness, level - loudness))
    return voiced


def _voice(key: str, text: str, voice: str, cache: Path, fresh: bool) -> tuple[Path, dict]:
    """The raw ElevenLabs audio and alignment for one line, from the cache unless it's new or `fresh`."""
    digest = hashlib.sha256(json.dumps([text, voice, MODEL]).encode()).hexdigest()[:16]
    mp3, meta = cache / f"{digest}.mp3", cache / f"{digest}.json"
    if fresh or not (mp3.exists() and meta.exists()):
        res = json.loads(request(key, "POST", f"/text-to-speech/{voice}/with-timestamps", {"text": text, "model_id": MODEL}))
        alignment = res["alignment"]
        if "".join(alignment["characters"]) != text:
            sys.exit(f"ElevenLabs' alignment doesn't match the text of {text!r}")
        mp3.write_bytes(base64.b64decode(res["audio_base64"]))
        meta.write_text(json.dumps(alignment), encoding="utf-8")
    return mp3, json.loads(meta.read_text(encoding="utf-8"))


def measure(audio: Path) -> tuple[float, float]:
    """Integrated loudness (LUFS) and true peak (dBTP), from ffmpeg's loudnorm analysis."""
    out = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", str(audio), "-af", "loudnorm=print_format=json", "-f", "null", "-"],
        capture_output=True, text=True, check=True,
    ).stderr
    stats = json.loads(re.search(r'\{[^{}]*"input_i"[^{}]*\}', out).group())
    return float(stats["input_i"]), float(stats["input_tp"])


def _apply_gain(src: Path, dst: Path, gain: float) -> None:
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src), "-af", f"volume={gain:.2f}dB", "-b:a", "128k", str(dst)],
        check=True,
    )


def _duration(audio: Path) -> float:
    """Length in seconds; can run past the last spoken character (a breath, a trailing laugh)."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(audio)],
        capture_output=True, text=True, check=True,
    ).stdout
    return float(out)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("script", type=Path)
    parser.add_argument("--revoice", type=int, nargs="*", default=[], metavar="N", help="script line numbers to voice again")
    args = parser.parse_args()

    key = dotenv_values(ROOT / "agent" / ".env.local").get("ELEVEN_API_KEY")
    if not key:
        sys.exit("ELEVEN_API_KEY isn't set in agent/.env.local")
    out_dir = scene_dir(args.script)
    for v in voice_scene(load(args.script), out_dir, key, set(args.revoice)):
        after, _ = measure(out_dir / v.audio)
        print(f"line {v.line.number:<3} {v.line.speaker:<10} {v.duration:5.2f}s  {v.loudness_before:6.1f} -> {after:6.1f} LUFS ({v.gain:+.1f} dB)  {v.audio}")


if __name__ == "__main__":
    main()
