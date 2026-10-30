import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { BehaviourMsg } from './behaviour';
import type { Performer } from './performer';

/** A camera position and look target relative to a performer's head, plus a lens. */
interface Shot {
  pos: [number, number, number];
  target: [number, number, number];
  fov: number;
  /** How far the camera creeps towards the target over a shot (metres), like a slow dolly. */
  push: number;
}

/** Shots of one performer. */
type SoloShot = 'wide' | 'medium' | 'close' | 'angle';
/**
 * With a cast, also: everyone together, over a listener's shoulder onto the speaker, and a
 * listener reacting.
 */
type ShotName = SoloShot | 'group' | 'ots' | 'reaction';

const SHOTS: Record<SoloShot, Shot> = {
  wide: { pos: [0, -0.3, 1.75], target: [0, -0.38, 0], fov: 35, push: 0.12 },
  medium: { pos: [0.12, -0.1, 1.35], target: [0, -0.18, 0], fov: 32, push: 0.08 },
  close: { pos: [0.05, 0.03, 0.75], target: [0, 0.02, 0], fov: 28, push: 0.04 },
  angle: { pos: [-0.55, -0.08, 1.2], target: [0, -0.15, 0], fov: 32, push: 0.06 },
};
const GROUP_FOV = 35;
const OTS_FOV = 30;

const BIG_GESTURES = new Set(['shrug', 'open_palm', 'point']);
const UP = new THREE.Vector3(0, 1, 0);
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const smoothstep = (x: number) => x * x * (3 - 2 * x);

/**
 * A wide shot of the whole cast: centred on their heads and far enough back to fit them all
 * across at this lens.
 */
export function groupFraming(performers: Performer[], fov: number, aspect: number): { pos: THREE.Vector3; target: THREE.Vector3 } {
  const heads = performers.map((p) => p.headPosition());
  const centre = heads.reduce((sum, h) => sum.add(h), new THREE.Vector3()).divideScalar(heads.length);
  const xs = heads.map((h) => h.x);
  const halfWidth = (Math.max(...xs) - Math.min(...xs)) / 2 + 0.6;
  const halfFov = Math.atan(Math.tan(THREE.MathUtils.degToRad(fov) / 2) * aspect);
  const front = Math.max(...heads.map((h) => h.z));
  return {
    pos: new THREE.Vector3(centre.x, centre.y - 0.15, front + Math.max(2.4, halfWidth / Math.tan(halfFov))),
    target: centre.clone().add(new THREE.Vector3(0, -0.4, 0)),
  };
}

/**
 * A TV-interview style camera: holds a shot with a slow push-in and a little handheld drift,
 * and cuts between shots now and then, and on moments in the conversation (someone starting
 * to talk, a big gesture, a strong emotion). With a cast it follows whoever is speaking, and
 * mixes in group, over-the-shoulder and reaction shots. Dragging the camera pauses it for a while.
 */
export class CameraDirector {
  enabled = true;

  private time = 0;
  private shot: ShotName = 'medium';
  /** Who the shot is of: the speaker, or the listener in a reaction shot. */
  private subject: Performer;
  /** The current (or last) speaker. */
  private speaker: Performer;
  /** The listener whose shoulder an over-the-shoulder shot is from. */
  private shoulder: Performer;
  /** The framing a reaction shot uses. */
  private reactionShot: SoloShot = 'medium';
  private shotStart = 0;
  private nextCut = rand(5, 10);
  private lastCut = -Infinity;
  private pausedUntil = 0;
  private wasSpeaking = false;
  private _pos = new THREE.Vector3();
  private _target = new THREE.Vector3();

  constructor(
    private camera: THREE.PerspectiveCamera,
    private controls: OrbitControls,
    private performers: Performer[],
  ) {
    this.subject = this.speaker = this.shoulder = performers[0];
    // Taking the camera by hand pauses the director, so you can look around.
    controls.addEventListener('start', () => (this.pausedUntil = this.time + 15));
    this.cut(this.cast ? 'group' : 'medium');
  }

  private get cast(): boolean {
    return this.performers.length > 1;
  }

