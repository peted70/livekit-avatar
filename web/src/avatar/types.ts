import type { Object3D, Vector3 } from 'three';
import type { Visemes } from '../lipsync';

/** Abstract face channels, 0..1. Each rig maps these onto its own blendshapes or meshes. */
export interface FaceState {
  smile: number;
  frown: number;
  browUp: number;
  browDown: number;
  eyeWide: number;
  squint: number;
  blink: number;
  jaw: number;
  /** Mouth shapes from lip sync; rigs without viseme shapes use `jaw` instead. */
  visemes: Visemes;
}

/** 0 = straight, 1 = fully curled. `index` is separate so the hand can point. */
export interface HandShape {
  curl: number;
  index: number;
  thumb: number;
  /** 0..1 how far the fingers fan out. */
  spread?: number;
  /** Extra curl for the middle, ring and little fingers, so they needn't move as one. */
  fingers?: [number, number, number];
}

/**
 * Radians. forward: raise arm in front; out: away from the body; elbow: bend;
 * twist: turn the palm up (positive) or down; wrist: bend the hand back (positive) or toward the palm.
 */
export interface ArmPose {
  forward: number;
  out: number;
  elbow: number;
  twist: number;
  wrist: number;
  hand: HandShape;
}

/** Radians. Positive yaw turns toward +x (the viewer's right), positive pitch looks up. */
export interface BodyState {
  headYaw: number;
  headPitch: number;
  headRoll: number;
  /** Eyes relative to the head. */
  eyeYaw: number;
  eyePitch: number;
  shrug: number;
  /** Torso, radians: lean forward (+), turn toward +x (+), sway toward +x (+). */
  lean: number;
  torsoYaw: number;
  sway: number;
  /** 0..1 chest rise from breathing. */
  breath: number;
  /** Weight shift between the feet: −1 all on the right foot, +1 all on the left. */
  weight: number;
  left: ArmPose;
  right: ArmPose;
}

export interface AvatarRig {
  root: Object3D;
  /** World position of the head, for framing the camera. */
  headPosition: Vector3;
  apply(face: FaceState, body: BodyState): void;
  update(dt: number): void;
}

/** The scalar face channels, i.e. everything but the visemes. */
export type FaceChannel = Exclude<keyof FaceState, 'visemes'>;

export const FACE_KEYS: FaceChannel[] = ['smile', 'frown', 'browUp', 'browDown', 'eyeWide', 'squint', 'blink', 'jaw'];

export const neutralFace = (): FaceState => ({ smile: 0, frown: 0, browUp: 0, browDown: 0, eyeWide: 0, squint: 0, blink: 0, jaw: 0, visemes: { aa: 0, E: 0, I: 0, O: 0, U: 0, SS: 0 } });
export const restHand = (): HandShape => ({ curl: 0.35, index: 0.3, thumb: 0.2 });
export const restArm = (): ArmPose => ({ forward: 0.05, out: 0.18, elbow: 0.15, twist: 0, wrist: 0, hand: restHand() });
