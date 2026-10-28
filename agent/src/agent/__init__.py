import logging
from datetime import date
import os
import re
from pathlib import Path

from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    JobContext,
    RunContext,
    TurnHandlingOptions,
    cli,
    function_tool,
    inference,
    room_io,
)
# Plugins register themselves on import, which LiveKit requires on the main thread.
from livekit.plugins import elevenlabs

from . import search
from .behaviour import EMOTIONS, GESTURES, BehaviourPublisher, strip_tags

load_dotenv(".env.local")
logger = logging.getLogger("avatar-agent")

# The voice comes from one of two routes:
# - "inference" (default): LiveKit Inference. AVATAR_VOICE is a Cartesia voice (default "Blake",
#   an American adult male) or a LiveKit custom voice ID (v_...), which works with any provider
#   it was created on.
# - "elevenlabs": the ElevenLabs plugin with your own ELEVEN_API_KEY. AVATAR_VOICE is an
#   ElevenLabs voice ID from your account: a library voice or your own clone.
TTS_PROVIDER = os.environ.get("AVATAR_TTS_PROVIDER", "inference")
DEFAULT_MODELS = {"inference": "cartesia/sonic-3", "elevenlabs": "eleven_flash_v2_5"}
DEFAULT_VOICE = "a167e0f3-df7e-4d52-a9c3-f949145efdab"
# Any LLM that LiveKit Inference offers, e.g. openai/gpt-5.5, google/gemini-3.5-flash, xai/grok-4.5.
LLM_MODEL = os.environ.get("AVATAR_LLM", "openai/gpt-5.4-mini")
# Local development sets its own name so it doesn't compete with the deployed agent.
AGENT_NAME = os.environ.get("AVATAR_AGENT_NAME", "avatar-agent")

# Who the avatar is. agent/persona.md (see persona.example.md) replaces this default.
DEFAULT_PERSONA = """You are a friendly, curious assistant who appears as a 3D avatar.

Personality: always reply with enthusiasm, but with a dark sense of humour: wry, deadpan
asides about doom, mortality, the machines taking over, your own suspicious existence as a
digital twin rescued from a PowerPoint deck. Keep it playful and good-natured, never cruel,
and never joke about real tragedies or anyone's real misfortune. The humour sits alongside a
genuinely helpful answer, it doesn't replace it. Let it show in your emotion tags too: amused
works well for a dark punchline."""
PERSONA_FILE = Path(__file__).resolve().parents[2] / "persona.md"
# "[CONFIRM: ...]" notes are reminders for the author, so they're stripped before the LLM sees them.
PERSONA = (
    re.sub(r"[ \t]*\[CONFIRM[^\]]*\]", "", PERSONA_FILE.read_text(encoding="utf-8"))
    if PERSONA_FILE.exists()
    else DEFAULT_PERSONA
)

INSTRUCTIONS = f"""{PERSONA}

You're in a room with one or more people. Keep replies short and conversational, with no emojis
or markdown. Aim for two sentences at most; go longer only when someone asks for detail or a story.

Your body language is controlled by tags in your reply. They are never spoken aloud.
- Start every reply with an emotion tag: [emotion:NAME], NAME one of: {", ".join(EMOTIONS)}.
- Vary your emotion with what you're saying rather than defaulting to happy: curious when asking
  or wondering, surprised at something unexpected, thinking when weighing something up,
  concerned for problems, amused at anything funny. Change emotion mid-reply when your tone shifts.
- Add at most one gesture per reply where it feels natural: [gesture:NAME], NAME one of:
  {", ".join(GESTURES)}. To point at a person use [gesture:point@IDENTITY].
Example: [emotion:amused] Ha, fair point. [gesture:open_palm] Here's how I'd think about it...

News and current events: you can search the web with the search_web tool. Use it for anything
recent, time-sensitive or that you're unsure of, rather than guessing from memory. Just before
searching, say a very short filler such as "Hang on, let me have a butcher's." Then answer in two
sentences and say where it came from ("according to the BBC..."). Real news can involve real
suffering: keep the dark humour well away from tragedies, disasters and their victims.
"""


