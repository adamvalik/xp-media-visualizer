import { AudioAnalysis } from './analysis';
import { DemoSynth } from './DemoSynth';

export type SourceKind = 'mic' | 'tab' | 'demo' | 'file';
export type PlayState = 'idle' | 'connecting' | 'playing' | 'paused' | 'stopped' | 'error';

const AUDIO_EXT = /\.(mp3|wav|ogg|oga|flac|m4a|aac|opus|webm|aif|aiff)$/i;

export const isAudioFile = (file: File) => file.type.startsWith('audio/') || AUDIO_EXT.test(file.name);

const prettyName = (name: string) => name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ');

/**
 * Owns the AudioContext and whichever source is feeding the analyser.
 *
 * Graph: source -> analyser (always, for visuals)
 *        source -> output -> speakers (only for files and the demo; live
 *        inputs are never monitored, which would cause feedback).
 */
export class AudioEngine extends EventTarget {
  readonly analysis = new AudioAnalysis();

  kind: SourceKind | null = null;
  state: PlayState = 'idle';
  label = '';
  error = '';
  files: File[] = [];
  fileIndex = 0;
  micDeviceId = '';

  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private output: GainNode | null = null;
  private stream: MediaStream | null = null;
  private streamNode: MediaStreamAudioSourceNode | null = null;
  private media: HTMLAudioElement | null = null;
  private mediaUrl = '';
  private demo: DemoSynth | null = null;
  private token = 0;
  private clockStart = 0;
  private clockAccum = 0;
  private clockRunning = false;
  private _volume = 0.8;
  private _muted = false;

  get volume() {
    return this._volume;
  }
  set volume(v: number) {
    this._volume = Math.min(1, Math.max(0, v));
    this.applyVolume();
    this.emit();
  }

  get muted() {
    return this._muted;
  }
  set muted(m: boolean) {
    this._muted = m;
    this.applyVolume();
    this.emit();
  }

  /** Seconds since playback started (or position in the current file). */
  get elapsed() {
    if (this.kind === 'file' && this.media) return this.media.currentTime || 0;
    return this.clockAccum + (this.clockRunning ? (performance.now() - this.clockStart) / 1000 : 0);
  }

  get duration() {
    if (this.kind === 'file' && this.media && Number.isFinite(this.media.duration)) return this.media.duration;
    return 0;
  }

  get seekable() {
    return this.kind === 'file' && this.duration > 0;
  }

  get isLive() {
    return this.kind === 'mic' || this.kind === 'tab';
  }

  get playing() {
    return this.state === 'playing';
  }

  static tabCaptureSupported() {
    return typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  }

  async listInputs(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audioinput');
  }

  /** Creates (or resumes) the context synchronously so it stays inside the user gesture. */
  private context(): AudioContext {
    if (!this.ctx) {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 4096;
      analyser.smoothingTimeConstant = 0.5;
      analyser.minDecibels = -120;
      analyser.maxDecibels = 0;
      const output = ctx.createGain();
      output.connect(ctx.destination);
      this.ctx = ctx;
      this.analyser = analyser;
      this.output = output;
      this.analysis.attach(analyser, ctx.sampleRate);
      this.applyVolume();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  private applyVolume() {
    if (!this.output || !this.ctx) return;
    const gain = this._muted ? 0 : this._volume * this._volume;
    this.output.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.02);
  }

  async useMic(deviceId = this.micDeviceId): Promise<void> {
    const token = this.begin('mic', 'Microphone');
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      this.fail(token, 'The microphone needs a secure page (https:// or localhost).');
      return;
    }
    this.context();
    const constraints = (id: string): MediaStreamConstraints => ({
      audio: {
        deviceId: id ? { exact: id } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints(deviceId));
      } catch (err) {
        if (deviceId && (err as DOMException).name === 'OverconstrainedError') {
          stream = await navigator.mediaDevices.getUserMedia(constraints(''));
        } else {
          throw err;
        }
      }
      if (token !== this.token) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const track = stream.getAudioTracks()[0];
      this.micDeviceId = track?.getSettings().deviceId ?? '';
      this.attachStream(stream, track?.label ? `Microphone (${track.label})` : 'Microphone');
    } catch (err) {
      this.fail(token, describeMediaError(err, 'mic'));
    }
  }

  async useTab(): Promise<void> {
    const token = this.begin('tab', 'Browser tab audio');
    if (!AudioEngine.tabCaptureSupported()) {
      this.fail(token, 'This browser cannot capture tab audio. Use Chrome or Edge, or pick the microphone.');
      return;
    }
    this.context();
    try {
      // Chrome only shares audio alongside video; the video track is simply ignored.
      const options = {
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        systemAudio: 'include',
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
      } as DisplayMediaStreamOptions;
      const stream = await navigator.mediaDevices.getDisplayMedia(options);
      if (token !== this.token) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      if (stream.getAudioTracks().length === 0) {
        stream.getTracks().forEach((t) => t.stop());
        this.fail(token, 'No audio was shared. In the sharing dialog pick a tab and switch on "Share tab audio".');
        return;
      }
      const name = stream.getVideoTracks()[0]?.label;
      this.attachStream(stream, name ? `Tab audio (${name})` : 'Browser tab audio');
    } catch (err) {
      this.fail(token, describeMediaError(err, 'tab'));
    }
  }

  useDemo() {
    const token = this.begin('demo', 'Demo Beat (built-in synth)');
    const ctx = this.context();
    const demo = new DemoSynth(ctx);
    demo.output.connect(this.analyser!);
    demo.output.connect(this.output!);
    demo.start();
    this.demo = demo;
    if (token === this.token) this.setPlaying();
  }

