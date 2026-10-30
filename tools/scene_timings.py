"""
Turns voiced lines into a scene: word timings for the captions and behaviour events at the time
they're spoken, from ElevenLabs' per-character alignment, plus the gaze a conversation needs.
Writes nothing; see build_scene.py.
"""

from __future__ import annotations

import re
from typing import Any

from scene_script import Line, Script, Tag
from scene_voice import VoicedLine

AUDIO_TAG = re.compile(r"\s*\[[^\]]*\]")
#: A speaker glances at the camera once during lines at least this long (seconds)...
GLANCE_MIN_LINE = 4.0
#: ...for about this long.
GLANCE_LENGTH = 1.2


def caption_text(text: str) -> str:
    """What the captions show: the line without audio tags like [laughs]."""
    return " ".join(AUDIO_TAG.sub(" ", text).split())


def words(alignment: dict) -> list[dict[str, Any]]:
    """The spoken words with start and end seconds, leaving out audio tags (which take up time but
    aren't words)."""
    out: list[dict[str, Any]] = []
    word, start, end, depth = "", 0.0, 0.0, 0
    chars = alignment["characters"]
    for ch, s, e in zip(chars, alignment["character_start_times_seconds"], alignment["character_end_times_seconds"]):
        if ch == "[":
            depth += 1
        if depth or ch.isspace():
            if word:
                out.append({"text": word, "start": round(start, 3), "end": round(end, 3)})
                word = ""
            depth -= ch == "]" and depth > 0
            continue
        if not word:
            start = s
        word, end = word + ch, e
    if word:
        out.append({"text": word, "start": round(start, 3), "end": round(end, 3)})
    return out


def tag_time(alignment: dict, offset: int) -> float:
    """When a tag fires: as the character it sits in front of starts (skipping spaces), or as the
    last character ends for a tag at the end of the line."""
    chars, starts = alignment["characters"], alignment["character_start_times_seconds"]
    i = offset
    while i < len(chars) and chars[i].isspace():
        i += 1
    if i >= len(chars):
        return alignment["character_end_times_seconds"][-1] if chars else 0.0
    return starts[i]


def event(tag: Tag) -> dict[str, Any]:
    """The behaviour message a tag becomes, in the same shape the live agent sends."""
    if tag.kind == "emotion":
        return {"type": "emotion", "name": tag.name}
    return {"type": "gesture", "name": tag.name, "target": tag.target}


def scene_line(v: VoicedLine) -> dict[str, Any]:
    line: Line = v.line
    return {
        "number": line.number,
        "speaker": line.speaker,
        "text": caption_text(line.text),
        "audio": v.audio,
        "duration": round(v.duration, 3),
        "words": words(v.alignment),
        "events": [
            {"t": round(min(tag_time(v.alignment, t.offset), v.duration), 3), "msg": event(t)}
            for t in line.tags
        ],
    }


def addressee(speakers: list[str], i: int) -> str | None:
    """Who line i is said to: the last other person to speak, or for an opening line, the next."""
    me = speakers[i]
    earlier = [s for s in reversed(speakers[:i]) if s != me]
    later = [s for s in speakers[i + 1 :] if s != me]
    return (earlier or later or [None])[0]


def add_gaze(lines: list[dict[str, Any]], cast: list[str]) -> None:
    """Adds the gaze the script doesn't spell out: as a line starts, the listeners look at the
    speaker and the speaker at whoever they're answering; on longer lines the speaker glances at
    the camera partway through. Events for someone other than the speaker name their performer."""
    speakers = [l["speaker"] for l in lines]
    for i, line in enumerate(lines):
        me, to = line["speaker"], addressee(speakers, i)
        gaze = [{"t": 0.0, "msg": {"type": "gaze", "target": to}}]
        gaze += [{"t": 0.0, "performer": other, "msg": {"type": "gaze", "target": me}} for other in cast if other != me]
        glance = next((w["start"] for w in line["words"] if w["start"] >= 0.45 * line["duration"]), None)
        if to and line["duration"] >= GLANCE_MIN_LINE and glance is not None and glance + GLANCE_LENGTH < line["duration"] - 0.3:
            gaze.append({"t": glance, "msg": {"type": "gaze", "target": None}})
            gaze.append({"t": round(glance + GLANCE_LENGTH, 3), "msg": {"type": "gaze", "target": to}})
        # Gaze first at a shared time, so an emotion or gesture at 0 sees where they're looking.
        line["events"] = sorted(gaze + line["events"], key=lambda e: e["t"])


def scene(script: Script, voiced: list[VoicedLine]) -> dict[str, Any]:
    lines = [scene_line(v) for v in voiced]
    add_gaze(lines, list(script.cast))
    return {
        "version": 1,
        "title": script.title,
        "cast": [{"id": m.id, "avatar": m.avatar, "voice": m.voice} for m in script.cast.values()],
        "lines": lines,
    }
