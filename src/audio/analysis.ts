import { TempoTracker, type TempoState } from './tempo';

/**
 * Turns raw AnalyserNode data into stable, visual-friendly features:
 * log-spaced bands with automatic gain, falling peaks, a phase-aligned
 * waveform and a simple bass-onset beat detector.
 */

export const BANDS = 128;
export const WAVE_SIZE = 512;

const F_MIN = 30;
const F_MAX = 16000;
/** Music falls off roughly 3 dB per octave; tilting the bands keeps highs visible. */
const TILT_DB_PER_OCTAVE = 2.5;
const TILT_PIVOT_HZ = 500;
/** Dynamic range shown on screen, measured down from the loudest recent band. */
const RANGE_DB = 46;
/** Anything quieter than this (after tilt and gain) is treated as silence. */
const GATE_DB = -74;

export interface AudioFrame {
  /** Smoothed log-spaced spectrum, 0..1, low to high frequency. */
  spectrum: Float32Array;
  /** Falling peak markers for the spectrum, 0..1. */
  peaks: Float32Array;
  /** Gain-normalised waveform, roughly -1..1, aligned to a rising zero crossing. */
  waveform: Float32Array;
  bass: number;
  mid: number;
  treble: number;
  level: number;
  /**
   * Decaying pulse that jumps to 1 on every beat. Follows the tempo grid when
   * it is locked, otherwise raw bass onsets.
   */
  beat: number;
  /** True only on the frame a bass onset is detected. */
  onset: boolean;
  /** True on the frame to accent: a grid beat when locked, otherwise an onset. */
  hit: boolean;
  /** Tempo, beat and bar phase from the beat tracker. */
  tempo: TempoState;
  /** 0 when the input is silent, 1 when there is a healthy signal. */
  presence: number;
}

/** Centre frequency of every band, independent of sample rate. */
export const BAND_HZ = Float32Array.from({ length: BANDS }, (_, b) => {
  const f0 = F_MIN * Math.pow(F_MAX / F_MIN, b / BANDS);
  const f1 = F_MIN * Math.pow(F_MAX / F_MIN, (b + 1) / BANDS);
  return Math.sqrt(f0 * f1);
});

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const finiteDb = (v: number) => (v > -200 ? v : -200);

/** Frame-rate independent exponential approach. */
export const approach = (current: number, target: number, rate: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-rate * dt));

export class AudioAnalysis {
  private readonly tempo = new TempoTracker();

  readonly frame: AudioFrame = {
    spectrum: new Float32Array(BANDS),
    peaks: new Float32Array(BANDS),
    waveform: new Float32Array(WAVE_SIZE),
    bass: 0,
    mid: 0,
    treble: 0,
    level: 0,
    beat: 0,
    onset: false,
    hit: false,
    tempo: this.tempo.state,
    presence: 0,
  };
  private readonly prevNorm = new Float32Array(BANDS);

  /** User sensitivity in dB, added to the input before gating. */
  gainDb = 0;

  private analyser: AnalyserNode | null = null;
  private freq = new Float32Array(2048);
  private time = new Float32Array(4096);
  private readonly lo = new Int32Array(BANDS);
  private readonly hi = new Int32Array(BANDS);
  private readonly center = new Float32Array(BANDS);
  private readonly tilt = Float32Array.from(BAND_HZ, (hz) => TILT_DB_PER_OCTAVE * Math.log2(hz / TILT_PIVOT_HZ));
  private readonly raw = new Float32Array(BANDS).fill(-200);
  private readonly peakVelocity = new Float32Array(BANDS);
  private ref = GATE_DB;
  private wavePeak = 0.05;
  private slowBass = 0;
  private lastBass = 0;
  private armed = true;
  private sinceBeat = 10;

  attach(analyser: AnalyserNode, sampleRate: number) {
    this.analyser = analyser;
    this.freq = new Float32Array(analyser.frequencyBinCount);
    this.time = new Float32Array(analyser.fftSize);
    const binHz = sampleRate / analyser.fftSize;
    const maxBin = analyser.frequencyBinCount - 2;
    for (let b = 0; b < BANDS; b++) {
      const f0 = F_MIN * Math.pow(F_MAX / F_MIN, b / BANDS);
      const f1 = F_MIN * Math.pow(F_MAX / F_MIN, (b + 1) / BANDS);
      this.lo[b] = Math.min(maxBin, Math.round(f0 / binHz));
      this.hi[b] = Math.min(maxBin + 1, Math.round(f1 / binHz));
      this.center[b] = Math.min(maxBin, BAND_HZ[b] / binHz);
    }
  }

