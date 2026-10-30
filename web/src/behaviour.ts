import type { Mouth } from './lipsync';
import { seeded, type Rng } from './random';
import { FACE_KEYS, neutralFace, restArm, type ArmPose, type BodyState, type FaceState } from './avatar/types';
import { LOOSE_FIST, OPEN_HAND, POINTING_HAND, TalkGestures, lerpArm } from './gestures';

export const EMOTION_NAMES = ['neutral', 'happy', 'amused', 'curious', 'concerned', 'surprised', 'thinking'] as const;
export const GESTURE_NAMES = ['nod', 'shake', 'open_palm', 'beat', 'point', 'shrug'] as const;
export type Emotion = (typeof EMOTION_NAMES)[number];
export type GestureName = (typeof GESTURE_NAMES)[number];

/** Wire format: see docs/behaviour-protocol.md */
export type BehaviourMsg = { v?: number; t?: number } & (
  | { type: 'agent_state'; state: string }
  | { type: 'user_state'; state: string }
  | { type: 'gaze'; target: string | null }
  | { type: 'emotion'; name: Emotion }
  | { type: 'gesture'; name: GestureName; target?: string | null }
  | { type: 'interrupted' }
);

export interface Direction {
  yaw: number;
  pitch: number;
}

/** Resolves a participant identity to a direction from the avatar, on this device. */
export type GazeResolver = (identity: string | null) => Direction;

const EMOTION_FACE: Record<Emotion, Partial<FaceState>> = {
  neutral: {},
  happy: { smile: 0.85, squint: 0.3, browUp: 0.15 },
  amused: { smile: 0.6, squint: 0.45, browUp: 0.3 },
  curious: { browUp: 0.75, eyeWide: 0.3 },
  concerned: { frown: 0.65, browDown: 0.4 },
  surprised: { browUp: 1, eyeWide: 0.8 },
  thinking: { browDown: 0.55, squint: 0.25 },
};

const GESTURE_DURATION: Record<GestureName, number> = {
  nod: 0.9,
  shake: 1.1,
  open_palm: 1.8,
  beat: 1.4,
  point: 2.0,
  shrug: 1.4,
};

interface ActiveGesture {
  name: GestureName;
  target: string | null;
  start: number;
  amp: number;
}

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
/** Frame-rate independent exponential approach. */
const damp = (cur: number, target: number, lambda: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-lambda * dt));
const smoothstep = (x: number) => x * x * (3 - 2 * x);
/** 0→1→0 envelope with quick attack and release, holding in between. */
const hold = (p: number, attack = 0.2, release = 0.25) => smoothstep(clamp(Math.min(p / attack, (1 - p) / release), 0, 1));
/** How big co-speech gestures are, by emotion. */
const GESTURE_AMOUNT: Record<Emotion, number> = {
  neutral: 1,
  happy: 1.15,
  amused: 1.15,
  curious: 1.05,
  concerned: 0.85,
  surprised: 1.2,
  thinking: 0.75,
};

/** Scales every emotion's face preset (clamped to the shapes' full range). */
const EMOTION_GAIN = 1.25;

const SHRUG_ARM: ArmPose = { forward: 0.25, out: 0.35, elbow: 1.45, twist: 1.5, wrist: 0.3, hand: OPEN_HAND };

/**
 * Turns behaviour messages into a per-frame face/body pose, adding the procedural life
 * (blinks, saccades, breathing, listening nods) that each device generates locally.
 */
export class BehaviourController {
  enabled = true;
  /** Random choices: blinks, glances, nods, weight shifts. A scene seeds it with restart(). */
  rng: Rng = Math.random;
  /**
   * Eyebrow flashes on stressed syllables get their own source: how many syllables register
   * depends on when frames sample the audio, and that mustn't shift every other choice.
   */
  private flashRng: Rng = Math.random;

  private time = 0;
  private agentState = 'initializing';
  private userState = 'listening';
  private gazeTarget: string | null = null;
  private emotion: Emotion = 'neutral';
  private emotionAt = -Infinity;
  private emotionAmount = 0;
  private gesture: ActiveGesture | null = null;
  private interruptedAt = -Infinity;

