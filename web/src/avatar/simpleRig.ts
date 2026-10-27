import * as THREE from 'three';
import type { ArmPose, AvatarRig, BodyState, FaceState } from './types';

/** A stylised placeholder figure built from primitives, so the demo runs with no assets. */
export function createSimpleRig(): AvatarRig {
  const skin = new THREE.MeshStandardMaterial({ color: 0xe9b995, roughness: 0.7 });
  const shirt = new THREE.MeshStandardMaterial({ color: 0x3d5afe, roughness: 0.8 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1e1b24, roughness: 0.4 });
  const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });
  const lip = new THREE.MeshStandardMaterial({ color: 0x6b2433, roughness: 0.6, side: THREE.DoubleSide });

  const root = new THREE.Group();
  const add = (parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };

  add(root, new THREE.CapsuleGeometry(0.17, 0.32, 8, 24), shirt, 0, 1.0, 0).scale.set(1, 1, 0.7);
  add(root, new THREE.CylinderGeometry(0.045, 0.05, 0.12, 16), skin, 0, 1.28, 0);

  const neck = new THREE.Group();
  neck.position.set(0, 1.3, 0);
  neck.rotation.order = 'YXZ';
  root.add(neck);
  const head = new THREE.Group();
  head.position.set(0, 0.06, 0);
  head.rotation.order = 'YXZ';
  neck.add(head);
  add(head, new THREE.SphereGeometry(0.12, 32, 24), skin, 0, 0.1, 0).scale.set(0.92, 1.08, 0.98);
  add(head, new THREE.SphereGeometry(0.014, 12, 8), skin, 0, 0.09, 0.118);

  const eyes: THREE.Group[] = [];
  const brows: THREE.Mesh[] = [];
  for (const side of [1, -1]) {
    const eye = new THREE.Group();
    eye.position.set(side * 0.042, 0.115, 0.098);
    head.add(eye);
    add(eye, new THREE.SphereGeometry(0.021, 16, 12), white);
    add(eye, new THREE.SphereGeometry(0.0105, 12, 8), dark, 0, 0, 0.016);
    eyes.push(eye);
    brows.push(add(head, new THREE.BoxGeometry(0.045, 0.008, 0.01), dark, side * 0.045, 0.158, 0.108));
  }

  const mouth = add(head, new THREE.BufferGeometry(), lip, 0, 0.048, 0.114);
  let mouthKey = '';

  const shoulders: THREE.Group[] = [];
  const elbows: THREE.Group[] = [];
  for (const side of [1, -1]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.2, 1.22, 0);
    root.add(shoulder);
    add(shoulder, new THREE.CapsuleGeometry(0.045, 0.2, 6, 12), shirt, 0, -0.14, 0);
    const elbow = new THREE.Group();
    elbow.position.set(0, -0.28, 0);
    shoulder.add(elbow);
    add(elbow, new THREE.CapsuleGeometry(0.038, 0.18, 6, 12), skin, 0, -0.12, 0);
    add(elbow, new THREE.SphereGeometry(0.045, 12, 8), skin, 0, -0.26, 0);
    shoulders.push(shoulder);
    elbows.push(elbow);
  }

  function setMouth(face: FaceState) {
    const w = 0.034 + face.smile * 0.008;
    const corner = (face.smile - face.frown) * 0.014;
    const open = 0.002 + face.jaw * 0.032 + face.eyeWide * 0.006;
    const key = [w, corner, open].map((v) => v.toFixed(4)).join();
    if (key === mouthKey) return;
    mouthKey = key;
    const s = new THREE.Shape();
    s.moveTo(-w, corner);
    s.quadraticCurveTo(0, 0.003 + open * 0.3, w, corner);
    s.quadraticCurveTo(0, -0.003 - open * 2, -w, corner);
    mouth.geometry.dispose();
    mouth.geometry = new THREE.ShapeGeometry(s, 12);
  }

  function setArm(i: number, side: number, arm: ArmPose) {
    shoulders[i].rotation.set(-arm.forward, 0, side * arm.out);
    elbows[i].rotation.x = -arm.elbow;
  }

  return {
    root,
    headPosition: new THREE.Vector3(0, 1.46, 0),
    apply(face: FaceState, body: BodyState) {
      neck.rotation.set(-body.headPitch * 0.35, body.headYaw * 0.35, body.headRoll * 0.3);
      head.rotation.set(-body.headPitch * 0.65, body.headYaw * 0.65, body.headRoll * 0.7);

      const open = THREE.MathUtils.clamp(1 - face.blink - 0.35 * face.squint + 0.25 * face.eyeWide, 0.08, 1.25);
      eyes.forEach((eye, i) => {
        eye.rotation.set(-body.eyePitch, body.eyeYaw, 0);
        eye.scale.y = open;
        const side = i === 0 ? 1 : -1;
        brows[i].position.y = 0.158 + (face.browUp - face.browDown * 0.6) * 0.018;
        // Positive z lifts the outer (+x) end of the left brow, so the inner end drops.
        brows[i].rotation.z = side * (face.browDown * 0.35 - face.frown * 0.35);
      });
      setMouth(face);

      shoulders.forEach((s) => (s.position.y = 1.22 + body.shrug * 0.035));
      setArm(0, 1, body.left);
      setArm(1, -1, body.right);
    },
    update() {},
  };
}
