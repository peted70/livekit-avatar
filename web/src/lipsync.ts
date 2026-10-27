/** Mouth shapes (Oculus viseme names) that the analysis can tell apart from audio alone. */
export const VISEMES = ['aa', 'E', 'I', 'O', 'U', 'SS'] as const;
export type Viseme = (typeof VISEMES)[number];
export type Visemes = Record<Viseme, number>;

export interface Mouth {
  /** Overall opening 0..1, for rigs without viseme shapes. */
  jaw: number;
  /** Viseme weights 0..1, already scaled by loudness. */
  visemes: Visemes;
}

export const silentMouth = (): Mouth => ({ jaw: 0, visemes: { aa: 0, E: 0, I: 0, O: 0, U: 0, SS: 0 } });

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/**
 * Estimates the mouth shape from one magnitude spectrum (dB per bin, as from AnalyserNode).
 * Vowels are placed by two rough formant estimates: the energy centroid of 200–1000 Hz says how
 * open the mouth is (F1), the centroid of 900–3000 Hz how spread or rounded the lips are (F2).
 * Hiss above 4 kHz means a sibilant.
 */
export function analyse(db: Float32Array, sampleRate: number): Mouth {
  const hz = sampleRate / 2 / db.length;
  const band = (lo: number, hi: number) => {
    let energy = 0, moment = 0;
    for (let i = Math.ceil(lo / hz); i <= Math.min(db.length - 1, hi / hz); i++) {
      const p = 10 ** (db[i] / 10);
      energy += p;
      moment += p * i * hz;
    }
    return { energy, centroid: energy > 0 ? moment / energy : 0 };
  };
  const low = band(200, 1000), mid = band(900, 3000), hiss = band(4000, 9000);
  const total = low.energy + mid.energy + hiss.energy;
  const level = clamp01((10 * Math.log10(total + 1e-12) + 62) / 34);
  if (level === 0) return silentMouth();

  const sibilance = clamp01((hiss.energy / total - 0.25) * 2.5);
  const voiced = level * (1 - sibilance);
  // Rounded vowels have little energy above 900 Hz; "ah" has a strong F2 there.
  const tilt = 10 * Math.log10((mid.energy + 1e-12) / (band(200, 900).energy + 1e-12));
  const open = clamp01((low.centroid - 340) / 280);
  const front = clamp01((mid.centroid - 1750) / 700);
  const round = clamp01((1750 - mid.centroid) / 400) * clamp01((-tilt - 8) / 8);
  return {
    jaw: level * (0.35 + 0.65 * open),
    visemes: {
      aa: voiced * open * (1 - front) * (1 - round),
      E: voiced * front * (0.3 + 0.7 * open),
      I: voiced * front * (1 - open),
      O: voiced * round * (0.3 + 0.7 * open),
      U: voiced * round * (1 - open),
      SS: level * sibilance,
    },
  };
}

/** Lip sync from the agent's audio, worked out on the device. */
export class LipSync {
  private ctx = new AudioContext();
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private spectrum = new Float32Array(512);
  private mouth = silentMouth();

  resume(): Promise<void> {
    return this.ctx.resume();
  }

  connect(track: MediaStreamTrack): void {
    this.source?.disconnect();
    this.analyser ??= Object.assign(this.ctx.createAnalyser(), {
      fftSize: this.spectrum.length * 2,
      smoothingTimeConstant: 0.3,
    });
    this.source = this.ctx.createMediaStreamSource(new MediaStream([track]));
    this.source.connect(this.analyser);
  }

  disconnect(): void {
    this.source?.disconnect();
    this.source = null;
  }

  sample(dt: number): Mouth {
    let target = silentMouth();
    if (this.source && this.analyser) {
      this.analyser.getFloatFrequencyData(this.spectrum);
      target = analyse(this.spectrum, this.ctx.sampleRate);
    }
    // Open fast, close a little slower.
    const ease = (from: number, to: number) => from + (to - from) * (1 - Math.exp(-(to > from ? 30 : 14) * dt));
    this.mouth.jaw = ease(this.mouth.jaw, target.jaw);
    for (const v of VISEMES) this.mouth.visemes[v] = ease(this.mouth.visemes[v], target.visemes[v]);
    return this.mouth;
  }
}
