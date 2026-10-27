import logging
import os

from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    JobContext,
    TurnHandlingOptions,
    cli,
    inference,
    room_io,
)

from .behaviour import EMOTIONS, GESTURES, BehaviourPublisher, strip_tags

load_dotenv(".env.local")
logger = logging.getLogger("avatar-agent")

# Cartesia "Blake" (American adult male). Set AVATAR_VOICE to a LiveKit custom voice ID (v_...)
# to use a cloned voice instead; clones work with any of the providers they were created on.
DEFAULT_VOICE = "a167e0f3-df7e-4d52-a9c3-f949145efdab"
TTS_MODEL = os.environ.get("AVATAR_TTS_MODEL", "cartesia/sonic-3")
VOICE = os.environ.get("AVATAR_VOICE", DEFAULT_VOICE)
# Local development sets its own name so it doesn't compete with the deployed agent.
AGENT_NAME = os.environ.get("AVATAR_AGENT_NAME", "avatar-agent")

INSTRUCTIONS = f"""You are a friendly, curious assistant who appears as a 3D avatar in a room
with one or more people. Keep replies short and conversational, with no emojis or markdown.

Your body language is controlled by tags in your reply. They are never spoken aloud.
- Start every reply with an emotion tag: [emotion:NAME], NAME one of: {", ".join(EMOTIONS)}.
- Vary your emotion with what you're saying rather than defaulting to happy: curious when asking
  or wondering, surprised at something unexpected, thinking when weighing something up,
  concerned for problems, amused at anything funny. Change emotion mid-reply when your tone shifts.
- Add at most one gesture per reply where it feels natural: [gesture:NAME], NAME one of:
  {", ".join(GESTURES)}. To point at a person use [gesture:point@IDENTITY].
Example: [emotion:amused] Ha, fair point. [gesture:open_palm] Here's how I'd think about it...
"""


class AvatarAgent(Agent):
    def __init__(self, behaviour: BehaviourPublisher | None = None) -> None:
        super().__init__(instructions=INSTRUCTIONS)
        self.behaviour = behaviour

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
        llm=inference.LLM("openai/gpt-5.4-mini"),
        tts=inference.TTS(TTS_MODEL, voice=VOICE),
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