  /**
   * Cuts on conversational moments, read from the same behaviour messages the avatars get.
   * `from` is the performer the message was for.
   */
  onMessage(msg: BehaviourMsg, from: Performer = this.performers[0]): void {
    // A cut changes the lens, so a switched-off director mustn't cut.
    if (!this.enabled) return;
    const since = this.time - this.lastCut;
    switch (msg.type) {
      case 'agent_state': {
        const speaking = msg.state === 'speaking';
        if (this.cast) {
          // A new speaker: go to them, now and then via the group shot.
          if (speaking && from !== this.speaker) {
            this.speaker = from;
            this.cut(Math.random() < 0.2 ? 'group' : this.pick(['medium', 'close', 'ots']));
          } else if (speaking && since > 2 && Math.random() < 0.5) {
            this.cut(this.pick(['medium', 'close', 'angle', 'ots']));
          }
          break;
        }
        if (speaking && !this.wasSpeaking && since > 2) this.cut(this.pick(['medium', 'close', 'angle']));
        this.wasSpeaking = speaking;
        break;
      }
      case 'gesture':
        // Hands need room: go wider if we're in tight on whoever is gesturing.
        if (BIG_GESTURES.has(msg.name) && this.shot === 'close' && from === this.subject) {
          this.cut(this.pick(this.cast ? ['medium', 'group'] : ['wide', 'medium']));
        }
        break;
      case 'emotion':
        if ((msg.name === 'surprised' || msg.name === 'amused') && since > 2.5 && Math.random() < 0.35) {
          if (from !== this.speaker) this.cut('reaction', from);
          else this.cut('close');
        }
        break;
      case 'user_state':
        // In a scene every listener gets this; only a live person speaking matters here.
        if (!this.cast && msg.state === 'speaking' && since > 3 && Math.random() < 0.5) this.cut(this.pick(['wide', 'angle']));
        break;
    }
  }

  update(dt: number): void {
    const t = (this.time += dt);
    if (!this.enabled || t < this.pausedUntil) return;
    if (t > this.nextCut) {
      if (this.cast && Math.random() < 0.25) this.cut('reaction');
      else this.cut(this.pick(this.cast ? ['group', 'medium', 'close', 'angle', 'ots'] : ['wide', 'medium', 'close', 'angle']));
    }

    const push = this.frame(this._pos, this._target);
    const p = smoothstep(Math.min(1, (t - this.shotStart) / 12));
    // Slow push-in along the line of sight, then a faint handheld drift.
    this._pos.addScaledVector(this._target.clone().sub(this._pos).normalize(), push * p);
    this._pos.x += 0.006 * Math.sin(t * 0.7) + 0.003 * Math.sin(t * 1.9 + 1);
    this._pos.y += 0.004 * Math.sin(t * 0.53 + 2);
    this._target.x += 0.002 * Math.sin(t * 0.61 + 3);

    this.camera.position.copy(this._pos);
    this.controls.target.copy(this._target);
    this.camera.lookAt(this._target);
  }

  /** Sets where the current shot puts the camera and what it looks at; returns its push-in. */
  private frame(pos: THREE.Vector3, target: THREE.Vector3): number {
    if (this.shot === 'group') {
      const g = groupFraming(this.performers, GROUP_FOV, this.camera.aspect);
      pos.copy(g.pos);
      target.copy(g.target);
      return 0.15;
    }
    if (this.shot === 'ots') {
      // From behind the listener's shoulder (on the side towards the audience), onto the speaker.
      const s = this.speaker.headPosition();
      const l = this.shoulder.headPosition();
      const along = s.clone().sub(l).setY(0).normalize();
      const side = new THREE.Vector3(along.z, 0, -along.x);
      if (side.z < 0) side.negate();
      // Far enough back and out that the shoulder and head sit at the edge of frame, not across it.
      pos.copy(l).addScaledVector(along, -0.85).addScaledVector(side, 0.45).add(new THREE.Vector3(0, 0.06, 0));
      target.copy(s).add(new THREE.Vector3(0, -0.1, 0));
      return 0.02;
    }
    const s = SHOTS[this.shot === 'reaction' ? this.reactionShot : this.shot];
    const head = this.subject.headPosition();
    // Swing the shot halfway round with the performer's turn: a three-quarter view, not a profile.
    const turn = this.subject.root.rotation.y * 0.5;
    pos.set(...s.pos).applyAxisAngle(UP, turn).add(head);
    target.set(...s.target).applyAxisAngle(UP, turn).add(head);
    return s.push;
  }

  private cut(shot: ShotName, subject?: Performer): void {
    this.shot = shot;
    this.subject = shot === 'reaction' ? (subject ?? this.listener()) : this.speaker;
    if (shot === 'ots') this.shoulder = this.listener();
    if (shot === 'reaction') this.reactionShot = Math.random() < 0.5 ? 'medium' : 'close';
    this.shotStart = this.lastCut = this.time;
    this.nextCut = this.time + rand(5, 10);
    this.camera.fov = shot === 'group' ? GROUP_FOV : shot === 'ots' ? OTS_FOV : SHOTS[shot === 'reaction' ? this.reactionShot : shot].fov;
    this.camera.updateProjectionMatrix();
  }

  /** Someone other than the speaker, at random. */
  private listener(): Performer {
    const others = this.performers.filter((p) => p !== this.speaker);
    return others[Math.floor(Math.random() * others.length)] ?? this.speaker;
  }

  /** A random shot from `options`, never the one we're already on. */
  private pick(options: ShotName[]): ShotName {
    const fresh = options.filter((o) => o !== this.shot);
    return fresh[Math.floor(Math.random() * fresh.length)] ?? this.shot;
  }
}
