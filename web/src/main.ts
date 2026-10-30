import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Room, RoomEvent, Track, type Participant, type RemoteTrack } from 'livekit-client';
import { EMOTION_NAMES, GESTURE_NAMES, type BehaviourMsg, type Direction } from './behaviour';
import { Performer, type CastMember } from './performer';
import { Seats } from './seats';
import { stageMarks } from './stage';
import { ScenePlayer, loadScene } from './scenePlayer';
import { CameraDirector, groupFraming } from './camera';
import { CAPTION_STYLES, Captions, type Style } from './captions';

const TOPIC = 'avatar.behaviour';
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

// --- Scene ---------------------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
$('#stage').append(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x15171f);
scene.add(new THREE.HemisphereLight(0xdde6ff, 0x30262a, 1.6));
const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(0.8, 2.2, 1.6);
scene.add(key);

const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 20);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// The cast: everything per-avatar lives on a Performer. The live agent drives the first one.
// ?avatar=<file> (or simple) picks the avatar; by default web/public/avatar.glb or avatar.vrm.
// ?cast=<n> puts n of them on stage, for now all with the same avatar. ?scene=<name> takes the
// cast from a built scene (web/public/scenes/<name>/scene.json) and plays it instead.
const params = new URLSearchParams(location.search);
const sceneName = params.get('scene');
const built = sceneName ? await loadScene(sceneName).catch((err: Error) => (alert(err.message), null)) : null;
const castSize = Math.max(1, Math.min(6, Number(params.get('cast')) || 1));
const cast: CastMember[] = built
  ? built.scene.cast.map((m) => ({ id: m.id, avatar: params.get('avatar') ?? m.avatar ?? undefined }))
  : Array.from({ length: castSize }, (_, i) => ({
      id: i === 0 ? 'agent' : `performer-${i + 1}`,
      avatar: params.get('avatar') ?? undefined,
    }));
const audioContext = new AudioContext();
let seats: Seats;
const performers: Performer[] = await Promise.all(cast.map((m) => Performer.load(m, audioContext, (id) => gaze(m.id, id))));
const lead = performers[0];
stageMarks(performers.length).forEach((mark, i) => performers[i].place(mark.position, mark.yaw));
for (const p of performers) scene.add(p.root);
const head = lead.headPosition();
// Looking at nobody in particular means out front, towards the camera, at head height.
const front = new THREE.Vector3(0, head.y, 2.5);

/**
 * Where `self` should look for `target`: another performer's head, a live participant's seat
 * (set up once the lead's height is known), or out front.
 */
function gaze(self: string, target: string | null): Direction {
  const me = performers.find((p) => p.id === self)!;
  const other = performers.find((p) => p.id === target && p !== me);
  if (other) return me.directionTo(other.headPosition());
  return target && seats.has(target) ? seats.resolve(target) : me.directionTo(front);
}

// ?view=face frames a close-up of the face (lip sync, expressions); ?view=body the upper body (gestures).
const view = params.get('view');
resize();
if (performers.length > 1) frameGroup();
else if (view === 'face') {
  camera.position.set(head.x, head.y + 0.08, head.z + 0.75);
  controls.target.copy(head).add(new THREE.Vector3(0, 0.06, 0));
} else if (view === 'body') {
  camera.position.set(head.x, head.y - 0.35, head.z + 1.9);
  controls.target.copy(head).add(new THREE.Vector3(0, -0.45, 0));
} else {
  camera.position.set(head.x, head.y - 0.1, head.z + 1.6);
  controls.target.copy(head).add(new THREE.Vector3(0, -0.2, 0));
}

