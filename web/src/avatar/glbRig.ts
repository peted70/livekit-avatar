import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { Viseme } from '../lipsync';
import type { ArmPose, AvatarRig, BodyState, FaceChannel, FaceState } from './types';

/** ARKit blendshape weights for each face channel; used when the model has ARKit morph targets. */
const ARKIT: Record<FaceChannel, Record<string, number>> = {
  smile: { mouthSmileLeft: 1, mouthSmileRight: 1, cheekSquintLeft: 0.4, cheekSquintRight: 0.4 },
  frown: { mouthFrownLeft: 1, mouthFrownRight: 1, browInnerUp: 0.6 },
  browUp: { browInnerUp: 1, browOuterUpLeft: 1, browOuterUpRight: 1 },
  browDown: { browDownLeft: 1, browDownRight: 1 },
  eyeWide: { eyeWideLeft: 1, eyeWideRight: 1 },
  squint: { eyeSquintLeft: 1, eyeSquintRight: 1 },
  blink: { eyeBlinkLeft: 1, eyeBlinkRight: 1 },
  jaw: { jawOpen: 1 },
};

/** Lip sync visemes onto Oculus viseme morphs (Ready Player Me names them viseme_aa etc.). */
const VISEME_MORPHS: Record<Viseme, string> = {
  aa: 'viseme_aa',
  E: 'viseme_E',
  I: 'viseme_I',
  O: 'viseme_O',
  U: 'viseme_U',
  SS: 'viseme_SS',
};

const DOWN = new THREE.Vector3(0, -1, 0);
/** Radians per joint (knuckle to tip) at full curl, and the curl the model's rest pose already has. */
const FINGER_ANGLES = [1.4, 1.6, 1.1];
const THUMB_ANGLES = [0.5, 0.7, 0.8];
const REST_CURL = 0.2;
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();

interface Bone {
  node: THREE.Object3D;
  restWorld: THREE.Quaternion;
}

/**
 * Drives a glTF character with a Mixamo-style skeleton (Ready Player Me, Mixamo, Rocketbox...)
 * and, if present, ARKit morph targets. Rotations are applied in model space relative to the
 * rest pose, so bone-local axis conventions and A/T-pose differences don't matter.
 */
