"""
Check an ElevenLabs API key before pointing the agent at it.

    uv run --project agent python tools/check_elevenlabs.py            # plan, cloning, voices
    uv run --project agent python tools/check_elevenlabs.py --say ID   # also speak a sentence

Reads ELEVEN_API_KEY from agent/.env.local (never printed). Speaking a sentence uses a few
dozen credits and writes tools/elevenlabs-sample.mp3.
"""

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

from dotenv import dotenv_values

API = "https://api.elevenlabs.io/v1"
ROOT = Path(__file__).resolve().parent.parent
SAMPLE_TEXT = "Hi, I'm your avatar. This is how I sound through ElevenLabs."


def request(key: str, method: str, path: str, body: dict | None = None) -> bytes:
    req = urllib.request.Request(
        f"{API}{path}",
        method=method,
        data=json.dumps(body).encode() if body else None,
        headers={"xi-api-key": key, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.read()
    except urllib.error.HTTPError as err:
        detail = err.read().decode(errors="replace")[:300]
        sys.exit(f"{method} {path} failed: HTTP {err.code} {detail}")


def main() -> None:
    key = dotenv_values(ROOT / "agent" / ".env.local").get("ELEVEN_API_KEY")
    if not key:
        sys.exit("ELEVEN_API_KEY isn't set in agent/.env.local")

    sub = json.loads(request(key, "GET", "/user/subscription"))
    print(f"Plan: {sub.get('tier')}  ({sub.get('character_count')}/{sub.get('character_limit')} credits used)")
    print(f"Instant Voice Cloning: {'yes' if sub.get('can_use_instant_voice_cloning') else 'no'}")
    print(f"Professional Voice Cloning: {'yes' if sub.get('can_use_professional_voice_cloning') else 'no'}")

    voices = json.loads(request(key, "GET", "/voices")).get("voices", [])
    print(f"\nVoices ({len(voices)}); clones first:")
    for v in sorted(voices, key=lambda v: v.get("category") != "cloned"):
        print(f"  {v['voice_id']}  {v.get('category', ''):<12} {v.get('name', '')}")

    if "--say" in sys.argv:
        voice_id = sys.argv[sys.argv.index("--say") + 1]
        audio = request(key, "POST", f"/text-to-speech/{voice_id}", {"text": SAMPLE_TEXT, "model_id": "eleven_flash_v2_5"})
        out = ROOT / "tools" / "elevenlabs-sample.mp3"
        out.write_bytes(audio)
        print(f"\nSaved {out} ({len(audio) // 1024} KB). Play it to hear the voice.")


if __name__ == "__main__":
    main()
