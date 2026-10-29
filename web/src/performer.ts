import * as THREE from 'three';
import { BehaviourController, type BehaviourMsg, type GazeResolver } from './behaviour';
import { createSimpleRig } from './avatar/simpleRig';
import { loadVrmRig } from './avatar/vrmRig';
import { loadGlbRig } from './avatar/glbRig';
import type { AvatarRig } from './avatar/types';
import { LipSync } from './lipsync';

/** Who's on stage: an id (the name scripts and gaze use) and, optionally, their avatar file. */
export interface CastMember {
  id: string;
  /** A .glb or .vrm under web/public, or 'simple' for the built-in figure. Defaults to avatar.glb / avatar.vrm. */
  avatar?: string;
}

/**
 * One avatar on stage: its rig, the behaviour that drives it, and lip sync from its voice.
 * Everything that belongs to a single avatar lives here, so a scene can have any number of them.
 */
export class Performer {
  readonly controller: BehaviourController;
  readonly lipsync: LipSync;

  constructor(
    readonly id: string,
    readonly rig: AvatarRig,
    audio: AudioContext,
    gaze: GazeResolver,
  ) {
    this.controller = new BehaviourController(gaze);
    this.lipsync = new LipSync(audio);
  }

  /** Loads a cast member's avatar. Each call loads its own copy, so performers never share a rig. */
  static async load(member: CastMember, audio: AudioContext, gaze: GazeResolver): Promise<Performer> {
    return new Performer(member.id, await loadAvatar(member.avatar), audio, gaze);
  }

  get root(): THREE.Object3D {
    return this.rig.root;
  }

  /** Where the head is at rest, in world space. */
  headPosition(target = new THREE.Vector3()): THREE.Vector3 {
    this.rig.root.updateWorldMatrix(true, false);
    return this.rig.root.localToWorld(target.copy(this.rig.headPosition));
  }

  /** Stands the performer at `position`, turned `yaw` radians from facing the camera (+z). */
  place(position: THREE.Vector3, yaw = 0): void {
    this.rig.root.position.copy(position);
    this.rig.root.rotation.set(0, yaw, 0);
  }

  handle(msg: BehaviourMsg): void {
    this.controller.handle(msg);
  }

  update(dt: number): void {
    const { face, body } = this.controller.update(dt, this.lipsync.sample(dt));
    this.rig.apply(face, body);
    this.rig.update(dt);
  }
}

/** Loads an avatar file by its extension; with none given, web/public/avatar.glb or avatar.vrm, else the built-in figure. */
async function loadAvatar(file?: string): Promise<AvatarRig> {
  if (file === 'simple') return createSimpleRig();
  const loaders: [string, (url: string) => Promise<AvatarRig>][] = file
    ? [[`/${file.replace(/^\//, '')}`, file.endsWith('.vrm') ? loadVrmRig : loadGlbRig]]
    : [
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