function resize() {
  const { clientWidth: w, clientHeight: h } = renderer.domElement.parentElement!;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

/** A wide shot of the whole cast. */
function frameGroup() {
  const { pos, target } = groupFraming(performers, camera.fov, camera.aspect);
  camera.position.copy(pos);
  controls.target.copy(target);
}

// --- Behaviour -------------------------------------------------------------------------

seats = new Seats(scene, head.y);
// TV-interview camera, following whoever is speaking; the fixed ?view= framings turn it off.
const director = new CameraDirector(camera, controls, performers);
director.enabled = !view;
$<HTMLInputElement>('#director-on').checked = director.enabled;

function receive(msg: BehaviourMsg, source: 'agent' | 'local', performer = lead) {
  performer.handle(msg);
  director.onMessage(msg, performer);
  if (msg.type === 'emotion') captions.setEmotion(msg.name);
  const { type, v, t, ...rest } = msg;
  const li = document.createElement('li');
  li.className = source;
  const who = performers.length > 1 ? `${performer.id} ` : '';
  li.innerHTML = `<b>${who}${type}</b> <span>${Object.values(rest).map(String).join(' ')}</span>`;
  const log = $('#log');
  log.prepend(li);
  while (log.children.length > 14) log.lastElementChild!.remove();
}

// Manual triggers, for testing renderers without an agent.
for (const name of EMOTION_NAMES) addButton('#emotions', name, () => receive({ type: 'emotion', name }, 'local'));
for (const name of GESTURE_NAMES) addButton('#gestures', name, () => receive({ type: 'gesture', name, target: null }, 'local'));
// With a cast, the others listen to the lead, and the lead can be turned to look at any of them.
for (const p of performers.slice(1)) {
  p.handle({ type: 'gaze', target: lead.id });
  addButton('#gestures', `look at ${p.id}`, () => receive({ type: 'gaze', target: p.id }, 'local'));
}
if (performers.length > 1) addButton('#gestures', 'look out front', () => receive({ type: 'gaze', target: null }, 'local'));
addButton('#gestures', 'interrupted', () => receive({ type: 'interrupted' }, 'local'));
// Plays web/public/voice-sample.wav (if present) through lip sync, as if the agent were talking.
addButton('#gestures', 'voice sample', async () => {
  await audioContext.resume();
  const audio = new Audio('/voice-sample.wav');
  await audio.play();
  const stream = (audio as HTMLAudioElement & { captureStream(): MediaStream }).captureStream();
  lead.lipsync.connect(stream.getAudioTracks()[0]);
  receive({ type: 'agent_state', state: 'speaking' }, 'local');
  audio.onended = () => {
    lead.lipsync.disconnect();
    receive({ type: 'agent_state', state: 'listening' }, 'local');
  };
});

function addButton(parent: string, label: string, onClick: () => void) {
  const b = document.createElement('button');
  b.textContent = label;
  b.onclick = onClick;
  $(parent).append(b);
}

// The A/B switch: with the stream off, the avatar only lip-syncs and idles.
$<HTMLInputElement>('#stream-on').onchange = (e) => {
  for (const p of performers) p.controller.enabled = (e.target as HTMLInputElement).checked;
};
$<HTMLInputElement>('#director-on').onchange = (e) => (director.enabled = (e.target as HTMLInputElement).checked);

// Live subtitles from the agent's transcriptions (lk.transcription): its own speech, in sync with
// the audio, and what you say. Each stream carries one segment's text, sent in pieces.
const captions = new Captions($('#captions'));
// ?captions=tiktok (or slam, teletype, bounce, blur) uses one style for every reply.
const captionStyle = params.get('captions') as Style | null;
if (captionStyle && CAPTION_STYLES.includes(captionStyle)) captions.fixedStyle = captionStyle;
// Previews the next style with a sample sentence, without needing the agent.
let demoStyle = 0;
addButton('#gestures', 'subtitle demo', () => {
  const style = captions.fixedStyle ?? CAPTION_STYLES[demoStyle++ % CAPTION_STYLES.length];
  const keep = captions.fixedStyle;
  captions.fixedStyle = style;
  const words = 'Blimey, a digital twin with my face and my voice, what could possibly go wrong?'.split(' ');
  const segment = `demo-${Date.now()}`;
  words.forEach((_, i) => setTimeout(() => captions.show('agent', segment, words.slice(0, i + 1).join(' ')), i * 260));
  setTimeout(() => (captions.fixedStyle = keep), 50);
});
$<HTMLInputElement>('#captions-on').onchange = (e) => {
  captions.enabled = (e.target as HTMLInputElement).checked;
  if (!captions.enabled) captions.clear();
};

// --- Scene ---------------------------------------------------------------------------------

// A built scene plays from its files; nothing joins a room.
let player: ScenePlayer | null = null;
if (built) {
  player = new ScenePlayer(built.scene, built.base, audioContext, new Map(performers.map((p) => [p.id, p])), (p, msg) =>
    receive(msg, 'agent', p),
  );
  $('#join').hidden = true;
  $('#scene-controls').hidden = false;
  setStatus(`loading "${built.scene.title || sceneName}"…`);
  await player.load();
  setStatus(`"${built.scene.title || sceneName}": ${built.scene.lines.length} lines`);
  const play = $<HTMLButtonElement>('#play');
  play.onclick = async () => {
    await audioContext.resume(); // needs the click's user gesture
    if (player!.playing) {
      player!.stop();
      play.textContent = 'Play scene';
    } else {
      player!.play();
      play.textContent = 'Stop';
    }
  };
  player.onEnd = () => (play.textContent = 'Play scene');
  // Lines never overlap, so every performer's words share the agent's caption style, a new
  // segment (and style) per line.
  player.onWords = (_line, i, text) => captions.show('agent', `scene-${i}`, text);
}

// --- LiveKit ---------------------------------------------------------------------------

const room = new Room({ adaptiveStream: true, dynacast: true });

room.registerTextStreamHandler('lk.transcription', async (reader, from) => {
  const speaker = from.identity === room.localParticipant.identity ? 'you' : 'agent';
  const segment = reader.info.attributes?.['lk.segment_id'] ?? reader.info.id;
  let text = '';
  for await (const chunk of reader) {
    text += chunk;
    captions.show(speaker, segment, text);
  }
});

room.registerTextStreamHandler(TOPIC, async (reader) => {
  try {
    receive(JSON.parse(await reader.readAll()) as BehaviourMsg, 'agent');
  } catch (err) {
    console.warn('Bad behaviour message', err);
  }
});

room
  .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, participant) => {
    if (track.kind !== Track.Kind.Audio) return;
    $('#audio').append(track.attach());
    if (participant.isAgent) lead.lipsync.connect(track.mediaStreamTrack);
  })
  .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _pub, participant) => {
    track.detach().forEach((el) => el.remove());
    if (participant.isAgent) lead.lipsync.disconnect();
  })
  .on(RoomEvent.ParticipantConnected, (p) => addPerson(p))
  .on(RoomEvent.ParticipantDisconnected, (p) => seats.remove(p.identity))
  .on(RoomEvent.Disconnected, () => {
    seats.clear();
    captions.clear();
    setStatus('disconnected');
    $('#join').hidden = false;
  });

