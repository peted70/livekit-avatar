import * as THREE from 'three';
import type { Direction } from './behaviour';

const SEAT_ANGLES = [0.7, -0.7, 1.15, -1.15, 0.4, -0.4];
const LABEL_RADIUS = 0.55;

/**
 * Where the other people are, from this device's point of view. The local viewer is the
 * camera, straight ahead; remote people get seats around the avatar, marked with labels.
 */
export class Seats {
  localIdentity: string | null = null;
  private seats = new Map<string, { angle: number; label: THREE.Sprite }>();

  constructor(
    private scene: THREE.Scene,
    private headHeight: number,
  ) {}

  add(identity: string, name: string): void {
    if (this.seats.has(identity)) return;
    const used = new Set([...this.seats.values()].map((s) => s.angle));
    const angle = SEAT_ANGLES.find((a) => !used.has(a)) ?? 0.9;
    const label = makeLabel(name || identity);
    label.position.set(Math.sin(angle) * LABEL_RADIUS, this.headHeight + 0.12, Math.cos(angle) * LABEL_RADIUS);
    this.scene.add(label);
    this.seats.set(identity, { angle, label });
  }

  remove(identity: string): void {
    const seat = this.seats.get(identity);
    if (!seat) return;
    this.scene.remove(seat.label);
    seat.label.material.map?.dispose();
    seat.label.material.dispose();
    this.seats.delete(identity);
  }

  clear(): void {
    for (const id of [...this.seats.keys()]) this.remove(id);
  }

  has(identity: string): boolean {
    return this.seats.has(identity);
  }

  resolve = (identity: string | null): Direction => {
    const seat = identity ? this.seats.get(identity) : undefined;
    // The local viewer (or nobody in particular) is straight ahead, through the camera.
    return seat ? { yaw: seat.angle, pitch: 0 } : { yaw: 0, pitch: 0 };
  };

  highlight(identity: string | null): void {
    for (const [id, seat] of this.seats) seat.label.material.opacity = id === identity ? 1 : 0.45;
  }
}

function makeLabel(text: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const g = canvas.getContext('2d')!;
  g.fillStyle = 'rgba(20, 22, 30, 0.85)';
  g.beginPath();
  g.roundRect(4, 8, 248, 48, 24);
  g.fill();
  g.fillStyle = '#fff';
  g.font = '600 26px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text.slice(0, 16), 128, 33);
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, opacity: 0.45, depthWrite: false }),
  );
  sprite.scale.set(0.16, 0.04, 1);
  return sprite;
}