  update(dt: number): AudioFrame {
    const f = this.frame;
    dt = Math.min(Math.max(dt, 0), 0.1);

    let maxDb = -200;
    if (this.analyser) {
      this.analyser.getFloatFrequencyData(this.freq);
      this.analyser.getFloatTimeDomainData(this.time);
      maxDb = this.computeBands();
    } else {
      this.raw.fill(-200);
      this.time.fill(0);
    }

    // Reference level follows the loudest band: quick to rise, slow to fall.
    if (maxDb > this.ref) this.ref = approach(this.ref, maxDb, 18, dt);
    else this.ref = Math.max(GATE_DB, this.ref - 5 * dt);

    const presenceTarget = clamp01((maxDb - GATE_DB) / 14);
    f.presence = approach(f.presence, presenceTarget, presenceTarget > f.presence ? 8 : 1.5, dt);

    const bottom = this.ref + 3 - RANGE_DB;
    // Onset strength for the tempo tracker: positive change of the unsmoothed bands, lows weighted up.
    let flux = 0;
    for (let b = 0; b < BANDS; b++) {
      const norm = clamp01((this.raw[b] - bottom) / RANGE_DB) * f.presence;
      const rise = norm - this.prevNorm[b];
      if (rise > 0) flux += rise * (BAND_HZ[b] < 200 ? 2 : 1);
      this.prevNorm[b] = norm;
    }
    let bassSum = 0, bassN = 0, midSum = 0, midN = 0, trebleSum = 0, trebleN = 0, all = 0;
    for (let b = 0; b < BANDS; b++) {
      const v = Math.pow(clamp01((this.raw[b] - bottom) / RANGE_DB), 1.5) * f.presence;
      const s = approach(f.spectrum[b], v, v > f.spectrum[b] ? 40 : 10, dt);
      f.spectrum[b] = s;

      if (s >= f.peaks[b]) {
        f.peaks[b] = s;
        this.peakVelocity[b] = 0;
      } else {
        this.peakVelocity[b] += 1.6 * dt;
        f.peaks[b] = Math.max(0, f.peaks[b] - this.peakVelocity[b] * dt);
      }

      const hz = BAND_HZ[b];
      all += s;
      if (hz < 180) { bassSum += s; bassN++; }
      else if (hz < 2200) { midSum += s; midN++; }
      else { trebleSum += s; trebleN++; }
    }
    f.bass = approach(f.bass, clamp01((bassSum / bassN) * 1.1), 18, dt);
    f.mid = approach(f.mid, clamp01((midSum / midN) * 1.35), 14, dt);
    f.treble = approach(f.treble, clamp01((trebleSum / trebleN) * 1.7), 14, dt);
    f.level = approach(f.level, clamp01((all / BANDS) * 1.6), 12, dt);

    this.detectBeat(dt);
    f.tempo = this.tempo.update(flux / BANDS, f.bass, f.presence, f.onset, dt);
    // When the grid is locked, beats come from it (steady, on time, even through fills).
    f.hit = f.tempo.locked ? f.tempo.tick : f.onset;
    if (f.tempo.locked && f.tempo.tick) f.beat = 1;
    this.alignWaveform(dt);
    return f;
  }

  private computeBands(): number {
    const fd = this.freq;
    let maxDb = -200;
    for (let b = 0; b < BANDS; b++) {
      const lo = this.lo[b];
      const hi = this.hi[b];
      let db: number;
      if (hi <= lo) {
        // Band narrower than one FFT bin: interpolate at its centre.
        const c = this.center[b];
        const i = Math.floor(c);
        const t = c - i;
        db = finiteDb(fd[i]) * (1 - t) + finiteDb(fd[i + 1]) * t;
      } else {
        let power = 0;
        for (let i = lo; i < hi; i++) power += Math.pow(10, finiteDb(fd[i]) * 0.1);
        db = 10 * Math.log10(power / (hi - lo));
      }
      db += this.tilt[b] + this.gainDb;
      this.raw[b] = db;
      if (db > maxDb) maxDb = db;
    }
    return maxDb;
  }

  private detectBeat(dt: number) {
    const f = this.frame;
    // Low-frequency energy relative to the reference, so it works at any volume.
    let energy = 0;
    let n = 0;
    for (let b = 0; b < BANDS && BAND_HZ[b] < 160; b++, n++) {
      energy += Math.pow(10, (this.raw[b] - this.ref) * 0.1);
    }
    energy = (energy / Math.max(1, n)) * f.presence;

    this.slowBass = approach(this.slowBass, energy, 2.5, dt);
    this.sinceBeat += dt;
    f.beat *= Math.exp(-dt * 4.5);
    f.onset = false;

    const rising = energy > this.lastBass;
    if (this.armed && rising && energy > this.slowBass * 1.45 + 0.004 && this.sinceBeat > 0.26 && f.presence > 0.25) {
      f.onset = true;
      if (!this.tempo.state.locked) f.beat = 1;
      this.sinceBeat = 0;
      this.armed = false;
    } else if (!this.armed && energy < this.slowBass * 1.1) {
      this.armed = true;
    }
    this.lastBass = energy;
  }

  private alignWaveform(dt: number) {
    const f = this.frame;
    const td = this.time;
    const stride = 2;
    const limit = Math.min(td.length - WAVE_SIZE * stride - 1, 1500);

    // Start at a rising zero crossing so the scope doesn't jitter sideways.
    let start = 0;
    for (let i = 1; i < limit; i++) {
      if (td[i - 1] < 0 && td[i] >= 0) {
        start = i;
        break;
      }
    }

    let peak = 0;
    for (let i = 0; i < WAVE_SIZE; i++) {
      const v = Math.abs(td[start + i * stride] ?? 0);
      if (v > peak) peak = v;
    }
    this.wavePeak = Math.max(peak, this.wavePeak * Math.exp(-dt * 0.8), 0.003);
    const gain = (0.9 / this.wavePeak) * f.presence;
    for (let i = 0; i < WAVE_SIZE; i++) {
      const v = (td[start + i * stride] ?? 0) * gain;
      f.waveform[i] = approach(f.waveform[i], v, 30, dt);
    }
  }
}
