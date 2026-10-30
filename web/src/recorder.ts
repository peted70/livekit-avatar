/**
 * Records this browser tab, so the captions (HTML over the canvas) are in the picture, with the
 * scene's own audio taken straight from the player rather than from the tab. Chrome asks which
 * tab to share; pick this one.
 */
export class TabRecorder {
  /** Called if sharing stops from the browser's own "Stop sharing" bar. */
  onEnded?: () => void;

  private chunks: Blob[] = [];
  private stopped: Promise<void>;

  private constructor(
    private recorder: MediaRecorder,
    private display: MediaStream,
    private audio: AudioNode,
    private tap: MediaStreamAudioDestinationNode,
  ) {
    recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.stopped = new Promise((done) => (recorder.onstop = () => done()));
    display.getVideoTracks()[0].onended = () => this.onEnded?.();
  }

  /** Asks to share the tab. Throws if the viewer says no. */
  static async start(audio: AudioNode): Promise<TabRecorder> {
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: false,
      // Chrome: offer this tab first, and leave the cursor out.
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
      cursor: 'never',
    } as DisplayMediaStreamOptions);
    const tap = (audio.context as AudioContext).createMediaStreamDestination();
    audio.connect(tap);
    const stream = new MediaStream([...display.getVideoTracks(), ...tap.stream.getAudioTracks()]);
    const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
    const rec = new TabRecorder(recorder, display, audio, tap);
    recorder.start(1000);
    return rec;
  }

  async stop(): Promise<Blob> {
    if (this.recorder.state !== 'inactive') this.recorder.stop();
    await this.stopped;
    for (const track of this.display.getTracks()) track.stop();
    this.audio.disconnect(this.tap);
    return new Blob(this.chunks, { type: this.recorder.mimeType });
  }
}

export function download(blob: Blob, name: string): void {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
