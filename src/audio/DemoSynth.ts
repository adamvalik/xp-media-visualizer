/**
 * A tiny Web Audio groove so the visualizer can be tried without a
 * microphone: four-on-the-floor kick, claps, hats, an off-beat bass,
 * pads and an arpeggio over Am, F, C, G. After 16 bars comes an 8-bar
 * breakdown with a riser and a snare roll, then it drops back in.
 */

const BPM = 118;
const STEP = 60 / BPM / 4; // sixteenth note
const FULL_BARS = 16;
const BREAKDOWN_BARS = 8;
const LOOP_STEPS = 16 * (FULL_BARS + BREAKDOWN_BARS);

const CHORDS = [
  [57, 60, 64], // Am
  [53, 57, 60], // F
  [48, 52, 55], // C
  [55, 59, 62], // G
];
const BASS_ROOTS = [33, 29, 36, 31];

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export class DemoSynth {
  readonly output: GainNode;
  private readonly bus: DynamicsCompressorNode;
  private readonly noise: AudioBuffer;
  private timer = 0;
  private nextTime = 0;
  private step = 0;

  constructor(private readonly ctx: AudioContext) {
    this.output = ctx.createGain();
    this.output.gain.value = 0.85;
    this.bus = ctx.createDynamicsCompressor();
    this.bus.threshold.value = -16;
    this.bus.ratio.value = 4;
    this.bus.attack.value = 0.004;
    this.bus.release.value = 0.2;
    this.bus.connect(this.output);

    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }

  get running() {
    return this.timer !== 0;
  }

  start() {
    if (this.timer) return;
    this.nextTime = this.ctx.currentTime + 0.05;
    this.timer = window.setInterval(() => this.schedule(), 25);
    this.schedule();
  }

  stop() {
    window.clearInterval(this.timer);
    this.timer = 0;
  }

  dispose() {
    this.stop();
    this.output.disconnect();
  }

  private schedule() {
    while (this.nextTime < this.ctx.currentTime + 0.12) {
      this.playStep(this.step, this.nextTime);
      this.nextTime += STEP;
      this.step = (this.step + 1) % LOOP_STEPS;
    }
  }

  private playStep(step: number, t: number) {
    const barIndex = Math.floor(step / 16);
    const bar = barIndex % 4;
    const s = step % 16;
    const chord = CHORDS[bar];
    if (barIndex >= FULL_BARS) {
      this.playBreakdown(barIndex - FULL_BARS, s, chord, t);
      return;
    }
    const secondHalf = barIndex % 8 >= 4;
    if (step === 0) this.impact(t);

    if (s % 4 === 0) this.kick(t);
    if (s === 4 || s === 12) this.clap(t);
    if (s % 2 === 1) this.hat(t, false);
    if (s % 4 === 2) this.hat(t, true);
    if (s % 4 === 2 || (secondHalf && s % 4 === 3)) this.bass(mtof(BASS_ROOTS[bar] + 12), t, STEP * 1.5);
    if (s === 0) this.pad(chord, t, STEP * 16);
    if (secondHalf || s % 2 === 0) {
      const note = chord[s % 3] + 12 + (s % 8 >= 4 ? 12 : 0);
      this.pluck(mtof(note), t);
    }
  }

  private playBreakdown(b: number, s: number, chord: number[], t: number) {
    if (s === 0) this.pad(chord, t, STEP * 16);
    if (s % 2 === 0) this.pluck(mtof(chord[s % 3] + 12 + (s % 8 >= 4 ? 12 : 0)), t);
    if (b < 4 && s % 4 === 2) this.hat(t, false);
    // Last four bars: riser and a snare roll that doubles up towards the drop.
    if (b === 4 && s === 0) this.riser(t, STEP * 16 * 4);
    if (b >= 4) {
      const every = b < 6 ? 4 : b === 6 ? 2 : 1;
      const progress = (b - 4 + s / 16) / 4;
      if (s % every === 0) this.roll(t, 0.12 + progress * 0.4);
    }
  }

  private envelope(t: number, peak: number, decay: number, attack = 0.002) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    return g;
  }

  private kick(t: number) {
    const osc = this.ctx.createOscillator();
    osc.frequency.setValueAtTime(165, t);
    osc.frequency.exponentialRampToValueAtTime(44, t + 0.12);
    const g = this.envelope(t, 1, 0.42);
    osc.connect(g).connect(this.bus);
    osc.start(t);
    osc.stop(t + 0.5);
  }

  private noiseHit(t: number, filter: BiquadFilterNode, peak: number, decay: number) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const g = this.envelope(t, peak, decay);
    src.connect(filter).connect(g).connect(this.bus);
    src.start(t, Math.random() * 0.5);
    src.stop(t + decay + 0.05);
  }

  private clap(t: number) {
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1700;
    bp.Q.value = 0.9;
    this.noiseHit(t, bp, 0.55, 0.2);

    const tone = this.ctx.createOscillator();
    tone.type = 'triangle';
    tone.frequency.value = 185;
    const g = this.envelope(t, 0.25, 0.09);
    tone.connect(g).connect(this.bus);
    tone.start(t);
    tone.stop(t + 0.15);
  }

  private roll(t: number, peak: number) {
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2200;
    bp.Q.value = 0.8;
    this.noiseHit(t, bp, peak, 0.09);
  }

  /** Noise swelling up through a rising high-pass filter. */
  private riser(t: number, length: number) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.Q.value = 4;
    hp.frequency.setValueAtTime(300, t);
    hp.frequency.exponentialRampToValueAtTime(7000, t + length);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + length);
    g.gain.linearRampToValueAtTime(0.0001, t + length + 0.05);
    src.connect(hp).connect(g).connect(this.bus);
    src.start(t);
    src.stop(t + length + 0.1);
  }

  /** Crash on the downbeat where the groove comes back. */
  private impact(t: number) {
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 3500;
    this.noiseHit(t, hp, 0.3, 0.45); // the noise buffer is only 1 s long
  }

  private hat(t: number, open: boolean) {
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7200;
    this.noiseHit(t, hp, open ? 0.16 : 0.08, open ? 0.16 : 0.035);
  }

  private bass(freq: number, t: number, length: number) {
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    const sub = this.ctx.createOscillator();
    sub.frequency.value = freq / 2;

    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 6;
    lp.frequency.setValueAtTime(1400, t);
    lp.frequency.exponentialRampToValueAtTime(180, t + length);

    const g = this.envelope(t, 0.32, length);
    osc.connect(lp);
    sub.connect(lp);
    lp.connect(g).connect(this.bus);
    osc.start(t);
    sub.start(t);
    osc.stop(t + length + 0.05);
    sub.stop(t + length + 0.05);
  }

  private pad(notes: number[], t: number, length: number) {
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(500, t);
    lp.frequency.linearRampToValueAtTime(1800, t + length * 0.6);
    lp.frequency.linearRampToValueAtTime(700, t + length);

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.06, t + 0.5);
    g.gain.setValueAtTime(0.06, t + length - 0.3);
    g.gain.linearRampToValueAtTime(0.0001, t + length);
    lp.connect(g).connect(this.bus);

    for (const note of notes) {
      for (const detune of [-8, 8]) {
        const osc = this.ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = mtof(note);
        osc.detune.value = detune;
        osc.connect(lp);
        osc.start(t);
        osc.stop(t + length + 0.05);
      }
    }
  }

  private pluck(freq: number, t: number) {
    const osc = this.ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = freq;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(4200, t);
    lp.frequency.exponentialRampToValueAtTime(600, t + 0.18);
    const g = this.envelope(t, 0.06, 0.2);
    osc.connect(lp).connect(g).connect(this.bus);
    osc.start(t);
    osc.stop(t + 0.25);
  }
}
