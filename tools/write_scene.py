"""
Writes a scene script with an LLM, from a brief: the cast (voices, avatars and who they are) and
a premise.

    uv run --project agent python tools/write_scene.py scenes/briefs/tech-news.md [-o scenes/x.md] [--force]

A brief looks like a script with a premise in place of the lines:

    ---
    title: Tech Corner
    lines: 14
    cast:
      pete: { avatar: avatar.glb, voice: szjxFHBq49nokhN8LmLh, character: The host. Cheerful... }
      roger: { voice: CwhRBWXzGAHq8TQ4Fs17, character: Co-host. Dry, sceptical... }
    ---
    A mock tech news segment: three made-up stories, the hosts teasing each other.

The model writes only the dialogue; the front matter comes from the brief, so voices and avatars
can't be garbled. The result goes through the script parser, and any mistake it finds goes back
to the model to fix. Uses LiveKit Inference with the agent's model (AVATAR_LLM) and keys, from
agent/.env.local. Writes scenes/<brief name>.md unless -o says otherwise.
"""

from __future__ import annotations

import argparse
import asyncio
import re
import sys
from dataclasses import dataclass
from pathlib import Path

import yaml
from dotenv import load_dotenv

from check_elevenlabs import ROOT
from scene_script import ScriptError, parse

load_dotenv(ROOT / "agent" / ".env.local")

from agent import LLM_MODEL  # noqa: E402  (after the env, so AVATAR_LLM applies)
from agent.behaviour import EMOTIONS, GESTURES  # noqa: E402

#: How many times a script the parser rejects goes back to the model.
FIX_ATTEMPTS = 2
AUDIO_TAGS = ["laughs", "chuckles", "sighs", "pause", "whispers", "excited", "sarcastic"]
DIALOGUE = re.compile(r"^\s*([A-Za-z_][\w-]*)\s*:\s*\S")


@dataclass
class Brief:
    title: str
    lines: int
    #: Cast id -> the brief's entry: voice, avatar, character.
    cast: dict[str, dict]
    premise: str


def load_brief(path: Path) -> Brief:
    text = path.read_text(encoding="utf-8")
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)$", text, re.S)
    if not m:
        raise ScriptError(f"{path}: a brief starts with front matter between --- lines")
    meta, premise = yaml.safe_load(m.group(1)) or {}, m.group(2).strip()
    cast = meta.get("cast")
    if not isinstance(cast, dict) or not cast:
        raise ScriptError(f"{path}: the brief needs a cast")
    if not premise:
        raise ScriptError(f"{path}: the brief needs a premise after the front matter")
    return Brief(title=str(meta.get("title", path.stem)), lines=int(meta.get("lines", 12)), cast=cast, premise=premise)


def prompt(brief: Brief) -> str:
    people = "\n".join(f"- {id_}: {info.get('character', '(no description)')}" for id_, info in brief.cast.items())
    first = next(iter(brief.cast))
    return f"""Write a short scripted scene for animated 3D avatars, voiced by text-to-speech.

Title: {brief.title}
Premise: {brief.premise}

Cast (use these ids exactly):
{people}

Write about {brief.lines} lines of dialogue, one per line, each as: id: text
Nothing else: no title, no stage directions, no blank commentary, no markdown.

Tags in the text drive the avatars and are never spoken:
- Start every line with an emotion: [emotion:NAME], NAME one of {", ".join(EMOTIONS)}.
  Change it mid-line if the tone shifts.
- Add a gesture to about half the lines, at most one per line, just before the word it should
  land on: [gesture:NAME], NAME one of {", ".join(GESTURES)}. To point at another cast member:
  [gesture:point@ID]. Nobody points at themselves.
- Voice tags change the delivery and can go anywhere: {", ".join(f"[{t}]" for t in AUDIO_TAGS)}.
  Use them sparingly.

Keep lines short and natural to say aloud, mostly under 25 words. Make it sound like people
talking to each other: reactions, interruptions, callbacks. Don't make claims about real people
or companies.

Example line: {first}: [emotion:curious] So what happened next? [gesture:open_palm] Go on."""


def dialogue(reply: str) -> list[str]:
    """The `id: text` lines of a reply, without code fences, headings or commentary."""
    return [row.strip() for row in reply.splitlines() if DIALOGUE.match(row) and not row.lstrip().startswith("#")]


def assemble(brief: Brief, lines: list[str]) -> str:
    """The script: front matter from the brief (minus the character notes), then the lines."""
    cast = {
        id_: {k: v for k, v in info.items() if k in ("avatar", "voice") and v is not None}
        for id_, info in brief.cast.items()
    }
    front = yaml.safe_dump({"title": brief.title, "cast": cast}, sort_keys=False, default_flow_style=None, width=200)
    return f"---\n{front}---\n" + "\n".join(lines) + "\n"


def describe(err: ScriptError, script: str) -> str:
    """The parser's complaint, quoting the line it's about (its line numbers count the front matter)."""
    m = re.match(r"line (\d+): (.*)", str(err))
    rows = script.splitlines()
    if m and 0 < int(m.group(1)) <= len(rows):
        return f"This line has a mistake ({m.group(2)}): {rows[int(m.group(1)) - 1]}"
    return f"The script has a mistake: {err}."


async def ask(messages: list[tuple[str, str]], model: str) -> str:
    """One chat completion through LiveKit Inference."""
    from livekit.agents import inference, llm
    from livekit.agents.utils import http_context

    http_context._ContextVar.set(http_context._new_session_ctx())
    try:
        ctx = llm.ChatContext()
        for role, content in messages:
            ctx.add_message(role=role, content=content)
        out = []
        async with inference.LLM(model).chat(chat_ctx=ctx) as stream:
            async for chunk in stream:
                if chunk.delta and chunk.delta.content:
                    out.append(chunk.delta.content)
        return "".join(out)
    finally:
        await http_context._close_http_ctx()


async def write(brief: Brief, model: str) -> str:
    messages = [("user", prompt(brief))]
    for attempt in range(FIX_ATTEMPTS + 1):
        reply = await ask(messages, model)
        script = assemble(brief, dialogue(reply))
        try:
            parse(script)
            return script
        except ScriptError as err:
            if attempt == FIX_ATTEMPTS:
                raise ScriptError(f"the model's script still has a mistake after {FIX_ATTEMPTS} fixes: {err}") from None
            print(f"  fixing: {err}", file=sys.stderr)
            messages += [("assistant", reply), ("user", f"{describe(err, script)} Reply with the whole corrected script, in the same format.")]
    raise AssertionError("unreachable")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("brief", type=Path)
    parser.add_argument("-o", "--out", type=Path, help="where to write the script (default scenes/<brief name>.md)")
    parser.add_argument("--force", action="store_true", help="replace the script if it exists")
    parser.add_argument("--model", default=LLM_MODEL, help=f"LiveKit Inference model (default {LLM_MODEL})")
    args = parser.parse_args()

    out = args.out or ROOT / "scenes" / f"{args.brief.stem}.md"
    if out.exists() and not args.force:
        sys.exit(f"{out} exists; pass --force to replace it, or -o for another name")
    try:
        script = asyncio.run(write(load_brief(args.brief), args.model))
    except ScriptError as err:
        sys.exit(str(err))
    out.write_text(script, encoding="utf-8")
    lines = parse(script).lines
    print(f"Wrote {out.relative_to(ROOT)}: {len(lines)} lines, {sum(len(l.text) for l in lines)} characters to voice.")
    print(f"Read it through, then: uv run --project agent python tools/build_scene.py {out.relative_to(ROOT).as_posix()}")


if __name__ == "__main__":
    main()