  private face = neutralFace();
  private headYaw = 0;
  private headPitch = 0;
  private eyeYaw = 0;
  private eyePitch = 0;
  private saccade: Direction = { yaw: 0, pitch: 0 };
  private nextSaccade = 0;
  private blinkStart = -Infinity;
  private nextBlink = 1;
  private nextNod = Infinity;
  /** Brief eyebrow raises: on stressed words, starting a turn, or someone starting to talk. */
  private browFlashAt = -Infinity;
  private browFlashAmp = 0;
  private talk = new TalkGestures();
  private weight = 0;
  private weightTarget = 0;
  private nextWeightShift = this.rand(4, 8);

  constructor(private resolve: GazeResolver) {}

  /**
   * Starts the clock and the random timers again, choosing with `rng` from now on, so a scene
   * replays the same. The current pose carries on and settles from wherever it is.
   */
  restart(rng: Rng): void {
    this.rng = rng;
    // Talk gestures and eyebrow flashes draw from their own sources, seeded from this one.
    this.talk.restart(seeded((rng() * 2 ** 32) >>> 0));
    this.flashRng = seeded((rng() * 2 ** 32) >>> 0);
    this.time = 0;
    this.gesture = null;
    this.emotionAt = this.interruptedAt = this.blinkStart = this.browFlashAt = -Infinity;
    this.nextSaccade = 0;
    this.nextBlink = 1;
    this.nextNod = Infinity;
    this.nextWeightShift = this.rand(4, 8);
  }

  private rand(a: number, b: number): number {
    return a + this.rng() * (b - a);
  }

  get state() {
    return { agent: this.agentState, user: this.userState, gaze: this.gazeTarget, emotion: this.emotion };
  }

  handle(msg: BehaviourMsg): void {
    const t = this.time;
    switch (msg.type) {
      case 'agent_state':
        if (msg.state === 'speaking' && this.agentState !== 'speaking') this.browFlash(0.5);
        this.agentState = msg.state;
        break;
      case 'user_state':
        if (msg.state === 'speaking' && this.userState !== 'speaking') this.browFlash(0.35);
        this.userState = msg.state;
        if (msg.state === 'speaking') this.nextNod = t + this.rand(1.2, 2.5);
        break;
      case 'gaze':
        if (msg.target !== this.gazeTarget) this.blinkStart = t; // people blink as they shift gaze
        this.gazeTarget = msg.target;
        break;
      case 'emotion':
        this.emotion = msg.name;
        this.emotionAt = t;
        break;
      case 'gesture':
        this.gesture = { name: msg.name, target: msg.target ?? null, start: t, amp: 1 };
        break;
      case 'interrupted':
        this.interruptedAt = t;
        this.gesture = null;
        break;
    }
  }

