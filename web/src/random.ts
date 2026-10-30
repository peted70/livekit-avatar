/**
 * A source of random numbers in [0, 1). Everything that makes random choices (idle motion,
 * talk gestures, camera cuts, caption styles) takes one, so a scene can seed them and a replay
 * makes the same choices at the same moments. Live sessions just use Math.random.
 */
export type Rng = () => number;

/** mulberry32: small and fast, and plenty for animation. */
export function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seeded source named by some text, such as "tech-news/pete" (FNV-1a hash). */
export function seededBy(name: string): Rng {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193);
  return seeded(h);
}
