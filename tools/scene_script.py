"""
Reads a scene script: front matter naming the cast, then one line of dialogue per line.

    ---
    title: The interview
    cast:
      host: { avatar: avatar.glb, voice: szjxFHBq49nokhN8LmLh }
      guest: { voice: CwhRBWXzGAHq8TQ4Fs17 }
    ---
    host: [emotion:curious] So what made you start building avatars? [gesture:open_palm]
    guest: [emotion:thinking] Honestly? [pause] I got tired of talking to text boxes.

[emotion:NAME] and [gesture:NAME] (or [gesture:point@CAST_ID]) are behaviour tags: they're taken
out of the text, and each remembers the character it sat in front of, so it can fire when that
character is spoken. Other bracket tags ([pause], [laughs]) stay in the text for ElevenLabs.
Blank lines are skipped. See docs/plans/scene-player.md.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from agent.behaviour import EMOTIONS, GESTURES

TAG = re.compile(r"\[(emotion|gesture):([^\]]*)\]")
SPEAKER = re.compile(r"^([A-Za-z_][\w-]*):\s*(.*)$")


class ScriptError(ValueError):
    pass


@dataclass
class CastMember:
    id: str
    voice: str
    avatar: str | None = None


@dataclass
class Tag:
    kind: str  # "emotion" or "gesture"
    name: str
    #: For [gesture:point@host]: who to point at.
    target: str | None
    #: Index into the line's text of the character the tag sits in front of (len(text) at the end).
    offset: int


@dataclass
class Line:
    #: Line number in the script file, for error messages.
    number: int
    speaker: str
    #: What the speaker says, behaviour tags removed, audio tags kept.
    text: str
    tags: list[Tag] = field(default_factory=list)


@dataclass
class Script:
    title: str
    cast: dict[str, CastMember]
    lines: list[Line]


def load(path: Path) -> Script:
    return parse(path.read_text(encoding="utf-8"))


def parse(source: str) -> Script:
    rows = source.splitlines()
    if not rows or rows[0].strip() != "---":
        raise ScriptError("line 1: a script starts with front matter between --- lines")
    try:
        end = next(i for i in range(1, len(rows)) if rows[i].strip() == "---")
    except StopIteration:
        raise ScriptError("the front matter has no closing --- line") from None

    meta = yaml.safe_load("\n".join(rows[1:end])) or {}
    cast = _cast(meta.get("cast"))
    lines = [
        _line(number, row, cast)
        for number, row in enumerate(rows[end + 1 :], start=end + 2)
        if row.strip()
    ]
    if not lines:
        raise ScriptError("the script has no lines")
    return Script(title=str(meta.get("title", "")), cast=cast, lines=lines)


def _cast(raw: object) -> dict[str, CastMember]:
    if not isinstance(raw, dict) or not raw:
        raise ScriptError("front matter: cast should map each cast id to { voice, avatar }")
    cast = {}
    for id_, info in raw.items():
        if not isinstance(info, dict) or not info.get("voice"):
            raise ScriptError(f"front matter: cast member {id_!r} needs a voice")
        cast[str(id_)] = CastMember(id=str(id_), voice=str(info["voice"]), avatar=info.get("avatar"))
    return cast


def _line(number: int, row: str, cast: dict[str, CastMember]) -> Line:
    m = SPEAKER.match(row.strip())
    if not m:
        raise ScriptError(f"line {number}: expected 'speaker: text'")
    speaker, body = m.groups()
    if speaker not in cast:
        raise ScriptError(f"line {number}: {speaker!r} isn't in the cast ({', '.join(cast)})")

    # Take the behaviour tags out, noting where each sat, then tidy the spaces they leave behind.
    text, tags, pos = "", [], 0
    for t in TAG.finditer(body):
        text += body[pos : t.start()]
        tags.append(_tag(number, t.group(1), t.group(2).strip(), len(text), speaker, cast))
        pos = t.end()
    text += body[pos:]
    text, where = _squash_spaces(text)
    for tag in tags:
        tag.offset = where[tag.offset]
    if not text:
        raise ScriptError(f"line {number}: {speaker} has nothing to say")
    return Line(number=number, speaker=speaker, text=text, tags=tags)


def _tag(number: int, kind: str, value: str, offset: int, speaker: str, cast: dict[str, CastMember]) -> Tag:
    name, _, target = value.partition("@")
    names = EMOTIONS if kind == "emotion" else GESTURES
    if name not in names:
        raise ScriptError(f"line {number}: unknown {kind} {name!r} (one of {', '.join(names)})")
    if target and (kind != "gesture" or name != "point"):
        raise ScriptError(f"line {number}: only [gesture:point@...] takes a target")
    if target and target not in cast:
        raise ScriptError(f"line {number}: can't point at {target!r}, who isn't in the cast")
    if target == speaker:
        raise ScriptError(f"line {number}: {speaker} can't point at themselves")
    return Tag(kind=kind, name=name, target=target or None, offset=offset)


def _squash_spaces(text: str) -> tuple[str, list[int]]:
    """Collapses runs of whitespace to one space and trims the ends. Also returns, for every
    index into `text` (and its end), the matching index into the result."""
    out, where = [], []
    for ch in text:
        where.append(len(out))
        if not ch.isspace():
            out.append(ch)
        elif out and out[-1] != " ":
            out.append(" ")
    where.append(len(out))
    if out and out[-1] == " ":
        out.pop()
        where = [min(w, len(out)) for w in where]
    return "".join(out), where
