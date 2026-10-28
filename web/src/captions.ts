export type Speaker = 'agent' | 'you';

/** How long a line stays up after it was last updated, in ms. */
const LINGER_MS = 1800;
/** Matches the exit animations in style.css. */
const EXIT_MS = 450;

/**
 * How the agent's words are presented. Each reply picks one, leaning on the avatar's emotion.
 * "rolling" styles drop the oldest word as a new one arrives; "chunk" styles swap the whole group.
 */
const STYLES = {
  slam: { max: 4, mode: 'rolling' },
  teletype: { max: 6, mode: 'rolling' },
  tiktok: { max: 3, mode: 'chunk' },
  bounce: { max: 3, mode: 'chunk' },
  blur: { max: 4, mode: 'rolling' },
} as const;
export type Style = keyof typeof STYLES;
export const CAPTION_STYLES = Object.keys(STYLES) as Style[];

const EMOTION_STYLES: Record<string, Style[]> = {
  surprised: ['slam', 'slam', 'tiktok'],
  thinking: ['teletype', 'teletype', 'blur'],
  neutral: ['teletype', 'blur', 'tiktok'],
  happy: ['tiktok', 'tiktok', 'bounce'],
  amused: ['bounce', 'bounce', 'slam'],
  concerned: ['blur', 'blur', 'teletype'],
  curious: ['blur', 'tiktok', 'teletype'],
};

const rand = (a: number, b: number) => a + Math.random() * (b - a);

interface Line {
  el: HTMLElement;
  segment: string | null;
  style: Style;
  /** Word slots on screen, oldest first. */
  words: HTMLElement[];
  /** How many of the segment's words have been placed, including ones that have since gone. */
  placed: number;
  timer?: number;
}

/**
 * Animated live subtitles, fed from LiveKit's lk.transcription text streams. The agent's words
 * appear as they're spoken in one of several styles (slam, teletype, TikTok pop, Reels bounce,
 * blur reveal), chosen per reply. Words that stay on screen glide to their new place as the
 * line re-centres. Your words type out in yellow.
 */
export class Captions {
  enabled = true;
  private lines = new Map<Speaker, Line>();
  private emotion = 'neutral';
  private lastStyle: Style | null = null;
  /** Set to use one style for every reply instead of picking. */
  fixedStyle: Style | null = null;

  constructor(private root: HTMLElement) {
    for (const speaker of ['you', 'agent'] as const) {
      const el = document.createElement('div');
      el.className = `caption ${speaker}`;
      root.append(el);
      this.lines.set(speaker, { el, segment: null, style: 'teletype', words: [], placed: 0 });
    }
  }

  /** The emotion tints the glow and highlight (see style.css) and steers the next reply's style. */
  setEmotion(name: string): void {
    this.emotion = name;
    this.root.dataset.emotion = name;
  }

  show(speaker: Speaker, segment: string, text: string): void {
    if (!this.enabled) return;
    const line = this.lines.get(speaker)!;
    if (segment !== line.segment) {
      this.exit(line, line.words.length);
      line.segment = segment;
      line.placed = 0;
      if (speaker === 'agent') line.el.dataset.style = line.style = this.pickStyle();
    }

    const tokens = text.trim().split(/\s+/).filter(Boolean);
    // The last word may still be growing as it's spelled out; refresh it if it's on screen.
    const last = line.words.at(-1);
    if (last && line.placed > 0 && line.placed <= tokens.length) this.setText(line, last, tokens[line.placed - 1]);

    const fresh = tokens.slice(line.placed);
    line.placed = Math.max(line.placed, tokens.length);
    if (fresh.length) {
      const { max, mode } = speaker === 'agent' ? STYLES[line.style] : { max: 8, mode: 'rolling' as const };
      this.glide(line, () => {
        for (const token of fresh) {
          if (line.words.length >= max) this.exit(line, mode === 'chunk' ? line.words.length : 1);
          line.words.push(this.word(line, token));
        }
      });
      line.words.forEach((w, i) => w.classList.toggle('older', i < line.words.length - 1));
    }

    clearTimeout(line.timer);
    line.timer = window.setTimeout(() => this.exit(line, line.words.length), LINGER_MS);
  }

  clear(): void {
    for (const line of this.lines.values()) {
      clearTimeout(line.timer);
      this.exit(line, line.words.length);
      line.segment = null;
      line.placed = 0;
    }
  }

  private pickStyle(): Style {
    if (this.fixedStyle) return this.fixedStyle;
    const options = (EMOTION_STYLES[this.emotion] ?? EMOTION_STYLES.neutral).filter((s) => s !== this.lastStyle);
    return (this.lastStyle = options[Math.floor(Math.random() * options.length)] ?? 'slam');
  }

  private word(line: Line, token: string): HTMLElement {
    const slot = document.createElement('span');
    slot.className = 'slot';
    const w = document.createElement('span');
    w.className = 'w';
    w.style.setProperty('--r', `${rand(-12, 12).toFixed(1)}deg`);
    slot.append(w);
    this.setText(line, slot, token);
    line.el.append(slot);
    return slot;
  }

  /** Teletype prints letter by letter, so its words are split into characters. */
  private setText(line: Line, slot: HTMLElement, token: string): void {
    const w = slot.firstElementChild as HTMLElement;
    if (w.dataset.text === token) return;
    w.dataset.text = token;
    if (line.style === 'teletype' && line.el.classList.contains('agent')) {
      w.replaceChildren(
        ...[...token].map((ch, i) => {
          const c = document.createElement('span');
          c.className = 'ch';
          c.textContent = ch;
          c.style.setProperty('--i', String(i));
          return c;
        }),
      );
    } else {
      w.textContent = token;
    }
  }

  /**
   * Smooth re-layout (FLIP): note where the words are, change the line, then animate each
   * surviving word from its old position to its new one instead of letting it jump.
   */
  private glide(line: Line, change: () => void): void {
    const before = new Map(line.words.map((w) => [w, w.getBoundingClientRect()]));
    change();
    for (const [w, was] of before) {
      if (!w.isConnected || w.classList.contains('out')) continue;
      const now = w.getBoundingClientRect();
      const dx = was.left - now.left, dy = was.top - now.top;
      if (Math.abs(dx) + Math.abs(dy) < 1) continue;
      w.animate([{ translate: `${dx}px ${dy}px` }, { translate: '0 0' }], { duration: 260, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
    }
  }

  /** Sends the oldest `n` words off with the style's exit, then removes them. */
  private exit(line: Line, n: number): void {
    const box = line.el.getBoundingClientRect();
    const leaving = line.words.splice(0, n);
    // Measure first, then take them out of the flow, so the remaining words can glide at once.
    const rects = leaving.map((w) => w.getBoundingClientRect());
    leaving.forEach((w, i) => {
      w.style.setProperty('--dx', `${rand(-220, 220).toFixed(0)}px`);
      w.style.setProperty('--dy', `${rand(-180, -60).toFixed(0)}px`);
      w.style.setProperty('--dr', `${rand(-110, 110).toFixed(0)}deg`);
      Object.assign(w.style, { position: 'absolute', left: `${rects[i].left - box.left}px`, top: `${rects[i].top - box.top}px` });
      w.classList.add('out');
      setTimeout(() => w.remove(), EXIT_MS);
    });
  }
}