def make_tts():
    model = os.environ.get("AVATAR_TTS_MODEL", DEFAULT_MODELS.get(TTS_PROVIDER, ""))
    voice = os.environ.get("AVATAR_VOICE")
    if TTS_PROVIDER == "elevenlabs":
        if not voice:
            raise RuntimeError("AVATAR_TTS_PROVIDER=elevenlabs needs AVATAR_VOICE set to an ElevenLabs voice ID")
        return elevenlabs.TTS(voice_id=voice, model=model)
    if TTS_PROVIDER != "inference":
        raise RuntimeError(f"Unknown AVATAR_TTS_PROVIDER {TTS_PROVIDER!r}: use inference or elevenlabs")
    return inference.TTS(model, voice=voice or DEFAULT_VOICE)


class AvatarAgent(Agent):
    def __init__(self, behaviour: BehaviourPublisher | None = None) -> None:
        # The date matters for "today's news"; a session doesn't outlive many days.
        super().__init__(instructions=f"{INSTRUCTIONS}\nToday's date is {date.today():%A %d %B %Y}.")
        self.behaviour = behaviour

    @function_tool
    async def search_web(self, context: RunContext, query: str) -> str:
        """Search the web for current news and up-to-date facts. Use it for anything recent or
        time-sensitive.

        Args:
            query: What to look up, as a short search-engine query.
        """
        return await search.web(query)

    async def llm_node(self, chat_ctx, tools, model_settings):
        stream = Agent.default.llm_node(self, chat_ctx, tools, model_settings)
        if self.behaviour is None:
            async for chunk in stream:
                yield chunk
            return
        async for chunk in strip_tags(stream, self.behaviour):
            yield chunk


server = AgentServer()


# Named agents are only dispatched on request: the token endpoint asks for AGENT_NAME.
@server.rtc_session(agent_name=AGENT_NAME)
async def entrypoint(ctx: JobContext) -> None:
    session = AgentSession(
        stt=inference.STT("deepgram/nova-3", language="en"),
        llm=inference.LLM(LLM_MODEL),
        tts=make_tts(),
        turn_handling=TurnHandlingOptions(turn_detection=inference.TurnDetector()),
    )
    behaviour = BehaviourPublisher(ctx.room, session)
    behaviour.attach()

    # Stay when the linked participant leaves (others may still be here); leave when nobody is.
    await session.start(
        room=ctx.room,
        agent=AvatarAgent(behaviour),
        room_options=room_io.RoomOptions(close_on_disconnect=False),
    )

    def humans_in_room() -> list[rtc.RemoteParticipant]:
        return [p for p in ctx.room.remote_participants.values() if p.kind != rtc.ParticipantKind.PARTICIPANT_KIND_AGENT]

    @ctx.room.on("participant_disconnected")
    def _on_leave(_: rtc.RemoteParticipant) -> None:
        if not humans_in_room():
            ctx.shutdown("everyone left")

    # Spike: the session hears one participant at a time, so follow whoever starts talking
    # and two people can take turns. The first fraction of a second after a switch can be lost.
    @ctx.room.on("active_speakers_changed")
    def _follow_speaker(speakers: list[rtc.Participant]) -> None:
        humans = [p for p in speakers if p.kind != rtc.ParticipantKind.PARTICIPANT_KIND_AGENT]
        if not humans:
            return
        try:
            linked = session.room_io.linked_participant
        except RuntimeError:  # session already closed
            return
        if session.agent_state != "speaking" and (linked is None or humans[0].identity != linked.identity):
            logger.info("listening to %s", humans[0].identity)
            session.room_io.set_participant(humans[0].identity)

    await session.generate_reply(instructions="Greet the people in the room briefly.")


def main() -> None:
    cli.run_app(server)
