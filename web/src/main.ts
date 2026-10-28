import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Room, RoomEvent, Track, type Participant, type RemoteTrack } from 'livekit-client';
import { BehaviourController, EMOTION_NAMES, GESTURE_NAMES, type BehaviourMsg } from './behaviour';
import { createSimpleRig } from './avatar/simpleRig';
import { loadVrmRig } from './avatar/vrmRig';
import { loadGlbRig } from './avatar/glbRig';
import type { AvatarRig } from './avatar/types';
import { LipSync } from './lipsync';
import { Seats } from './seats';
import { CameraDirector } from './camera';
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

const rig = await loadRig();
scene.add(rig.root);
// ?view=face frames a close-up of the face (lip sync, expressions); ?view=body the upper body (gestures).
const view = new URLSearchParams(location.search).get('view');
if (view === 'face') {
  camera.position.set(0, rig.headPosition.y + 0.08, 0.75);
  controls.target.copy(rig.headPosition).add(new THREE.Vector3(0, 0.06, 0));
} else if (view === 'body') {
  camera.position.set(0, rig.headPosition.y - 0.35, 1.9);
  controls.target.copy(rig.headPosition).add(new THREE.Vector3(0, -0.45, 0));
} else {
  camera.position.set(0, rig.headPosition.y - 0.1, 1.6);
  controls.target.copy(rig.headPosition).add(new THREE.Vector3(0, -0.2, 0));
}

function resize() {
  const { clientWidth: w, clientHeight: h } = renderer.domElement.parentElement!;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

/** Uses web/public/avatar.glb or avatar.vrm when present, otherwise the built-in figure. */
async function loadRig(): Promise<AvatarRig> {
  if (new URLSearchParams(location.search).get('avatar') === 'simple') return createSimpleRig();
  const loaders: [string, (url: string) => Promise<AvatarRig>][] = [
    ['/avatar.glb', loadGlbRig],
    ['/avatar.vrm', loadVrmRig],
  ];
  for (const [url, load] of loaders) {
    const head = await fetch(url, { method: 'HEAD' }).catch(() => null);
    // Vite answers unknown paths with index.html, so check it's not HTML.
    if (!head?.ok || head.headers.get('content-type')?.includes('text/html')) continue;
    try {
      return await load(url);
    } catch (err) {
      console.warn(`Failed to load ${url}`, err);
    }
  }
  return createSimpleRig();
}

// --- Behaviour -------------------------------------------------------------------------

const seats = new Seats(scene, rig.headPosition.y);
const controller = new BehaviourController(seats.resolve);
// TV-interview camera; the fixed ?view= framings turn it off.
const director = new CameraDirector(camera, controls, rig.headPosition);
director.enabled = !view;
$<HTMLInputElement>('#director-on').checked = director.enabled;
const lipsync = new LipSync();

function receive(msg: BehaviourMsg, source: 'agent' | 'local') {
  controller.handle(msg);
  director.onMessage(msg);
  if (msg.type === 'emotion') captions.setEmotion(msg.name);
  const { type, v, t, ...rest } = msg;
  const li = document.createElement('li');
  li.className = source;
  li.innerHTML = `<b>${type}</b> <span>${Object.values(rest).map(String).join(' ')}</span>`;
  const log = $('#log');
  log.prepend(li);
  while (log.children.length > 14) log.lastElementChild!.remove();
}

// Manual triggers, for testing renderers without an agent.
for (const name of EMOTION_NAMES) addButton('#emotions', name, () => receive({ type: 'emotion', name }, 'local'));
for (const name of GESTURE_NAMES) addButton('#gestures', name, () => receive({ type: 'gesture', name, target: null }, 'local'));
addButton('#gestures', 'interrupted', () => receive({ type: 'interrupted' }, 'local'));
// Plays web/public/voice-sample.wav (if present) through lip sync, as if the agent were talking.
addButton('#gestures', 'voice sample', async () => {
  await lipsync.resume();
  const audio = new Audio('/voice-sample.wav');
  await audio.play();
  const stream = (audio as HTMLAudioElement & { captureStream(): MediaStream }).captureStream();
  lipsync.connect(stream.getAudioTracks()[0]);
  receive({ type: 'agent_state', state: 'speaking' }, 'local');
  audio.onended = () => {
    lipsync.disconnect();
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
$<HTMLInputElement>('#stream-on').onchange = (e) => (controller.enabled = (e.target as HTMLInputElement).checked);
$<HTMLInputElement>('#director-on').onchange = (e) => (director.enabled = (e.target as HTMLInputElement).checked);

// Live subtitles from the agent's transcriptions (lk.transcription): its own speech, in sync with
// the audio, and what you say. Each stream carries one segment's text, sent in pieces.
const captions = new Captions($('#captions'));
// ?captions=tiktok (or slam, teletype, bounce, blur) uses one style for every reply.
const captionStyle = new URLSearchParams(location.search).get('captions') as Style | null;
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
    if (participant.isAgent) lipsync.connect(track.mediaStreamTrack);
  })
  .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _pub, participant) => {
    track.detach().forEach((el) => el.remove());
    if (participant.isAgent) lipsync.disconnect();
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
    await lipsync.resume(); // needs the click's user gesture
    // The shared link carries the access key (?key=…) for hosted deployments.
    const key = new URLSearchParams(location.search).get('key') ?? '';
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
  const { face, body } = controller.update(dt, lipsync.sample(dt));
  rig.apply(face, body);
  rig.update(dt);
  controls.update();
  director.update(dt);
  renderer.render(scene, camera);

  const s = controller.state;
  seats.highlight(s.gaze);
  if (room.state === 'connected') {
    const agent = [...room.remoteParticipants.values()].some((p) => p.isAgent);
    setStatus(agent ? `agent ${s.agent} · user ${s.user} · ${s.emotion} · looking at ${s.gaze ?? '—'}` : 'waiting for agent…');
  }
});