function addPerson(p: Participant) {
  if (!p.isAgent) seats.add(p.identity, p.name ?? p.identity);
}

function setStatus(text: string) {
  $('#status').textContent = text;
}

$<HTMLFormElement>('#join').onsubmit = async (e) => {
  e.preventDefault();
  const roomName = $<HTMLInputElement>('#room').value.trim() || 'demo';
  const identity = $<HTMLInputElement>('#name').value.trim() || `guest-${Math.random().toString(36).slice(2, 6)}`;
  setStatus('connecting…');
  try {
    await audioContext.resume(); // needs the click's user gesture
    // The shared link carries the access key (?key=…) for hosted deployments.
    const key = params.get('key') ?? '';
    const res = await fetch(`/api/token?${new URLSearchParams({ room: roomName, identity, key })}`);
    if (!res.ok) throw new Error(await res.text());
    const { url, token } = await res.json();
    await room.connect(url, token);
    seats.localIdentity = room.localParticipant.identity;
    room.remoteParticipants.forEach(addPerson);
    await room.localParticipant.setMicrophoneEnabled(true);
    $('#join').hidden = true;
    setStatus(`in "${roomName}" as ${identity}, waiting for agent…`);
  } catch (err) {
    setStatus(`failed: ${err instanceof Error ? err.message : err}`);
  }
};

// --- Loop --------------------------------------------------------------------------------

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  player?.update();
  for (const p of performers) p.update(dt);
  controls.update();
  director.update(dt);
  renderer.render(scene, camera);

  const s = lead.controller.state;
  seats.highlight(s.gaze);
  if (room.state === 'connected') {
    const agent = [...room.remoteParticipants.values()].some((p) => p.isAgent);
    setStatus(agent ? `agent ${s.agent} · user ${s.user} · ${s.emotion} · looking at ${s.gaze ?? '—'}` : 'waiting for agent…');
  }
});