  update(dt: number, mouth: Mouth): { face: FaceState; body: BodyState } {
    const t = (this.time += dt);
    const { jaw, visemes } = mouth;
    const on = this.enabled;
    const speaking = on ? this.agentState === 'speaking' : jaw > 0.05;

    // Gesture timeline
    let g = this.gesture;
    let p = 0;
    if (g) {
      p = (t - g.start) / GESTURE_DURATION[g.name];
      if (p >= 1) g = this.gesture = null;
    }

    // Listening back-channel: small nods while the user talks.
    if (on && this.userState === 'speaking' && this.agentState !== 'speaking' && !g && t > this.nextNod) {
      g = this.gesture = { name: 'nod', target: null, start: t, amp: 0.5 };
      p = 0;
      this.nextNod = t + this.rand(2.5, 5);
    }

    // Gaze: where the agent wants to look, resolved for this device.
    let gaze = on ? this.resolve(g?.name === 'point' && g.target ? g.target : this.gazeTarget) : { yaw: 0, pitch: 0 };
    if (on && this.agentState === 'thinking') gaze = { yaw: gaze.yaw - 0.35, pitch: 0.22 };

    if (t > this.nextSaccade) {
      this.saccade = { yaw: this.rand(-0.05, 0.05), pitch: this.rand(-0.03, 0.03) };
      this.nextSaccade = t + this.rand(0.4, 2.2);
    }
    // Eyes lead quickly, the head follows more slowly and not all the way.
    this.headYaw = damp(this.headYaw, gaze.yaw * 0.85, 4, dt);
    this.headPitch = damp(this.headPitch, gaze.pitch * 0.6, 4, dt);
    this.eyeYaw = damp(this.eyeYaw, clamp(gaze.yaw - this.headYaw, -0.5, 0.5) + this.saccade.yaw, 25, dt);
    this.eyePitch = damp(this.eyePitch, clamp(gaze.pitch - this.headPitch, -0.3, 0.3) + this.saccade.pitch, 25, dt);

    // Emotion: full strength while speaking or just after it arrives, then relaxes.
    const fresh = speaking || t - this.emotionAt < 4;
    this.emotionAmount = damp(this.emotionAmount, on ? (fresh ? 1 : 0.55) : 0, 3, dt);
    const preset = EMOTION_FACE[this.emotion];
    for (const k of FACE_KEYS) this.face[k] = damp(this.face[k], Math.min(1, (preset[k] ?? 0) * EMOTION_GAIN) * this.emotionAmount, 8, dt);

    // Blinks
    if (t > this.nextBlink) {
      this.blinkStart = t;
      this.nextBlink = t + this.rand(2, 5.5);
    }
    const bp = (t - this.blinkStart) / 0.16;
    const face: FaceState = { ...this.face, jaw, visemes, blink: bp >= 0 && bp < 1 ? Math.sin(Math.PI * bp) : 0 };

    // Idle life: breathing (~4 s), slow weight shifts, and the body turning a little toward the
    // person it's looking at. Runs even with the stream off, since every device does this anyway.
    const breath = 0.5 + 0.5 * Math.sin(t * 1.5);
    // Every so often, settle onto one foot (or back to both).
    if (t > this.nextWeightShift) {
      this.weightTarget = [-1, 0, 1].filter((w) => w !== this.weightTarget)[Math.floor(this.rng() * 2)];
      this.nextWeightShift = t + this.rand(4, 9);
    }
    this.weight = damp(this.weight, this.weightTarget, 1.0, dt);
    const arms = this.talk.update(t, dt, on && speaking, jaw, on ? GESTURE_AMOUNT[this.emotion] : 0);
    // Fingers: each curls a little more than the last toward the little finger, drifts on its own
    // slow rhythm (livelier while talking), and the hand opens slightly on each beat.
    const fidget = speaking ? 1.6 : 1;
    // Upper arms drift on their own, and hang against the torso's sway as if under their own weight
    // (side: +1 left, −1 right).
    const sway = 0.05 * Math.sin(t * 0.37) + 0.015 * Math.sin(t * 1.1 + 2) + 0.035 * this.weight;
    const idleArm = (a: ArmPose, phase: number, side: number): ArmPose => ({
      ...a,
      forward: a.forward + 0.07 * Math.sin(t * 0.7 + phase) + 0.03 * Math.sin(t * 1.3 + phase * 3),
      out: a.out + 0.05 * Math.sin(t * 0.43 + phase * 1.3) - 0.6 * side * sway,
      elbow: a.elbow + 0.08 * Math.sin(t * 0.5 + phase * 2),
      hand: {
        ...a.hand,
        curl: a.hand.curl + 0.05 * Math.sin(t * 0.3 + phase) - 0.12 * arms.beat,
        index: a.hand.index + 0.05 * fidget * Math.sin(t * 1.1 + phase) - 0.1 * arms.beat,
        thumb: a.hand.thumb + 0.04 * fidget * Math.sin(t * 0.8 + phase + 3),
        spread: (a.hand.spread ?? 0.15) + 0.06 * fidget * Math.sin(t * 0.45 + phase) + 0.15 * arms.beat,
        fingers: [
          0.03 + 0.05 * fidget * Math.sin(t * 0.9 + phase),
          0.08 + 0.06 * fidget * Math.sin(t * 0.7 + phase + 1),
          0.15 + 0.07 * fidget * Math.sin(t * 0.6 + phase + 2),
        ],
      },
    });
    const body: BodyState = {
      headYaw: this.headYaw + 0.07 * Math.sin(t * 0.27) + 0.02 * Math.sin(t * 0.83 + 1),
      headPitch: this.headPitch + 0.02 * Math.sin(t * 1.5 + 1),
      headRoll: 0.05 * Math.sin(t * 0.19 + 1),
      eyeYaw: this.eyeYaw,
      eyePitch: this.eyePitch,
      shrug: 0.3 * breath,
      lean: (speaking ? 0.04 : this.userState === 'speaking' ? 0.03 : 0.01) + 0.012 * arms.beat,
      torsoYaw: 0.3 * this.headYaw + 0.06 * Math.sin(t * 0.21),
      // Shoulders tilt the opposite way to the hips (contrapposto).
      sway,
      breath,
      weight: this.weight,
      left: idleArm(arms.left, 0, 1),
      right: idleArm(arms.right, 1.7, -1),
    };

    if (speaking) {
      // Talking heads move: a small dip on each beat, plus a livelier drift.
      body.headPitch += jaw * 0.05 - 0.07 * arms.beat;
      body.headYaw += 0.05 * Math.sin(t * 2.1) + 0.03 * Math.sin(t * 0.9 + 2);
      body.headRoll += 0.04 * Math.sin(t * 1.3);
    }
    if (on && this.emotion === 'curious') body.headRoll += 0.16 * this.emotionAmount;
    if (on && this.emotion === 'amused') body.headPitch += 0.06 * this.emotionAmount;
    if (on && this.emotion === 'concerned') body.headPitch -= 0.05 * this.emotionAmount;
    if (on && this.agentState === 'listening' && this.userState === 'speaking') body.headRoll += 0.05;

    // Brow flashes: a stressed syllable sometimes gets one, as it does in real speech.
    if (on && arms.onset && this.flashRng() < 0.35 && t - this.browFlashAt > 0.8) {
      this.browFlash(0.3 + this.flashRng() * 0.25);
    }
    const fp = (t - this.browFlashAt) / 0.45;
    if (on && fp < 1) face.browUp = Math.max(face.browUp, this.browFlashAmp * Math.sin(Math.PI * Math.min(1, fp * 1.6)) * (1 - fp * 0.4));
    // Concentrating while the reply is being worked out.
    if (on && this.agentState === 'thinking') face.browDown = Math.max(face.browDown, 0.35);

    // Interrupted: brows up, eyes wide for a moment.
    const ik = on ? clamp(1 - (t - this.interruptedAt) / 1.0, 0, 1) : 0;
    face.browUp = Math.max(face.browUp, 0.8 * ik);
    face.eyeWide = Math.max(face.eyeWide, 0.6 * ik);

    if (g) this.applyGesture(g, p, face, body);
    return { face, body };
  }

