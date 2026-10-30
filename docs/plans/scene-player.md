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

- [x] [#1](https://github.com/peted70/livekit-avatar/issues/1) **0.1 Timestamps with Eleven v4.** Call text-to-speech with timestamps on `eleven_v4` with
      an audio tag in the text. Check alignment comes back, and how audio tags show up in it.
      *Done when:* a short script prints per-word times. If v4 doesn't support it, fall back to
      `eleven_multilingual_v2` for scenes or estimate times from the text.
- [x] [#2](https://github.com/peted70/livekit-avatar/issues/2) **0.2 Avatar per cast member.** Each cast member names its own `.glb`. For now every performer
      uses `avatar.glb`, so this is about the plumbing, not a new model; distinct avatars come later
      (see open decisions). *Done when:* two cast entries pointing at the same file load as two
      independent rigs (no shared skeleton, materials or morph state).

### Phase 1: more than one avatar on stage (web refactor, no new features)

- [x] [#3](https://github.com/peted70/livekit-avatar/issues/3) **1.1 `Performer` class.** Bundle what main.ts currently has once: rig, `BehaviourController`,
      `LipSync`, and a position/facing on stage. main.ts creates one performer; behaviour is
      unchanged. *Done when:* the live demo works exactly as before.
- [x] [#4](https://github.com/peted70/livekit-avatar/issues/4) **1.2 Stage layout.** Place N performers in an arc, angled towards each other and the camera
      (`?cast=2` to try it). *Done when:* 1, 2 and 3 performers all lay out sensibly.
- [x] [#5](https://github.com/peted70/livekit-avatar/issues/5) **1.3 Gaze between performers.** Each performer's `GazeResolver` resolves any other
      performer's identity to the direction of their head, and live participants to seats as now.
      *Done when:* a `gaze` message naming another performer turns the head towards them.
- [ ] [#6](https://github.com/peted70/livekit-avatar/issues/6) **1.4 Per-performer debug triggers.** The test buttons target a chosen performer.

### Phase 2: building scenes from scripts (Python tool)

- [x] [#7](https://github.com/peted70/livekit-avatar/issues/7) **2.1 Script parser.** Front matter plus `speaker: text` lines into a list of lines with
      tags and their character offsets. Unit tests.
- [x] [#8](https://github.com/peted70/livekit-avatar/issues/8) **2.2 Voice each line.** ElevenLabs with timestamps, one mp3 per line, cached by a hash of
      text + voice + model so editing one line only re-voices that line. Normalise every line to
      the same loudness (about −16 LUFS), since voices differ: my clone comes out about 10 dB
      quieter than ElevenLabs' Roger. Delivery varies between generations (a `[laughs]` tag laughs
      one time and not the next), so a line can be re-voiced on its own until it lands.
      *Done when:* lines from different voices play back at the same perceived volume.
- [x] [#9](https://github.com/peted70/livekit-avatar/issues/9) **2.3 Timings.** Map tag offsets and words to times; write `scene.json`.
- [x] [#10](https://github.com/peted70/livekit-avatar/issues/10) **2.4 Default behaviour.** Add events the script doesn't spell out: listeners look at the
      speaker, the speaker looks at whoever they're addressing (the previous speaker by default,
      glancing at the camera now and then), and
      `agent_state` speaking/listening for each performer.
- [x] [#11](https://github.com/peted70/livekit-avatar/issues/11) **2.5 Command.** `uv run --project agent python tools/build_scene.py scenes/interview.md`.

### Phase 3: the scene player (web)

- [x] [#12](https://github.com/peted70/livekit-avatar/issues/12) **3.1 Load and play.** `?scene=<name>` loads `scene.json`, plays the lines in order through
      one `AudioContext`, and schedules each line's events against the audio clock (not timers),
      so behaviour stays in sync if the tab stutters.
- [x] [#13](https://github.com/peted70/livekit-avatar/issues/13) **3.2 Lip sync from file audio.** Route each line's audio into the speaking performer's
      `LipSync` (it takes a `MediaStreamTrack` today; add an `AudioNode` input).
- [x] [#14](https://github.com/peted70/livekit-avatar/issues/14) **3.3 Captions.** Feed word timings into `Captions` per speaker, so subtitles track the audio
      exactly rather than arriving as text streams.
- [ ] [#15](https://github.com/peted70/livekit-avatar/issues/15) **3.4 Transport.** Play, pause, restart, jump to line N; a gap setting between lines.

### Phase 4: camera for a cast

- [x] [#16](https://github.com/peted70/livekit-avatar/issues/16) **4.1 Shots relative to a performer.** `CameraDirector` shots take a subject: one
      performer, or a group framed together.
- [x] [#17](https://github.com/peted70/livekit-avatar/issues/17) **4.2 Multi-person coverage.** Add group shots (two-shot, wide of everyone) and
      over-the-shoulder shots; cut to the speaker on line changes, with occasional reaction shots
      of a listener.
- [ ] [#18](https://github.com/peted70/livekit-avatar/issues/18) **4.3 Seeded randomness.** Idle motion, gestures and camera choices take a seed from the
      scene, so a replay looks the same. (Optional: replays already sound the same.)

### Phase 5: recording

- [x] [#19](https://github.com/peted70/livekit-avatar/issues/19) **5.1 Record button.** Capture the canvas plus the scene audio with `MediaRecorder` to a
      `.webm` download; hide the debug panel while recording.
- [ ] [#20](https://github.com/peted70/livekit-avatar/issues/20) **5.2 Fixed output size.** A 1920×1080 render mode independent of the window size.

### Phase 6: writing scripts with an LLM (optional)

- [x] [#21](https://github.com/peted70/livekit-avatar/issues/21) **6.1 Generate a script** from a premise and a character sheet per cast member, in the script format above.
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

- ~~**Timestamp support on v4** (task 0.1).~~ Resolved: v4 returns character alignment that matches
  the input exactly, audio tags included (`tools/spike_timestamps.py`).
- **Audio-driven lip sync per performer.** One `AnalyserNode` per performer from file audio should be simple,
  but needs checking against the current live path.
- **Recording quality.** `MediaRecorder` can drop frames on a busy machine; OBS is the fallback.

## Change log

- 2026-10-29: first draft; tasks opened as issues #1–#22.
- 2026-10-29: same avatar for every performer for now; design for any number of performers, not two.
- 2026-10-29: #1 done. Eleven v4 with-timestamps gives per-character times; audio tags like
  `[laughs]` and `[pause]` keep their place in the alignment and take up their own time. My clone
  can laugh, but not every time, and is quieter than library voices (both now part of #8).
- 2026-10-29: #2 and #3 done. `Performer` (web/src/performer.ts) holds a rig, behaviour controller
  and lip sync; performers share one AudioContext. The glb rig now poses relative to its root
  (it worked in world space, so a moved or turned avatar would have snapped back to the origin's
  pose). Checked in a browser: two performers from one file share no objects, and one moved and
  turned 90° poses within 0.05° of one at the origin (90° off before the fix).
- 2026-10-30: #4 done. `?cast=n` puts n performers on a shallow arc (web/src/stage.ts), turned in
  towards each other, with an opening shot that frames them all. The camera director starts off
  with a cast, since its shots only frame the lead until #16.
- 2026-10-30: #5 done. Each performer resolves gaze for itself: another performer's id to their
  head, a live participant to their seat, anything else to a point out front at head height
  (exactly the old straight ahead for a performer at the origin). Seats are still angles from the
  performer's own facing, so a turned lead looks a little off from the name labels; only matters
  for a live session with a cast.
- 2026-10-30: #7 done. `tools/scene_script.py` parses a script into cast and lines; each behaviour
  tag keeps the index of the character it sat in front of, and audio tags stay in the text.
  Mistakes name the script line. Tests: `uv run --project agent pytest tools` (pytest and pyyaml
  are dev dependencies, so the agent image doesn't get them).
- 2026-10-30: #8 done. `tools/scene_voice.py` voices each line (cached by text, voice and model;
  `--revoice N` for another take) and gives every line one fixed gain to a shared level, so timings
  are untouched. The clone's raw audio is very quiet (−34 LUFS) with sharp peaks, so it can't reach
  −16 without clipping: the scene sits at the loudest level every line can reach (−21 for
  scenes/hello.md). Both voices sounded equal. A limiter could raise the level later.
- 2026-10-30: #9 and #11 done. `tools/build_scene.py` voices a script and writes
  `web/public/scenes/<name>/scene.json`: per line the audio, duration, caption text (audio tags
  left out), word timings, and behaviour events as the same messages the live agent sends, timed
  to the character each tag sat in front of and clamped to the audio's length (v4's alignment can
  run a little past it). Timings are tested in `tools/test_scene_timings.py`.
- 2026-10-30: #12 and #13 done. `?scene=<name>` takes the cast from scene.json; Play schedules
  every line on the AudioContext clock and sends each event when that clock reaches it (checked
  each frame). Line audio goes into the speaker's `LipSync.input`, which any audio node can feed.
  The speaker gets agent_state speaking/listening, the others user_state. Checked in a browser
  with scenes/hello.md: every cue within a frame of its time; the speaker's jaw opens (peak 0.97
  and 0.68) while the listener's stays shut. Also fixed: a switched-off camera director still
  changed the lens on its cuts.
- 2026-10-30: #10 and #14 done. The build adds gaze: as a line starts, listeners look at the
  speaker and the speaker at whoever they're answering (the last other speaker, or the next for an
  opening line); lines of 4s or more get a glance at the camera partway through. Those events name
  their performer. The agent_state and user_state around each line come from the player rather
  than the build. Captions: lines never overlap, so every performer uses the agent's animated
  caption lane, with a new segment and style per line, fed word by word from the word timings.
- 2026-10-30: #16 and #17 done. `CameraDirector` takes the cast and frames shots on a subject:
  the speaker (medium, close, angle; swung halfway round with their turn, for a three-quarter
  view), the group (the opening shot with a cast), over a listener's shoulder onto the speaker,
  or a listener reacting. With a cast it cuts to each new speaker, sometimes via the group shot,
  and to a listener's reaction when they react. With one performer the shots and cut rules are
  as before. The over-the-shoulder shot first sat too close: a listener turned to the speaker
  blocked them, so it now stands further back and out.
- 2026-10-30: #19 done. Record captures this tab (getDisplayMedia, this tab offered first), not
  the canvas, since the captions are HTML over it; the audio comes straight from the player's
  output, not the tab. The panel and cursor are hidden; it plays from the opening shot and saves
  `<scene>.webm` when the scene ends (or on Esc). Checked in Chrome with hello: VP9 + Opus at
  the window's size, captions in the picture, audio at the scene's level. Chrome's WebM has no
  duration in its header; `ffmpeg -i in.webm -c:v libx264 -crf 18 -c:a aac out.mp4` gives an
  MP4 for sites that want one.
- 2026-10-30: #21 done. `tools/write_scene.py` writes a script from a brief (`scenes/briefs/`:
  the cast with a character note each, a rough line count, and a premise) through LiveKit
  Inference with the agent's model and keys, so no new account. The model writes only the
  dialogue; the front matter comes from the brief. The result goes through the script parser,
  and a mistake goes back to the model quoting the line (the first real run invented an emotion,
  "dry", and fixed it). Output is a draft to edit before building.
