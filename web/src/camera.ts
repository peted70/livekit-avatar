import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { BehaviourMsg } from './behaviour';

/** A camera position and look target relative to the avatar's head, plus a lens. */
interface Shot {
  pos: [number, number, number];
  target: [number, number, number];
  fov: number;
  /** How far the camera creeps towards the target over a shot (metres), like a slow dolly. */
  push: number;
}

type ShotName = 'wide' | 'medium' | 'close' | 'angle';

const SHOTS: Record<ShotName, Shot> = {
  wide: { pos: [0, -0.3, 1.75], target: [0, -0.38, 0], fov: 35, push: 0.12 },
  medium: { pos: [0.12, -0.1, 1.35], target: [0, -0.18, 0], fov: 32, push: 0.08 },
  close: { pos: [0.05, 0.03, 0.75], target: [0, 0.02, 0], fov: 28, push: 0.04 },
  angle: { pos: [-0.55, -0.08, 1.2], target: [0, -0.15, 0], fov: 32, push: 0.06 },
};

const BIG_GESTURES = new Set(['shrug', 'open_palm', 'point']);
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const smoothstep = (x: number) => x * x * (3 - 2 * x);

/**
 * A TV-interview style camera: holds a shot with a slow push-in and a little handheld drift,
 * and cuts between shots now and then, and on moments in the conversation (the avatar starting
 * to talk, a big gesture, a strong emotion). Dragging the camera pauses it for a while.
 */
export class CameraDirector {
  enabled = true;

  private time = 0;
  private shot: ShotName = 'medium';
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
    private head: THREE.Vector3,
  ) {
    // Taking the camera by hand pauses the director, so you can look around.
    controls.addEventListener('start', () => (this.pausedUntil = this.time + 15));
    this.cut('medium');
  }

  /** Cuts on conversational moments, read from the same behaviour messages the avatar gets. */
  onMessage(msg: BehaviourMsg): void {
    // A cut changes the lens, so a switched-off director mustn't cut.
    if (!this.enabled) return;
    const since = this.time - this.lastCut;
    switch (msg.type) {
      case 'agent_state': {
        const speaking = msg.state === 'speaking';
        if (speaking && !this.wasSpeaking && since > 2) this.cut(this.pick(['medium', 'close', 'angle']));
        this.wasSpeaking = speaking;
        break;
      }
      case 'gesture':
        // Hands need room: go wider if we're in tight.
        if (BIG_GESTURES.has(msg.name) && this.shot === 'close') this.cut(this.pick(['wide', 'medium']));
        break;
      case 'emotion':
        if ((msg.name === 'surprised' || msg.name === 'amused') && since > 2.5 && Math.random() < 0.35) this.cut('close');
        break;
      case 'user_state':
        if (msg.state === 'speaking' && since > 3 && Math.random() < 0.5) this.cut(this.pick(['wide', 'angle']));
        break;
    }
  }

  update(dt: number): void {
    const t = (this.time += dt);
    if (!this.enabled || t < this.pausedUntil) return;
    if (t > this.nextCut) this.cut(this.pick(['wide', 'medium', 'close', 'angle']));

    const s = SHOTS[this.shot];
    const p = smoothstep(Math.min(1, (t - this.shotStart) / 12));
    this._target.set(...s.target).add(this.head);
    this._pos.set(...s.pos).add(this.head);
    // Slow push-in along the line of sight, then a faint handheld drift.
    this._pos.addScaledVector(this._target.clone().sub(this._pos).normalize(), s.push * p);
    this._pos.x += 0.006 * Math.sin(t * 0.7) + 0.003 * Math.sin(t * 1.9 + 1);
    this._pos.y += 0.004 * Math.sin(t * 0.53 + 2);
    this._target.x += 0.002 * Math.sin(t * 0.61 + 3);

    this.camera.position.copy(this._pos);
    this.controls.target.copy(this._target);
    this.camera.lookAt(this._target);
  }

  private cut(shot: ShotName): void {
    this.shot = shot;
    this.shotStart = this.lastCut = this.time;
    this.nextCut = this.time + rand(5, 10);
    this.camera.fov = SHOTS[shot].fov;
    this.camera.updateProjectionMatrix();
  }

  /** A random shot from `options`, never the one we're already on. */
  private pick(options: ShotName[]): ShotName {
    const fresh = options.filter((o) => o !== this.shot);
    return fresh[Math.floor(Math.random() * fresh.length)] ?? this.shot;
  }
}