  private browFlash(amount: number): void {
    this.browFlashAt = this.time;
    this.browFlashAmp = amount;
  }

  private applyGesture(g: ActiveGesture, p: number, face: FaceState, body: BodyState): void {
    const h = hold(p) * g.amp;
    switch (g.name) {
      case 'nod':
        body.headPitch -= 0.14 * g.amp * Math.sin(p * Math.PI * 4) * (1 - p);
        break;
      case 'shake':
        body.headYaw += 0.22 * g.amp * Math.sin(p * Math.PI * 6) * (1 - p);
        break;
      case 'shrug':
        body.shrug = Math.max(body.shrug, h);
        body.headRoll += 0.12 * h;
        face.browUp = Math.max(face.browUp, 0.5 * h);
        face.frown = Math.max(face.frown, 0.25 * h);
        body.left = lerpArm(body.left, SHRUG_ARM, h);
        body.right = lerpArm(body.right, SHRUG_ARM, h);
        break;
      case 'open_palm':
        // Offering a point: right palm up toward the listener, left hand following loosely.
        body.right = lerpArm(body.right, { forward: 0.55, out: 0.25, elbow: 1.2, twist: 1.3, wrist: 0.2, hand: OPEN_HAND }, h);
        body.left = lerpArm(body.left, { forward: 0.3, out: 0.15, elbow: 0.9, twist: 0.8, wrist: 0.1, hand: OPEN_HAND }, h * 0.5);
        break;
      case 'beat': {
        const b = Math.sin(p * Math.PI * 6);
        body.right = lerpArm(body.right, { forward: 0.4, out: 0.15, elbow: 1.2 + 0.25 * b, twist: 0.6, wrist: -0.15 * b, hand: LOOSE_FIST }, h);
        break;
      }
      case 'point': {
        const dir = this.resolve(g.target ?? this.gazeTarget);
        // Right arm is on the avatar's right (-x); reaching toward +x crosses the body.
        body.right = lerpArm(
          body.right,
          { forward: 1.3, out: clamp(-dir.yaw * 0.9, -0.5, 0.9), elbow: 0.15, twist: 0.2, wrist: 0, hand: POINTING_HAND },
          h,
        );
        break;
      }
    }
  }
}
