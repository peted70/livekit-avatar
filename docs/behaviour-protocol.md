# Behaviour protocol (v1)

The agent publishes JSON messages on the LiveKit text stream topic `avatar.behaviour`,
sent to every participant in the room. Renderers listen with
`room.registerTextStreamHandler("avatar.behaviour", ...)`.

Every message has:

| Field  | Type   | Meaning                                  |
|--------|--------|------------------------------------------|
| `v`    | int    | Protocol version (1)                     |
| `type` | string | Message type, below                      |
| `t`    | int    | Agent wall-clock time, ms since epoch    |

## Types

| `type`        | Fields                          | Renderer should                                        |
|---------------|---------------------------------|--------------------------------------------------------|
| `agent_state` | `state`: initializing, idle, listening, thinking, speaking | thinking: glance away; listening: attentive posture |
| `user_state`  | `state`: speaking, listening, away | speaking: occasional nods / back-channel expressions |
| `gaze`        | `target`: participant identity or null | turn eyes/head toward that participant (resolved locally) |
| `emotion`     | `name`: neutral, happy, amused, curious, concerned, surprised, thinking | blend face to that expression |
| `gesture`     | `name`: nod, shake, open_palm, beat, point, shrug; `target`: identity or null | play the clip (aim it at `target` if set) |
| `interrupted` | none                            | brows up, cut the current gesture, turn to listen      |

Gaze targets are identities, not coordinates. Each device decides what "look at B" means:
at the local viewer's camera/headset if B is them, otherwise toward B's tile or avatar.

Lip sync is not in this stream; renderers derive it from the agent's audio track.
