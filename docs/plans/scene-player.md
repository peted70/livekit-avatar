# Plan: multi-avatar scene player

Status: planned · Started 2026-10-29 · Tracked on the [Scene player board](https://github.com/users/peted70/projects/4) as issues labelled [scene-player](https://github.com/peted70/livekit-avatar/labels/scene-player)

## Goal

Several avatars act out a scripted scene: each line in its own voice, with emotions, gestures
and gaze, the camera cutting between them, and subtitles. The same scene can be replayed and
recorded, edited, and replayed again.

Generic by design: any cast and any script. The first scenes use two performers, but nothing
should assume two: the cast is a list, and every per-avatar thing (rig, behaviour, lip sync,
voice, captions, gaze) lives on a performer.

Comedy, interviews, rehearsal and role-play training are all just scripts.

## Non-goals for now

- Live improvisation between agents in a LiveKit room (stage 2, a separate plan).
- A script editor UI: scripts are text files you edit by hand.
- Rendering on a server. Scenes play in the browser; recording is a screen or canvas capture.

## How it fits together

```
script.md ──(tools/build_scene.py)──► scene.json + line audio (mp3)
  speakers, lines with           per line: audio file, word timings,
  [emotion]/[gesture] tags       tag events at the time they're spoken
                                                 │
                                   web: ?scene=<name>
                                                 ▼
               ScenePlayer: plays the lines in order, and at each moment sends
               BehaviourMsgs to the right performer, audio to its lip sync,
               words to the captions, and speaker changes to the camera
```

The key design choice is that **the scene player speaks the same `BehaviourMsg` protocol as the
live agent**. The avatars, camera and captions don't know whether they're driven by a live agent
or by a file. That keeps the live path working and means improvements to one benefit both.

### Script format (hand-written or LLM-generated)

```markdown
---
title: The interview
cast:
  host: { avatar: avatar.glb, voice: szjxFHBq49nokhN8LmLh }
  guest: { avatar: guest.glb, voice: <elevenlabs voice id> }
---
host: [emotion:curious] So what made you start building avatars? [gesture:open_palm]
guest: [emotion:thinking] Honestly? [pause] I got tired of talking to text boxes.
```

- `[emotion:…]` and `[gesture:…]` are the existing behaviour tags, placed where they should fire.
  `[gesture:point@host]` points at another performer, by their cast name.
- Other bracket tags (`[pause]`, `[laughs]`) pass through to ElevenLabs as v4 audio tags.

### Built scene (`web/public/scenes/<name>/scene.json`, generated)

Per line: speaker, audio file, duration, word timings (for captions) and behaviour events with
their times in seconds from the start of the line. Times come from ElevenLabs'
with-timestamps endpoint, which returns character-level alignment: a tag fires at the time of the
character it sits next to.

## Tasks

Each task should leave the live single-avatar demo working.

### Phase 0: spikes (answer the risky questions first)

- [ ] [#1](https://github.com/peted70/livekit-avatar/issues/1) **0.1 Timestamps with Eleven v4.** Call text-to-speech with timestamps on `eleven_v4` with
      an audio tag in the text. Check alignment comes back, and how audio tags show up in it.
      *Done when:* a short script prints per-word times. If v4 doesn't support it, fall back to
      `eleven_multilingual_v2` for scenes or estimate times from the text.
- [ ] [#2](https://github.com/peted70/livekit-avatar/issues/2) **0.2 Avatar per cast member.** Each cast member names its own `.glb`. For now every performer
      uses `avatar.glb`, so this is about the plumbing, not a new model; distinct avatars come later
      (see open decisions). *Done when:* two cast entries pointing at the same file load as two
      independent rigs (no shared skeleton, materials or morph state).

### Phase 1: more than one avatar on stage (web refactor, no new features)

- [ ] [#3](https://github.com/peted70/livekit-avatar/issues/3) **1.1 `Performer` class.** Bundle what main.ts currently has once: rig, `BehaviourController`,
      `LipSync`, and a position/facing on stage. main.ts creates one performer; behaviour is
      unchanged. *Done when:* the live demo works exactly as before.
- [ ] [#4](https://github.com/peted70/livekit-avatar/issues/4) **1.2 Stage layout.** Place N performers in an arc, angled towards each other and the camera
      (`?cast=2` to try it). *Done when:* 1, 2 and 3 performers all lay out sensibly.
- [ ] [#5](https://github.com/peted70/livekit-avatar/issues/5) **1.3 Gaze between performers.** Each performer's `GazeResolver` resolves any other
      performer's identity to the direction of their head, and live participants to seats as now.
      *Done when:* a `gaze` message naming another performer turns the head towards them.
- [ ] [#6](https://github.com/peted70/livekit-avatar/issues/6) **1.4 Per-performer debug triggers.** The test buttons target a chosen performer.

### Phase 2: building scenes from scripts (Python tool)

- [ ] [#7](https://github.com/peted70/livekit-avatar/issues/7) **2.1 Script parser.** Front matter plus `speaker: text` lines into a list of lines with
      tags and their character offsets. Unit tests.
- [ ] [#8](https://github.com/peted70/livekit-avatar/issues/8) **2.2 Voice each line.** ElevenLabs with timestamps, one mp3 per line, cached by a hash of
      text + voice + model so editing one line only re-voices that line.
- [ ] [#9](https://github.com/peted70/livekit-avatar/issues/9) **2.3 Timings.** Map tag offsets and words to times; write `scene.json`.
- [ ] [#10](https://github.com/peted70/livekit-avatar/issues/10) **2.4 Default behaviour.** Add events the script doesn't spell out: listeners look at the
      speaker, the speaker looks at whoever they're addressing (the previous speaker by default,
      glancing at the camera now and then), and
      `agent_state` speaking/listening for each performer.
- [ ] [#11](https://github.com/peted70/livekit-avatar/issues/11) **2.5 Command.** `uv run --project agent python tools/build_scene.py scenes/interview.md`.

### Phase 3: the scene player (web)

- [ ] [#12](https://github.com/peted70/livekit-avatar/issues/12) **3.1 Load and play.** `?scene=<name>` loads `scene.json`, plays the lines in order through
      one `AudioContext`, and schedules each line's events against the audio clock (not timers),
      so behaviour stays in sync if the tab stutters.
- [ ] [#13](https://github.com/peted70/livekit-avatar/issues/13) **3.2 Lip sync from file audio.** Route each line's audio into the speaking performer's
      `LipSync` (it takes a `MediaStreamTrack` today; add an `AudioNode` input).
- [ ] [#14](https://github.com/peted70/livekit-avatar/issues/14) **3.3 Captions.** Feed word timings into `Captions` per speaker, so subtitles track the audio
      exactly rather than arriving as text streams.
- [ ] [#15](https://github.com/peted70/livekit-avatar/issues/15) **3.4 Transport.** Play, pause, restart, jump to line N; a gap setting between lines.

### Phase 4: camera for a cast

- [ ] [#16](https://github.com/peted70/livekit-avatar/issues/16) **4.1 Shots relative to a performer.** `CameraDirector` shots take a subject: one
      performer, or a group framed together.
- [ ] [#17](https://github.com/peted70/livekit-avatar/issues/17) **4.2 Multi-person coverage.** Add group shots (two-shot, wide of everyone) and
      over-the-shoulder shots; cut to the speaker on line changes, with occasional reaction shots
      of a listener.
- [ ] [#18](https://github.com/peted70/livekit-avatar/issues/18) **4.3 Seeded randomness.** Idle motion, gestures and camera choices take a seed from the
      scene, so a replay looks the same. (Optional: replays already sound the same.)

### Phase 5: recording

- [ ] [#19](https://github.com/peted70/livekit-avatar/issues/19) **5.1 Record button.** Capture the canvas plus the scene audio with `MediaRecorder` to a
      `.webm` download; hide the debug panel while recording.
- [ ] [#20](https://github.com/peted70/livekit-avatar/issues/20) **5.2 Fixed output size.** A 1920×1080 render mode independent of the window size.

### Phase 6: writing scripts with an LLM (optional)

- [ ] [#21](https://github.com/peted70/livekit-avatar/issues/21) **6.1 Generate a script** from a premise and a character sheet per cast member, in the script format above.
      A comedy-improv runner drafted separately (not yet in the repo) could be a starting point.
- [ ] [#22](https://github.com/peted70/livekit-avatar/issues/22) **6.2 Takes.** Generate N versions, pick one, edit, build.

## Open decisions

- **Other characters' looks.** *Decided 2026-10-29:* use my avatar for every performer for now.
  Later options: another Ready Player Me-style avatar, a restyled copy of mine (different hair or
  clothes), or someone who agrees to be scanned. Not `brunette.glb`: its licence is non-commercial.
- **Other characters' voices.** An ElevenLabs library voice is simplest and makes my clone stand out.
- **Where scenes live.** Scripts in the repo (`scenes/`); built audio in `web/public/scenes/`,
  ignored by git like other generated media.
- **Deploying scenes.** Local-only to start; hosted playback can come later.

## Risks

- **Timestamp support on v4** (task 0.1). Without alignment, gestures and captions drift.
- **Audio-driven lip sync per performer.** One `AnalyserNode` per performer from file audio should be simple,
  but needs checking against the current live path.
- **Recording quality.** `MediaRecorder` can drop frames on a busy machine; OBS is the fallback.

## Change log

- 2026-10-29: first draft; tasks opened as issues #1–#22.
- 2026-10-29: same avatar for every performer for now; design for any number of performers, not two.
