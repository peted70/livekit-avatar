import * as THREE from 'three';

export interface Mark {
  position: THREE.Vector3;
  /** Radians from facing the camera (+z); positive turns towards +x. */
  yaw: number;
}

/**
 * Where each of `n` performers stands: left to right on a shallow arc that curves towards the
 * camera, turned in past the arc's centre by `turn`, so they half face each other and half face
 * the camera. One performer stands at the origin, facing the camera.
 */
export function stageMarks(n: number, spacing = 1.0, radius = 1.8, turn = 1.6): Mark[] {
  const step = spacing / radius;
  return Array.from({ length: n }, (_, i) => {
    const a = (i - (n - 1) / 2) * step;
    return { position: new THREE.Vector3(radius * Math.sin(a), 0, radius * (1 - Math.cos(a))), yaw: -a * turn };
  });
}
