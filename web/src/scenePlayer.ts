import type { BehaviourMsg } from './behaviour';
import type { Performer } from './performer';

/** A built scene: web/public/scenes/<name>/scene.json, from tools/build_scene.py. */
export interface Scene {
  version: number;
  title: string;
  cast: { id: string; avatar: string | null; voice: string }[];
  lines: SceneLine[];
}

export interface SceneLine {
  /** Line number in the script. */
  number: number;
  speaker: string;
  /** Caption text, without audio tags. */
  text: string;
  /** File name, next to scene.json. */
  audio: string;
  duration: number;
  words: { text: string; start: number; end: number }[];
  /** `t` is seconds from the start of the line; an event goes to the speaker unless it names a performer. */
  events: { t: number; performer?: string; msg: BehaviourMsg }[];
}

export async function loadScene(name: string): Promise<{ scene: Scene; base: string }> {
  const base = `/scenes/${encodeURIComponent(name)}/`;
  const res = await fetch(`${base}scene.json`);
  if (!res.ok || res.headers.get('content-type')?.includes('text/html')) {
    throw new Error(`No scene "${name}": build it with tools/build_scene.py scenes/${name}.md`);
  }
  return { scene: (await res.json()) as Scene, base };
}

interface Cue {
  /** AudioContext time. */
  at: number;
  run: () => void;
}

/** Where playback is: a line, and seconds into it. */
export interface Position {
  line: number;
  offset: number;
}

/**
 * Plays a scene: each line's audio in turn, into the speaker's lip sync, and each event to its
 * performer when the audio clock reaches it, so behaviour stays with the audio if a frame drops.
 * The speaker gets agent_state speaking/listening around their line, the others user_state, as
 * if they were listening to a person. Captions get the line's words as each is spoken.
 * Can start from any line, pause and resume. Call update() every frame.
 */
export class ScenePlayer {
  /** Silence between lines, in seconds; a change applies from the next play or resume. */
  gap = 0.35;
  onEnd?: () => void;
  /** Line `index` has started. */
  onLine?: (index: number) => void;
  /** The words of line `index` spoken so far. */
  onWords?: (line: SceneLine, index: number, text: string) => void;
  /** Every line's audio passes through here on its way to the speakers; tap it to record. */
  readonly output: GainNode;

  private buffers: AudioBuffer[] = [];
  private sources: AudioBufferSourceNode[] = [];
  private cues: Cue[] = [];
  /** AudioContext time each scheduled line starts (as if from its beginning), by line. */
  private starts = new Map<number, number>();
  private endsAt = Infinity;
  private pausedAt: Position | null = null;

  constructor(
    readonly scene: Scene,
    private base: string,
    private ctx: AudioContext,
    private cast: Map<string, Performer>,
    private send: (performer: Performer, msg: BehaviourMsg) => void,
  ) {
    this.output = ctx.createGain();
    this.output.connect(ctx.destination);
  }

  get playing(): boolean {
    return this.sources.length > 0;
  }

  get paused(): boolean {
    return this.pausedAt !== null;
  }

  /** Fetches and decodes every line's audio. */
  async load(): Promise<void> {
    this.buffers = await Promise.all(
      this.scene.lines.map(async (line) => this.ctx.decodeAudioData(await (await fetch(this.base + line.audio)).arrayBuffer())),
    );
  }

  /**
   * Plays from line `from`, `offset` seconds in. Starting partway through a line, its emotion and
   * gaze so far are applied at once, and gestures already past are skipped.
   */
  play(from = 0, offset = 0): void {
    this.stop();
    let at = this.ctx.currentTime + 0.3;
    for (let i = from; i < this.scene.lines.length; i++) {
      const line = this.scene.lines[i];
      const skip = i === from ? Math.min(offset, line.duration) : 0;
      const start = at - skip;
      const speaker = this.cast.get(line.speaker)!;
      const src = Object.assign(this.ctx.createBufferSource(), { buffer: this.buffers[i] });
      src.connect(this.output);
      src.connect(speaker.lipsync.input);
      src.start(at, skip);
      this.sources.push(src);
      this.starts.set(i, start);

      const end = start + line.duration;
      this.cues.push({ at, run: () => this.onLine?.(i) });
      this.tell(at, speaker, { type: 'agent_state', state: 'speaking' });
      for (const e of line.events) {
        const caughtUp = e.t < skip && (e.msg.type === 'emotion' || e.msg.type === 'gaze');
        if (e.t >= skip || caughtUp) this.tell(Math.max(at, start + e.t), this.cast.get(e.performer ?? line.speaker)!, e.msg);
      }
      this.tell(end, speaker, { type: 'agent_state', state: 'listening' });
      for (const other of this.cast.values()) {
        if (other === speaker) continue;
        this.tell(at, other, { type: 'user_state', state: 'speaking' });
        this.tell(end, other, { type: 'user_state', state: 'listening' });
      }
      line.words.forEach((w, k) => {
        const text = line.words.slice(0, k + 1).map((w) => w.text).join(' ');
        this.cues.push({ at: Math.max(at, start + w.start), run: () => this.onWords?.(line, i, text) });
      });
      this.endsAt = end;
      at = end + this.gap;
    }
    // Stable, so cues at the same moment keep the order they were added in.
    this.cues.sort((a, b) => a.at - b.at);
  }

  /** Where playback has got to, or where it's paused. */
  position(): Position {
    if (this.pausedAt) return this.pausedAt;
    const now = this.ctx.currentTime;
    let pos: Position = { line: 0, offset: 0 };
    for (const [line, start] of this.starts) {
      if (start > now) break;
      const offset = now - start;
      // In the gap after a line: the next one, from its start.
      pos = offset < this.scene.lines[line].duration ? { line, offset } : { line: Math.min(line + 1, this.scene.lines.length - 1), offset: 0 };
    }
    return pos;
  }

  pause(): void {
    if (!this.playing) return;
    const pos = this.position();
    this.stop();
    this.pausedAt = pos;
  }

  resume(): void {
    const pos = this.pausedAt;
    if (pos) this.play(pos.line, pos.offset);
  }

  stop(): void {
    for (const src of this.sources) {
      src.stop();
      src.disconnect();
    }
    this.sources = [];
    this.cues = [];
    this.starts.clear();
    this.endsAt = Infinity;
    this.pausedAt = null;
  }

  update(): void {
    const now = this.ctx.currentTime;
    let due = 0;
    while (due < this.cues.length && this.cues[due].at <= now) due++;
    for (const cue of this.cues.splice(0, due)) cue.run();
    if (this.playing && now >= this.endsAt) {
      this.stop();
      this.onEnd?.();
    }
  }

  private tell(at: number, performer: Performer, msg: BehaviourMsg): void {
    this.cues.push({ at, run: () => this.send(performer, msg) });
  }
}
