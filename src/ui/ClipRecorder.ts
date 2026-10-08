export type ClipFormat = 'wide' | 'square' | 'tall';

export const CLIP_FORMATS: Record<ClipFormat, { name: string; width: number; height: number }> = {
  wide: { name: 'Wide 16:9', width: 1920, height: 1080 },
  square: { name: 'Square 1:1', width: 1080, height: 1080 },
  tall: { name: 'Tall 9:16', width: 1080, height: 1920 },
};

export interface ClipCaption {
  title: string;
  subtitle: string;
}

export interface Clip {
  blob: Blob;
  extension: 'mp4' | 'webm';
  seconds: number;
}

/** MP4 first: it plays and uploads everywhere. Chrome 126+ and Safari record it; Firefox falls back to WebM. */
const TYPES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

/**
 * Records the visualization with its sound as a video clip. Every rendered frame is copied onto a
 * canvas of the clip's size (cropped to fill it), with the song title on top if wanted, and that
 * canvas is recorded together with the audio.
 */
export class ClipRecorder extends EventTarget {
  private readonly canvas = document.createElement('canvas');
  private readonly ctx = this.canvas.getContext('2d')!;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private maxSeconds = 30;
  private timer = 0;
  private caption: (() => ClipCaption | null) | null = null;

  static supported() {
    return typeof MediaRecorder !== 'undefined' && 'captureStream' in HTMLCanvasElement.prototype;
  }

  get recording() {
    return this.recorder !== null;
  }

  get elapsed() {
    return this.recorder ? (performance.now() - this.startedAt) / 1000 : 0;
  }

  get limit() {
    return this.maxSeconds;
  }

  start(format: ClipFormat, maxSeconds: number, audio: MediaStream | null, caption: (() => ClipCaption | null) | null) {
    if (this.recorder) return;
    const { width, height } = CLIP_FORMATS[format];
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, width, height);
    this.caption = caption;
    this.maxSeconds = maxSeconds;

    const stream = this.canvas.captureStream(60);
    for (const track of audio?.getAudioTracks() ?? []) stream.addTrack(track.clone());
    const mimeType = TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 12_000_000,
      audioBitsPerSecond: 192_000,
    });
    this.chunks = [];
    recorder.addEventListener('dataavailable', (e) => {
      if (e.data.size) this.chunks.push(e.data);
    });
    recorder.addEventListener('stop', () => {
      for (const track of stream.getTracks()) track.stop();
      const type = recorder.mimeType || mimeType || 'video/webm';
      const clip: Clip = {
        blob: new Blob(this.chunks, { type }),
        extension: type.includes('mp4') ? 'mp4' : 'webm',
        seconds: Math.min(this.elapsed, this.maxSeconds),
      };
      this.recorder = null;
      this.chunks = [];
      window.clearTimeout(this.timer);
      this.dispatchEvent(new CustomEvent<Clip>('done', { detail: clip }));
    });
    recorder.addEventListener('error', () => this.stop());
    recorder.start(1000);
    this.recorder = recorder;
    this.startedAt = performance.now();
    this.timer = window.setTimeout(() => this.stop(), maxSeconds * 1000);
  }

  stop() {
    if (this.recorder?.state === 'recording') this.recorder.stop();
  }

  /** Copies a freshly rendered frame of the visualization (call right after rendering it). */
  drawFrame(source: HTMLCanvasElement) {
    if (!this.recorder || source.width < 2 || source.height < 2) return;
    const { width: w, height: h } = this.canvas;
    const ctx = this.ctx;
    // Cover: fill the clip and crop whatever sticks out.
    const scale = Math.max(w / source.width, h / source.height);
    const sw = w / scale;
    const sh = h / scale;
    ctx.imageSmoothingEnabled = source.style.imageRendering !== 'pixelated';
    ctx.drawImage(source, (source.width - sw) / 2, (source.height - sh) / 2, sw, sh, 0, 0, w, h);
    const caption = this.caption?.();
    if (caption) this.drawCaption(caption);
  }

  /** The song in the lower left, like the WMP "Now Playing" overlay. */
  private drawCaption({ title, subtitle }: ClipCaption) {
    const ctx = this.ctx;
    const { width: w, height: h } = this.canvas;
    const unit = Math.min(w, h) / 1080;
    const x = 64 * unit;
    const maxWidth = w - x * 2;
    ctx.save();
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#fff';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
    ctx.shadowBlur = 14 * unit;
    ctx.shadowOffsetY = 2 * unit;
    let y = h - 64 * unit;
    if (subtitle) {
      ctx.globalAlpha = 0.85;
      ctx.font = `${28 * unit}px Tahoma, 'Segoe UI', Verdana, sans-serif`;
      ctx.fillText(subtitle, x, y, maxWidth);
      y -= 40 * unit;
    }
    ctx.globalAlpha = 1;
    ctx.font = `bold ${46 * unit}px 'Trebuchet MS', 'Segoe UI', Tahoma, sans-serif`;
    ctx.fillText(title, x, y, maxWidth);
    ctx.restore();
  }
}