export async function loadGlbRig(url: string): Promise<AvatarRig> {
  const gltf = await new GLTFLoader().loadAsync(url);
  const root = gltf.scene;

  // Converted files can carry their authoring camera and lights; the page has its own.
  const strays: THREE.Object3D[] = [];
  root.traverse((o) => (o as THREE.Light).isLight || (o as THREE.Camera).isCamera ? strays.push(o) : undefined);
  strays.forEach((o) => o.removeFromParent());
  root.updateMatrixWorld(true);

  const find = (name: string): Bone | null => {
    const node = root.getObjectByName(name);
    return node ? { node, restWorld: node.getWorldQuaternion(new THREE.Quaternion()) } : null;
  };
  const restPos = (name: string) => root.getObjectByName(name)?.getWorldPosition(new THREE.Vector3());

  const hips = find('Hips');
  const hipsRestPos = restPos('Hips');
  const spine = [find('Spine'), find('Spine1'), find('Spine2')];
  const legs = (['Left', 'Right'] as const).map((prefix) => {
    const [hip, knee, ankle] = [restPos(`${prefix}UpLeg`), restPos(`${prefix}Leg`), restPos(`${prefix}Foot`)];
    const bones = [find(`${prefix}UpLeg`), find(`${prefix}Leg`), find(`${prefix}Foot`)];
    if (!hip || !knee || !ankle || bones.some((b) => !b)) return null;
    const [thigh, shin, foot] = bones as Bone[];
    return {
      thigh, shin, foot, ankle,
      thighLen: knee.distanceTo(hip),
      shinLen: ankle.distanceTo(knee),
      thighRestDir: knee.clone().sub(hip).normalize(),
      shinRestDir: ankle.clone().sub(knee).normalize(),
    };
  });
  const neck = find('Neck');
  const head = find('Head');
  const eyes = [find('LeftEye'), find('RightEye')];
  const shoulders = { left: find('LeftShoulder'), right: find('RightShoulder') };
  const arms = (['left', 'right'] as const).map((side) => {
    const prefix = side === 'left' ? 'Left' : 'Right';
    const upper = find(`${prefix}Arm`);
    const fore = find(`${prefix}ForeArm`);
    const [a, b, c] = [restPos(`${prefix}Arm`), restPos(`${prefix}ForeArm`), restPos(`${prefix}Hand`)];
    const foreRestDir = b && c ? c.clone().sub(b).normalize() : DOWN.clone();
    return {
      side,
      upper,
      fore,
      upperRestDir: a && b ? b.clone().sub(a).normalize() : DOWN.clone(),
      foreRestDir,
      hand: c ? handRig(prefix, c, foreRestDir) : null,
    };
  });

  /**
   * Finger chains plus the rest-pose axes they bend about, all in model space: curling turns each
   * joint toward the palm, the wrist bends about the same kind of axis, and twist turns the palm
   * about the forearm.
   */
  function handRig(prefix: string, wrist: THREE.Vector3, foreDir: THREE.Vector3) {
    const at = (name: string) => restPos(`${prefix}Hand${name}`);
    const [index1, middle1, pinky1, thumbTip] = [at('Index1'), at('Middle1'), at('Pinky1'), at('Thumb4')];
    const hand = find(`${prefix}Hand`);
    if (!hand || !index1 || !middle1 || !pinky1) return null;
    const along = middle1.clone().sub(wrist).normalize();
    const across = index1.clone().sub(pinky1).normalize();
    // The palm side is where the thumb sits relative to the plane of the knuckles.
    const palm = new THREE.Vector3().crossVectors(along, across).normalize();
    if (thumbTip && thumbTip.clone().sub(wrist).dot(palm) < 0) palm.negate();
    // How far each finger fans toward the index side (+) or the little-finger side (−) when spread.
    const FAN: Record<string, number> = { Index: 1, Middle: 0, Ring: -0.7, Pinky: -1.4, Thumb: 0 };
    const chain = (finger: string) => {
      const joints = [1, 2, 3].map((i) => find(`${prefix}Hand${finger}${i}`)).filter((j): j is Bone => !!j);
      const p1 = at(`${finger}1`), p2 = at(`${finger}2`);
      const dir = p1 && p2 ? p2.clone().sub(p1).normalize() : along.clone();
      // Rotating about palm moves the finger sideways; pick the sign that moves it toward the index.
      const toIndex = Math.sign(new THREE.Vector3().crossVectors(palm, dir).dot(across)) || 1;
      return {
        joints,
        // Rotating about dir × palm moves the finger toward the palm.
        axis: new THREE.Vector3().crossVectors(dir, palm).normalize(),
        palm,
        fan: FAN[finger] * toIndex,
      };
    };
    return {
      hand,
      twistAxis: foreDir.clone(),
      wristAxis: new THREE.Vector3().crossVectors(along, palm).normalize(),
      fingers: (['Middle', 'Ring', 'Pinky'] as const).map(chain),
      index: chain('Index'),
      thumb: chain('Thumb'),
    };
  }

  const morphMeshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.morphTargetDictionary && 'jawOpen' in m.morphTargetDictionary) morphMeshes.push(m);
  });

  // Everything above was measured with the root at the origin, so it's all in model space
  // (relative to the root). Posing stays in model space, so the avatar can stand anywhere.
  const headPosition = head?.node.getWorldPosition(new THREE.Vector3()) ?? new THREE.Vector3(0, 1.6, 0);
  /** The root's world rotation, inverted; refreshed each frame in apply(). */
  const rootInv = new THREE.Quaternion();

  /** Sets a bone so its model-space rotation is `delta * rest`, given its parent's current pose. */
  function setWorld(bone: Bone | null, delta: THREE.Quaternion) {
    if (!bone) return;
    const parent = bone.node.parent!;
    parent.updateWorldMatrix(true, false);
    parent.getWorldQuaternion(_q2).premultiply(rootInv).invert();
    bone.node.quaternion.copy(_q2.multiply(_q.copy(delta).multiply(bone.restWorld)));
    bone.node.updateMatrixWorld();
  }

  /**
   * Weight shift: the hips move over one foot, drop a little and dip on the free side, and each leg
   * is solved (two-bone IK, knee bending forward) so the feet stay where they are.
   */
  function setHipsAndLegs(weight: number) {
    if (!hips || !hipsRestPos) return;
    const offset = new THREE.Vector3(weight * 0.06, -0.02 * Math.abs(weight), 0);
    const parent = hips.node.parent!;
    parent.updateWorldMatrix(true, false);
    hips.node.position.copy(parent.worldToLocal(root.localToWorld(hipsRestPos.clone().add(offset))));
    setWorld(hips, new THREE.Quaternion().setFromAxisAngle(_v.set(0, 0, 1), weight * 0.08));
    for (const leg of legs) {
      if (!leg) continue;
      const hip = root.worldToLocal(leg.thigh.node.getWorldPosition(new THREE.Vector3()));
      const toAnkle = leg.ankle.clone().sub(hip);
      const d = Math.min(toAnkle.length(), (leg.thighLen + leg.shinLen) * 0.9999);
      const u = toAnkle.normalize();
      const bend = Math.acos(Math.min(1, (leg.thighLen ** 2 + d ** 2 - leg.shinLen ** 2) / (2 * leg.thighLen * d)));
      const fwd = new THREE.Vector3(0, 0, 1).addScaledVector(u, -u.z).normalize();
      const knee = hip.clone().addScaledVector(u, leg.thighLen * Math.cos(bend)).addScaledVector(fwd, leg.thighLen * Math.sin(bend));
      setWorld(leg.thigh, new THREE.Quaternion().setFromUnitVectors(leg.thighRestDir, knee.clone().sub(hip).normalize()));
      const ankleNow = hip.clone().addScaledVector(u, d);
      setWorld(leg.shin, new THREE.Quaternion().setFromUnitVectors(leg.shinRestDir, ankleNow.sub(knee).normalize()));
      setWorld(leg.foot, new THREE.Quaternion()); // keep the foot flat, as at rest
    }
  }

  // Same arm convention as the built-in figure: rotate the hanging-down direction.
  // `torso` is the chest's rotation, so the arms ride along with the body.
  function setArm(arm: (typeof arms)[number], pose: ArmPose, torso: THREE.Quaternion) {
    const s = arm.side === 'left' ? 1 : -1;
    const shoulderRot = new THREE.Quaternion().setFromEuler(_e.set(-pose.forward, 0, s * pose.out));
    const upperDir = DOWN.clone().applyQuaternion(shoulderRot);
    const foreDir = DOWN.clone().applyQuaternion(_q.setFromEuler(_e.set(-pose.elbow, 0, 0))).applyQuaternion(shoulderRot);
    setWorld(arm.upper, torso.clone().multiply(new THREE.Quaternion().setFromUnitVectors(arm.upperRestDir, upperDir)));
    const foreQ = torso.clone().multiply(new THREE.Quaternion().setFromUnitVectors(arm.foreRestDir, foreDir));
    setWorld(arm.fore, foreQ);

    const h = arm.hand;
    if (!h) return;
    // Twist turns the palm up: the right hand mirrors the left.
    const handQ = foreQ
      .clone()
      .multiply(new THREE.Quaternion().setFromAxisAngle(h.twistAxis, -s * pose.twist))
      .multiply(new THREE.Quaternion().setFromAxisAngle(h.wristAxis, -pose.wrist));
    setWorld(h.hand, handQ);
    const spread = pose.hand.spread ?? 0.15;
    const curlChain = (c: (typeof h.fingers)[number], amount: number, angles: number[]) => {
      const q = handQ.clone().multiply(_q.setFromAxisAngle(c.palm, spread * 0.2 * c.fan));
      c.joints.forEach((joint, i) => {
        q.multiply(_q.setFromAxisAngle(c.axis, (amount - REST_CURL) * angles[i]));
        setWorld(joint, q);
      });
    };
    h.fingers.forEach((f, i) => curlChain(f, pose.hand.curl + (pose.hand.fingers?.[i] ?? 0), FINGER_ANGLES));
    curlChain(h.index, pose.hand.index, FINGER_ANGLES);
    curlChain(h.thumb, pose.hand.thumb, THUMB_ANGLES);
  }

  return {
    root,
    headPosition,
    apply(face: FaceState, body: BodyState) {
      root.updateWorldMatrix(true, false);
      root.getWorldQuaternion(rootInv).invert();
      setHipsAndLegs(body.weight);
      // The torso bends across the three spine bones; breathing lifts the chest a little.
      // These are model-space rotations, so the spine stays upright when the hips tilt.
      const torsoAt = (k: number, breath = 0) =>
        new THREE.Quaternion().setFromEuler(_e.set(body.lean * k - breath, body.torsoYaw * k, -body.sway * k, 'YXZ'));
      spine.forEach((bone, i) => setWorld(bone, torsoAt([0.35, 0.7, 1][i], i === 2 ? body.breath * 0.05 : 0)));
      const torso = torsoAt(1, body.breath * 0.05);

      // The head's angles are relative to the world, so take the torso back out of them.
      const neckQ = torso.clone().slerp(
        new THREE.Quaternion().setFromEuler(_e.set(-body.headPitch, body.headYaw, body.headRoll, 'YXZ')),
        0.4,
      );
      const headQ = new THREE.Quaternion().setFromEuler(_e.set(-body.headPitch, body.headYaw, body.headRoll, 'YXZ'));
      setWorld(neck, neckQ);
      setWorld(head, headQ);
      const eyeQ = headQ.clone().multiply(_q.setFromEuler(_e.set(-body.eyePitch, body.eyeYaw, 0, 'YXZ')));
      eyes.forEach((eye) => setWorld(eye, eyeQ));

      // Positive z-rotation lifts the left (+x) shoulder; negative lifts the right.
      setWorld(shoulders.left, torso.clone().multiply(new THREE.Quaternion().setFromAxisAngle(_v.set(0, 0, 1), body.shrug * 0.15)));
      setWorld(shoulders.right, torso.clone().multiply(new THREE.Quaternion().setFromAxisAngle(_v.set(0, 0, 1), -body.shrug * 0.15)));
      setArm(arms[0], body.left, torso);
      setArm(arms[1], body.right, torso);

      for (const mesh of morphMeshes) {
        const dict = mesh.morphTargetDictionary!;
        const weights = mesh.morphTargetInfluences!;
        weights.fill(0);
        const add = (shape: string, w: number) => {
          const i = dict[shape];
          if (i !== undefined) weights[i] = Math.min(1, weights[i] + w);
        };
        // With viseme shapes the mouth comes from them (they include the jaw); otherwise from jawOpen.
        const hasVisemes = 'viseme_aa' in dict;
        for (const [channel, shapes] of Object.entries(ARKIT) as [FaceChannel, Record<string, number>][]) {
          if (channel === 'jaw' && hasVisemes) continue;
          for (const [shape, k] of Object.entries(shapes)) add(shape, face[channel] * k);
        }
        if (hasVisemes) {
          for (const [v, shape] of Object.entries(VISEME_MORPHS) as [Viseme, string][]) add(shape, face.visemes[v]);
          add('jawOpen', face.jaw * 0.15);
          // Ready Player Me's upper lip hangs over the top teeth on open vowels; lift it a little.
          const lift = 0.4 * (face.visemes.aa + face.visemes.E) + 0.2 * face.visemes.I;
          add('mouthUpperUpLeft', lift);
          add('mouthUpperUpRight', lift);
        }
      }
    },
    update() {},
  };
}