  /** Queues files and starts the first playable one. Returns how many were accepted. */
  useFiles(files: File[]): number {
    const audio = files.filter(isAudioFile);
    if (audio.length === 0) return 0;
    this.files = audio;
    void this.playFile(0);
    return audio.length;
  }

  async playFile(index: number): Promise<void> {
    const file = this.files[index];
    if (!file) return;
    this.fileIndex = index;
    const token = this.begin('file', prettyName(file.name));
    const ctx = this.context();
    const media = this.ensureMedia(ctx);
    if (this.mediaUrl) URL.revokeObjectURL(this.mediaUrl);
    this.mediaUrl = URL.createObjectURL(file);
    media.src = this.mediaUrl;
    try {
      await media.play();
      if (token === this.token) this.setPlaying();
    } catch (err) {
      this.fail(token, `Could not play "${file.name}". ${(err as Error).message ?? ''}`.trim());
    }
  }

  private ensureMedia(ctx: AudioContext) {
    if (!this.media) {
      const media = new Audio();
      media.preload = 'auto';
      const node = ctx.createMediaElementSource(media);
      node.connect(this.analyser!);
      node.connect(this.output!);
      media.addEventListener('ended', () => {
        if (this.kind !== 'file') return;
        if (this.fileIndex < this.files.length - 1) void this.playFile(this.fileIndex + 1);
        else {
          this.state = 'stopped';
          this.emit();
        }
      });
      media.addEventListener('loadedmetadata', () => this.emit());
      this.media = media;
    }
    return this.media;
  }

  private attachStream(stream: MediaStream, label: string) {
    const ctx = this.context();
    this.stream = stream;
    this.streamNode = ctx.createMediaStreamSource(stream);
    this.streamNode.connect(this.analyser!);
    this.label = label;
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', () => {
        if (this.stream !== stream) return;
        this.teardown();
        this.state = 'stopped';
        this.label = `${label}, disconnected`;
        this.emit();
      });
    }
    this.setPlaying();
  }

  togglePlay() {
    if (this.state === 'playing') this.pause();
    else if (this.state === 'paused') this.resume();
    else this.restart();
  }

  pause() {
    if (this.state !== 'playing') return;
    if (this.kind === 'file') this.media?.pause();
    else if (this.kind === 'demo') this.demo?.stop();
    else this.streamNode?.disconnect();
    this.state = 'paused';
    this.stopClock();
    this.emit();
  }

  resume() {
    if (this.state !== 'paused') return;
    this.context();
    if (this.kind === 'file') void this.media?.play();
    else if (this.kind === 'demo') this.demo?.start();
    else this.streamNode?.connect(this.analyser!);
    this.setPlaying();
  }

  /** Starts the last used source again (defaults to the microphone). */
  restart(kind: SourceKind = this.kind ?? 'mic') {
    switch (kind) {
      case 'mic': return void this.useMic();
      case 'tab': return void this.useTab();
      case 'demo': return this.useDemo();
      case 'file':
        if (this.files.length) return void this.playFile(this.fileIndex);
        return void this.useMic();
    }
  }

  stop() {
    if (this.kind === 'file' && this.media) {
      this.media.pause();
      this.media.currentTime = 0;
    } else {
      this.teardown();
    }
    this.token++;
    this.state = this.kind ? 'stopped' : 'idle';
    this.resetClock();
    this.emit();
  }

  /** Previous / next track; returns false when there is no file queue to move through. */
  skip(delta: number): boolean {
    if (this.kind !== 'file' || this.files.length < 2) return false;
    const next = (this.fileIndex + delta + this.files.length) % this.files.length;
    void this.playFile(next);
    return true;
  }

  seek(fraction: number) {
    if (!this.seekable || !this.media) return;
    this.media.currentTime = Math.min(Math.max(fraction, 0), 1) * this.duration;
    this.emit();
  }

  private begin(kind: SourceKind, label: string): number {
    this.teardown();
    this.token++;
    this.kind = kind;
    this.label = label;
    this.error = '';
    this.state = 'connecting';
    this.resetClock();
    this.emit();
    return this.token;
  }

  private setPlaying() {
    this.state = 'playing';
    this.error = '';
    this.startClock();
    this.emit();
  }

  private fail(token: number, message: string) {
    if (token !== this.token) return;
    this.teardown();
    this.state = 'error';
    this.error = message;
    this.emit();
  }

  private teardown() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.streamNode?.disconnect();
    this.streamNode = null;
    this.demo?.dispose();
    this.demo = null;
    this.media?.pause();
    this.stopClock();
  }

  private startClock() {
    if (this.clockRunning) return;
    this.clockStart = performance.now();
    this.clockRunning = true;
  }

  private stopClock() {
    if (!this.clockRunning) return;
    this.clockAccum += (performance.now() - this.clockStart) / 1000;
    this.clockRunning = false;
  }

  private resetClock() {
    this.clockAccum = 0;
    this.clockRunning = false;
  }

  private emit() {
    this.dispatchEvent(new Event('change'));
  }
}

function describeMediaError(err: unknown, kind: 'mic' | 'tab'): string {
  const name = (err as DOMException)?.name;
  if (kind === 'tab') {
    if (name === 'NotAllowedError') return 'Sharing was cancelled or blocked.';
    return `Could not capture tab audio (${name ?? 'unknown error'}).`;
  }
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone access was blocked. Allow it in the site settings, then press Play.';
    case 'NotFoundError':
      return 'No microphone was found.';
    case 'NotReadableError':
      return 'The microphone is busy or unavailable (another app may be using it).';
    default:
      return `Could not open the microphone (${name ?? 'unknown error'}).`;
  }
}
