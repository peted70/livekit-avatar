import type { Rng } from './random';
import { restArm, type ArmPose, type HandShape } from './avatar/types';

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
export const lerpArm = (a: ArmPose, b: ArmPose, k: number): ArmPose => ({
  forward: lerp(a.forward, b.forward, k),
  out: lerp(a.out, b.out, k),
  elbow: lerp(a.elbow, b.elbow, k),
  twist: lerp(a.twist, b.twist, k),
  wrist: lerp(a.wrist, b.wrist, k),
  hand: {
    curl: lerp(a.hand.curl, b.hand.curl, k),
    index: lerp(a.hand.index, b.hand.index, k),
    thumb: lerp(a.hand.thumb, b.hand.thumb, k),
    spread: lerp(a.hand.spread ?? 0.15, b.hand.spread ?? 0.15, k),
  },
});

export const OPEN_HAND: HandShape = { curl: 0.05, index: 0.05, thumb: 0, spread: 0.7 };
export const POINTING_HAND: HandShape = { curl: 1, index: 0, thumb: 0.8, spread: 0 };
export const LOOSE_FIST: HandShape = { curl: 0.6, index: 0.5, thumb: 0.5, spread: 0 };
const SOFT_HAND: HandShape = { curl: 0.25, index: 0.2, thumb: 0.15, spread: 0.35 };
const PINCH_HAND: HandShape = { curl: 0.45, index: 0.6, thumb: 0.65, spread: 0.1 };

const arm = (forward: number, out: number, elbow: number, twist: number, wrist: number, hand: HandShape): ArmPose => ({
  forward, out, elbow, twist, wrist, hand,
});
/** A hand resting low and relaxed while the other one talks. */
const RELAXED = arm(0.12, 0.2, 0.55, 0.2, 0, SOFT_HAND);

/**
 * Talking poses, held for a phrase each: hands in front of the body ("gesture space"),
 * palms mostly up or in. Positive twist turns the palm up.
 */
const TALK_POSES: { left: ArmPose; right: ArmPose }[] = [
  // Both hands open, palms up: explaining.
  { left: arm(0.45, 0.38, 1.35, 0.9, 0.15, SOFT_HAND), right: arm(0.45, 0.38, 1.35, 0.9, 0.15, SOFT_HAND) },
  // Right hand leads, palm in.
  { left: RELAXED, right: arm(0.55, 0.32, 1.4, 0.5, 0.1, SOFT_HAND) },
  // Left hand leads.
  { left: arm(0.55, 0.32, 1.4, 0.5, 0.1, SOFT_HAND), right: RELAXED },
  // Palms down: calm, "settle this".
  { left: arm(0.4, 0.4, 1.25, -0.4, 0, OPEN_HAND), right: arm(0.4, 0.4, 1.25, -0.4, 0, OPEN_HAND) },
  // Precision grip: making a specific point.
  { left: RELAXED, right: arm(0.45, 0.12, 1.55, 0.3, 0.2, PINCH_HAND) },
  // Hands close together in front.
  { left: arm(0.5, 0.04, 1.5, 0.4, 0.1, SOFT_HAND), right: arm(0.5, 0.04, 1.5, 0.4, 0.1, SOFT_HAND) },
];
const REST = { left: restArm(), right: restArm() };

/**
 * Co-speech gestures, generated on the device: a new talking pose every phrase or so,
 * with small beats on stressed syllables (sudden rises in loudness).
 */
export class TalkGestures {
  rng: Rng = Math.random;
  private left = restArm();
  private right = restArm();
  private target = REST;
  private nextPhrase = 0;
  private slowJaw = 0;
  private lastBeat = -Infinity;
  private beatAmp = 0;

  /** Back to rest, choosing with `rng` from now on, as a scene starts. */
  restart(rng: Rng): void {
    this.rng = rng;
    this.left = restArm();
    this.right = restArm();
    this.target = REST;
    this.nextPhrase = 0;
    this.lastBeat = -Infinity;
  }

  private rand(a: number, b: number): number {
    return a + this.rng() * (b - a);
  }

  /** `amount` scales how big the gestures are (emotion-dependent). Returns the arms and a beat 0..1. */
  update(t: number, dt: number, speaking: boolean, jaw: number, amount: number) {
    if (!speaking) {
      this.target = REST;
      this.nextPhrase = t + this.rand(0.15, 0.5);
    } else if (t > this.nextPhrase) {
      // Now and then drop the hands for a phrase, like people do.
      const options = TALK_POSES.filter((p) => p !== this.target);
      this.target = this.rng() < 0.15 ? REST : options[Math.floor(this.rng() * options.length)];
      this.nextPhrase = t + this.rand(1.4, 3.0);
    }
    const k = 1 - Math.exp(-5 * dt);
    this.left = lerpArm(this.left, lerpArm(REST.left, this.target.left, amount), k);
    this.right = lerpArm(this.right, lerpArm(REST.right, this.target.right, amount), k);

    // Beats: the jaw opening much faster than its recent average marks a stressed syllable.
    const rise = jaw - this.slowJaw;
    this.slowJaw += (jaw - this.slowJaw) * (1 - Math.exp(-8 * dt));
    let onset = false;
    if (speaking && rise > 0.12 && t - this.lastBeat > 0.28) {
      onset = true;
      this.lastBeat = t;
      this.beatAmp = Math.min(1, rise * 4) * amount;
    }
    const bp = (t - this.lastBeat) / 0.3;
    const beat = bp < 1 ? this.beatAmp * Math.sin(Math.PI * bp) : 0;

    // The hands that are up do the beat: the forearm drops a little and the wrist flicks.
    const withBeat = (a: ArmPose): ArmPose =>
      a.elbow > 1 ? { ...a, elbow: a.elbow - 0.26 * beat, wrist: a.wrist - 0.2 * beat, forward: a.forward - 0.06 * beat } : a;
    return { left: withBeat(this.left), right: withBeat(this.right), beat, onset };
  }
}
