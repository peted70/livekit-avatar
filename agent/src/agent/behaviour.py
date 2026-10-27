"""Behaviour stream: turns agent/room events into small JSON messages for avatar renderers.

Messages go out on a LiveKit text stream (topic ``avatar.behaviour``) to every participant.
See ../../../docs/behaviour-protocol.md for the wire format.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from collections.abc import AsyncIterable, Callable
from typing import Any

from livekit import rtc
from livekit.agents import AgentSession, llm

TOPIC = "avatar.behaviour"
PROTOCOL_VERSION = 1

EMOTIONS = ("neutral", "happy", "amused", "curious", "concerned", "surprised", "thinking")
GESTURES = ("nod", "shake", "open_palm", "beat", "point", "shrug")

logger = logging.getLogger("behaviour")


class BehaviourPublisher:
    def __init__(self, room: rtc.Room, session: AgentSession) -> None:
        self._room = room
        self._session = session
        self._gaze: str | None = None
        # Last human who spoke: who the agent is (probably) answering.
        self._addressee: str | None = None
        self._agent_state = "initializing"
        self._user_state = "listening"
        self._tasks: set[asyncio.Task[Any]] = set()

    def attach(self) -> None:
        self._session.on("agent_state_changed", self._on_agent_state)
        self._session.on("user_state_changed", self._on_user_state)
        self._room.on("active_speakers_changed", self._on_active_speakers)

    def send(self, type_: str, **fields: Any) -> None:
        msg = {"v": PROTOCOL_VERSION, "type": type_, "t": int(time.time() * 1000), **fields}
        logger.debug("behaviour %s", msg)
        task = asyncio.create_task(
            self._room.local_participant.send_text(json.dumps(msg), topic=TOPIC)
        )
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def _set_gaze(self, identity: str | None) -> None:
        if identity != self._gaze:
            self._gaze = identity
            self.send("gaze", target=identity)

    def _on_agent_state(self, ev: Any) -> None:
        old, new = ev.old_state, ev.new_state
        self._agent_state = new
        self.send("agent_state", state=new)
        # Agent stopped talking because the user started: a visible "oh, go on" moment.
        if old == "speaking" and self._user_state == "speaking":
            self.send("interrupted")
        if new == "speaking" and self._addressee:
            self._set_gaze(self._addressee)

    def _on_user_state(self, ev: Any) -> None:
        self._user_state = ev.new_state
        self.send("user_state", state=ev.new_state)

    def _on_active_speakers(self, speakers: list[rtc.Participant]) -> None:
        local = self._room.local_participant.identity
        humans = [p.identity for p in speakers if p.identity != local]
        if humans:
            # Speakers arrive loudest first; look at whoever is talking.
            self._addressee = humans[0]
            self._set_gaze(humans[0])


_TAG = re.compile(r"\[(emotion|gesture):([a-z_]+)(?:@([^\]\s]+))?\]")
_MAX_TAG_LEN = 48


class TagExtractor:
    """Strips ``[emotion:x]`` / ``[gesture:x@target]`` tags from streamed LLM text.

    Tags can be split across chunks, so text from an unmatched ``[`` is held back
    until the tag closes or grows too long to be one.
    """

    def __init__(self, on_tag: Callable[[str, str, str | None], None]) -> None:
        self._on_tag = on_tag
        self._buf = ""

    def feed(self, text: str) -> str:
        self._buf += text
        out = []
        while self._buf:
            start = self._buf.find("[")
            if start == -1:
                out.append(self._buf)
                self._buf = ""
                break
            out.append(self._buf[:start])
            self._buf = self._buf[start:]
            end = self._buf.find("]")
            if end == -1:
                if len(self._buf) > _MAX_TAG_LEN:
                    out.append(self._buf[0])
                    self._buf = self._buf[1:]
                    continue
                break  # wait for more text
            candidate = self._buf[: end + 1]
            self._buf = self._buf[end + 1 :]
            if m := _TAG.fullmatch(candidate):
                self._on_tag(m.group(1), m.group(2), m.group(3))
            else:
                out.append(candidate)
        return "".join(out)

    def flush(self) -> str:
        rest, self._buf = self._buf, ""
        return rest


async def strip_tags(
    stream: AsyncIterable[llm.ChatChunk | str | Any], publisher: BehaviourPublisher
) -> AsyncIterable[llm.ChatChunk | str | Any]:
    """Wraps an llm_node stream: publishes tags as behaviour messages, passes clean text on."""

    def on_tag(kind: str, name: str, target: str | None) -> None:
        if kind == "emotion" and name in EMOTIONS:
            publisher.send("emotion", name=name)
        elif kind == "gesture" and name in GESTURES:
            publisher.send("gesture", name=name, target=target)

    tags = TagExtractor(on_tag)
    async for chunk in stream:
        if isinstance(chunk, str):
            yield tags.feed(chunk)
        elif isinstance(chunk, llm.ChatChunk) and chunk.delta and chunk.delta.content:
            delta = chunk.delta.model_copy(update={"content": tags.feed(chunk.delta.content)})
            yield chunk.model_copy(update={"delta": delta})
        else:
            yield chunk
    if rest := tags.flush():
        yield rest
