import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM, type VRMHumanBoneName } from '@pixiv/three-vrm';
import type { ArmPose, AvatarRig, BodyState, FaceState } from './types';

/** Drives a VRM model through its normalized humanoid bones and preset expressions. */
export async function loadVrmRig(url: string): Promise<AvatarRig> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.loadAsync(url);
  const vrm: VRM = gltf.userData.vrm;
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  VRMUtils.rotateVRM0(vrm); // VRM 0.x faces -z; turn it to face the camera like VRM 1.0

  const bone = (name: VRMHumanBoneName) => vrm.humanoid.getNormalizedBoneNode(name);
  const lookTarget = new THREE.Object3D();
  vrm.scene.add(lookTarget);
  if (vrm.lookAt) vrm.lookAt.target = lookTarget;

  vrm.update(0);
  const headPosition = new THREE.Vector3();
  bone('head')?.getWorldPosition(headPosition);

  const setExpr = (name: string, value: number) => vrm.expressionManager?.setValue(name, THREE.MathUtils.clamp(value, 0, 1));

  // Normalized bones rest in T-pose with world-aligned axes; left arm points +x, right arm -x.
  function setArm(side: 'left' | 'right', arm: ArmPose) {
    const s = side === 'left' ? 1 : -1;
    bone(`${side}UpperArm`)?.rotation.set(-arm.forward, 0, -s * (Math.PI / 2 - arm.out));
    bone(`${side}LowerArm`)?.rotation.set(0, -s * arm.elbow, 0);
  }

  return {
    root: vrm.scene,
    headPosition,
    apply(face: FaceState, body: BodyState) {
      bone('neck')?.rotation.set(-body.headPitch * 0.4, body.headYaw * 0.4, body.headRoll * 0.4, 'YXZ');
      bone('head')?.rotation.set(-body.headPitch * 0.6, body.headYaw * 0.6, body.headRoll * 0.6, 'YXZ');

      const yaw = body.headYaw + body.eyeYaw;
      const pitch = body.headPitch + body.eyePitch;
      lookTarget.position.set(
        headPosition.x + Math.sin(yaw) * Math.cos(pitch),
        headPosition.y + Math.sin(pitch),
        headPosition.z + Math.cos(yaw) * Math.cos(pitch),
      );

      setExpr('happy', face.smile * 0.9);
      setExpr('sad', face.frown * 0.7 + face.browDown * 0.15);
      setExpr('surprised', Math.max(face.browUp * 0.4, face.eyeWide * 0.7));
      setExpr('relaxed', face.squint * 0.5);
      setExpr('blink', face.blink);
      // VRM's mouth presets, with the jaw as a floor so loud-but-unclear audio still opens the mouth.
      const v = face.visemes;
      setExpr('aa', Math.max(v.aa, face.jaw * 0.3));
      setExpr('ee', v.E);
      setExpr('ih', v.I + v.SS * 0.5);
      setExpr('oh', v.O);
      setExpr('ou', v.U);

      bone('spine')?.rotation.set(body.lean * 0.5, body.torsoYaw * 0.5, -body.sway * 0.5);
      bone('chest')?.rotation.set(body.lean * 0.5 - body.breath * 0.025, body.torsoYaw * 0.5, -body.sway * 0.5);
      bone('leftShoulder')?.rotation.set(0, 0, body.shrug * 0.15);
      bone('rightShoulder')?.rotation.set(0, 0, -body.shrug * 0.15);
      setArm('left', body.left);
      setArm('right', body.right);
    },
    update(dt: number) {
      vrm.update(dt);
    },
  };
}
