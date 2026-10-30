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

/**
 * Plays a scene: each line's audio in turn, into the speaker's lip sync, and each event to its
 * performer when the audio clock reaches it, so behaviour stays with the audio if a frame drops.
 * The speaker gets agent_state speaking/listening around their line, the others user_state, as
 * if they were listening to a person. Captions get the line's words as each is spoken.
 * Call update() every frame.
 */
export class ScenePlayer {
  /** Silence between lines, in seconds. */
  gap = 0.35;
  onEnd?: () => void;
  /** The words of line `index` spoken so far. */
  onWords?: (line: SceneLine, index: number, text: string) => void;

  private buffers: AudioBuffer[] = [];
  private sources: AudioBufferSourceNode[] = [];
  private cues: Cue[] = [];
  private endsAt = Infinity;

  constructor(
    readonly scene: Scene,
    private base: string,
    private ctx: AudioContext,
    private cast: Map<string, Performer>,
    private send: (performer: Performer, msg: BehaviourMsg) => void,
  ) {}

  get playing(): boolean {
    return this.sources.length > 0;
  }

  /** Fetches and decodes every line's audio. */
  async load(): Promise<void> {
    this.buffers = await Promise.all(
      this.scene.lines.map(async (line) => this.ctx.decodeAudioData(await (await fetch(this.base + line.audio)).arrayBuffer())),
    );
  }

  play(): void {
    this.stop();
    let at = this.ctx.currentTime + 0.3;
    for (const [i, line] of this.scene.lines.entries()) {
      const speaker = this.cast.get(line.speaker)!;
      const src = Object.assign(this.ctx.createBufferSource(), { buffer: this.buffers[i] });
      src.connect(this.ctx.destination);
      src.connect(speaker.lipsync.input);
      src.start(at);
      this.sources.push(src);

      const end = at + line.duration;
      this.tell(at, speaker, { type: 'agent_state', state: 'speaking' });
      for (const e of line.events) this.tell(at + e.t, this.cast.get(e.performer ?? line.speaker)!, e.msg);
      this.tell(end, speaker, { type: 'agent_state', state: 'listening' });
      for (const other of this.cast.values()) {
        if (other === speaker) continue;
        this.tell(at, other, { type: 'user_state', state: 'speaking' });
        this.tell(end, other, { type: 'user_state', state: 'listening' });
      }
      line.words.forEach((w, k) => {
        const text = line.words.slice(0, k + 1).map((w) => w.text).join(' ');
        this.cues.push({ at: at + w.start, run: () => this.onWords?.(line, i, text) });
      });
      this.endsAt = end;
      at = end + this.gap;
    }
    // Stable, so cues at the same moment keep the order they were added in.
    this.cues.sort((a, b) => a.at - b.at);
  }

  stop(): void {
    for (const src of this.sources) {
      src.stop();
      src.disconnect();
    }
    this.sources = [];
    this.cues = [];
    this.endsAt = Infinity;
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
