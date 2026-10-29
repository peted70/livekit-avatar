"""
Spike for #1: does ElevenLabs return timings we can drive a scene from?

    uv run --project agent python tools/spike_timestamps.py [VOICE_ID] [MODEL ...]

Calls text-to-speech with timestamps on each model (default: eleven_v4, eleven_multilingual_v2)
with audio tags in the text, then prints the words with their start and end times and shows how
the audio tags appear in the alignment. Reads ELEVEN_API_KEY from agent/.env.local (never
printed). Uses a few hundred credits and writes tools/spike-<model>.mp3.
"""

import base64
import json
import sys
from pathlib import Path

from dotenv import dotenv_values

from check_elevenlabs import ROOT, request

DEFAULT_VOICE = "szjxFHBq49nokhN8LmLh"
DEFAULT_MODELS = ["eleven_v4", "eleven_multilingual_v2"]
TEXT = "So what made you start building avatars? [laughs] Honestly? [pause] I got tired of talking to text boxes."


def words(chars: list[str], starts: list[float], ends: list[float]) -> list[tuple[str, float, float]]:
    """Groups the character alignment into words, splitting on whitespace."""
    out, word, t0, t1 = [], "", 0.0, 0.0
    for ch, s, e in zip(chars, starts, ends):
        if ch.isspace():
            if word:
                out.append((word, t0, t1))
            word = ""
            continue
        if not word:
            t0 = s
        word, t1 = word + ch, e
    if word:
        out.append((word, t0, t1))
    return out


def main() -> None:
    key = dotenv_values(ROOT / "agent" / ".env.local").get("ELEVEN_API_KEY")
    if not key:
        sys.exit("ELEVEN_API_KEY isn't set in agent/.env.local")
    args = sys.argv[1:]
    voice = args.pop(0) if args else DEFAULT_VOICE
    models = args or DEFAULT_MODELS

    print(f"Text: {TEXT}\n")
    for model in models:
        res = json.loads(request(key, "POST", f"/text-to-speech/{voice}/with-timestamps", {"text": TEXT, "model_id": model}))
        audio = base64.b64decode(res["audio_base64"])
        out = ROOT / "tools" / f"spike-{model}.mp3"
        out.write_bytes(audio)
        print(f"== {model}: {len(audio) // 1024} KB -> {out.name}")
        for name in ("alignment", "normalized_alignment"):
            a = res.get(name)
            if not a:
                print(f"  {name}: none")
                continue
            chars = a["characters"]
            print(f"  {name}: {len(chars)} characters, text {'matches' if ''.join(chars) == TEXT else 'differs'}: {''.join(chars)!r}")
            if name == "alignment":
                for w, s, e in words(chars, a["character_start_times_seconds"], a["character_end_times_seconds"]):
                    print(f"    {s:6.2f}-{e:6.2f}  {w}")
        print()


if __name__ == "__main__":
    main()
