/**
 * Tempo and beat-phase tracking.
 *
 * 1. Every frame the analysis feeds in an onset-strength value (spectral flux).
 *    It is resampled onto a fixed 60 Hz envelope so results don't depend on
 *    the display refresh rate.
 * 2. Twice a second the last 8 s of envelope are autocorrelated. Each
 *    candidate period in 70..180 BPM is scored by the autocorrelation at 1, 2,
 *    3 and 4 periods (a real beat repeats at every multiple, a 3:2 or 2:1
 *    impostor doesn't), with a mild preference around 120 BPM.
 * 3. The phase comes from the detected bass onsets (kicks): the circular mean
 *    of where they fall relative to the period. Kicks mark the beat far more
 *    reliably than the full envelope, which also contains off-beat bass and
 *    hats. If onsets are too scattered, a comb over the envelope is used.
 *    A free-running beat clock is gently pulled onto that grid. The clock keeps
 *    ticking through quiet passages and fills, which is what makes visuals feel
 *    "in time" rather than merely reactive.
 * 4. Bass energy is accumulated per beat-in-bar to guess the downbeat.
 */

const RATE = 60;
const WINDOW_SECONDS = 8;
const WINDOW = RATE * WINDOW_SECONDS;
const MIN_BPM = 70;
const MAX_BPM = 180;
const MIN_LAG = Math.floor((RATE * 60) / MAX_BPM);
const MAX_LAG = Math.ceil((RATE * 60) / MIN_BPM);
const ESTIMATE_EVERY = 0.5;
/** Fire beats a touch early to hide render and display latency. */
const LEAD_SECONDS = 0.03;

export interface TempoState {
  /** Beats per minute, 0 until a tempo has been found. */
  bpm: number;
  /** 0..1, how sure the tracker is about the current grid. */
  confidence: number;
  /** True when confident enough to drive visuals from the grid. */
  locked: boolean;
  /** Position inside the current beat, 0 at the beat. */
  beatPhase: number;
  /** Position inside the current 4-beat bar, 0 at the downbeat. */
  barPhase: number;
  /** True on the frame a grid beat occurs. */
  tick: boolean;
  /** True on the frame a bar starts (a tick that is also a downbeat). */
  downbeat: boolean;
}

export class TempoTracker {
  readonly state: TempoState = {
    bpm: 0,
    confidence: 0,
    locked: false,
    beatPhase: 0,
    barPhase: 0,
    tick: false,
    downbeat: false,
  };

  private readonly env = new Float32Array(WINDOW);
  private head = 0;
  private filled = 0;
  private slotAcc = 0;
  private slotTime = 0;
  private sinceEstimate = 0;
  private sinceTick = 10;
  private beatIndex = 0;
  private readonly barEnergy = new Float32Array(4);
  private downSlot = 0;
  private candidate = 0;
  private candidateVotes = 0;
  private readonly linear = new Float32Array(WINDOW);
  private clock = 0;
  private onsets: number[] = [];
  private readonly ac = new Float32Array(MAX_LAG * 4 + 3);

  /**
   * @param flux onset strength for this frame (sum of positive band changes)
   * @param bass current bass level, used to find the downbeat
   * @param presence 0 in silence, 1 with a healthy signal
   * @param onset whether a bass onset (kick) was detected this frame
   */
  update(flux: number, bass: number, presence: number, onset: boolean, dt: number): TempoState {
    const s = this.state;
    this.clock += dt;
    if (onset) this.onsets.push(this.clock);
    while (this.onsets.length && this.onsets[0] < this.clock - 6) this.onsets.shift();
    this.pushEnvelope(flux, dt);

    this.sinceEstimate += dt;
    if (this.sinceEstimate >= ESTIMATE_EVERY && this.filled >= RATE * 4) {
      this.sinceEstimate = 0;
      this.estimate(presence);
    }
    if (presence < 0.2) s.confidence *= Math.exp(-dt * 0.7);
    s.locked = s.bpm > 0 && s.confidence > 0.4 && presence > 0.25;

    // Free-running beat clock.
    s.tick = false;
    s.downbeat = false;
    this.sinceTick += dt;
    if (s.bpm > 0 && s.confidence > 0.15) {
      s.beatPhase += (dt * s.bpm) / 60;
      if (s.beatPhase >= 1) {
        s.beatPhase -= Math.floor(s.beatPhase);
        // Guard against double ticks after a phase correction.
        if (this.sinceTick > (60 / s.bpm) * 0.5) {
          s.tick = true;
          this.sinceTick = 0;
          this.beatIndex = (this.beatIndex + 1) % 4;
          // Per-slot average over roughly the last 6 bars.
          this.barEnergy[this.beatIndex] = this.barEnergy[this.beatIndex] * 0.85 + bass * 0.15;
          // Sticky: only move the downbeat when another beat is clearly heavier,
          // otherwise equal four-on-the-floor kicks would make it wander.
          let best = this.downSlot;
          for (let i = 0; i < 4; i++) if (this.barEnergy[i] > this.barEnergy[best] * 1.35) best = i;
          this.downSlot = best;
          s.downbeat = this.beatIndex === this.downSlot;
        }
      }
    }
    const inBar = (this.beatIndex - this.downSlot + 4) % 4;
    s.barPhase = (inBar + s.beatPhase) / 4;
    return s;
  }

  reset() {
    this.env.fill(0);
    this.filled = 0;
    Object.assign(this.state, { bpm: 0, confidence: 0, locked: false, beatPhase: 0, barPhase: 0 });
  }

  private pushEnvelope(flux: number, dt: number) {
    this.slotAcc += flux;
    this.slotTime += dt;
    const slot = 1 / RATE;
    let pushes = 0;
    while (this.slotTime >= slot) {
      this.slotTime -= slot;
      // If a long frame spans several slots, the energy lands in the first one.
      this.env[this.head] = pushes++ === 0 ? this.slotAcc : 0;
      this.head = (this.head + 1) % WINDOW;
      this.filled = Math.min(WINDOW, this.filled + 1);
      this.slotAcc = 0;
    }
  }

  /** Envelope sample `back` slots before the newest one, with linear interpolation. */
  private sample(back: number) {
    const i = Math.floor(back);
    const t = back - i;
    const a = this.env[(this.head - 1 - i + WINDOW * 2) % WINDOW];
    const b = this.env[(this.head - 2 - i + WINDOW * 2) % WINDOW];
    return a * (1 - t) + b * t;
  }

  private estimate(presence: number) {
    const s = this.state;
    const n = this.filled;
    const x = this.linear;
    let mean = 0;
    for (let i = 0; i < n; i++) {
      // Light 3-tap blur so beats at fractional periods don't split across two lags.
      const at = (k: number) => this.env[(this.head - n + Math.min(n - 1, Math.max(0, k)) + WINDOW) % WINDOW];
      x[i] = 0.25 * at(i - 1) + 0.5 * at(i) + 0.25 * at(i + 1);
      mean += x[i];
    }
    mean /= n;
    let energy = 0;
    for (let i = 0; i < n; i++) {
      x[i] -= mean;
      energy += x[i] * x[i];
    }
    if (energy < 1e-9 || presence < 0.2) return;
    energy /= n;

    const maxLag = Math.min(this.ac.length - 1, n - 1);
    for (let lag = MIN_LAG; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = lag; i < n; i++) sum += x[i] * x[i - lag];
      this.ac[lag] = sum / (n - lag) / energy;
    }

    const acAt = (lag: number) => {
      if (lag > maxLag) return 0;
      const i = Math.floor(lag);
      const t = lag - i;
      return this.ac[i] * (1 - t) + this.ac[Math.min(i + 1, maxLag)] * t;
    };
    const WEIGHTS = [1, 0.7, 0.5, 0.5];
    let lag = 0;
    let bestScore = -Infinity;
    for (let l = MIN_LAG; l <= MAX_LAG; l += 0.25) {
      let score = 0;
      for (let k = 0; k < WEIGHTS.length; k++) score += WEIGHTS[k] * acAt(l * (k + 1));
      const bpm = (RATE * 60) / l;
      score *= 0.7 + 0.3 * Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120), 2));
      if (score > bestScore) {
        bestScore = score;
        lag = l;
      }
    }
    if (lag === 0) return;
    const measured = (RATE * 60) / lag;
    const peak = acAt(lag);
    const conf = Math.max(0, Math.min(1, (peak - 0.08) / 0.3));

    this.adoptTempo(measured, conf);
    if (s.bpm > 0) this.alignPhase();
  }

  private adoptTempo(measured: number, conf: number) {
    const s = this.state;
    const close = (a: number, b: number) => Math.abs(a - b) / b < 0.04;
    if (s.bpm === 0) {
      s.bpm = measured;
    } else if (close(measured, s.bpm) || close(measured * 2, s.bpm) || close(measured / 2, s.bpm)) {
      // Same tempo (octave errors count as agreement): refine slowly.
      if (close(measured, s.bpm)) s.bpm += (measured - s.bpm) * 0.25;
      this.candidateVotes = 0;
    } else if (this.candidate && close(measured, this.candidate)) {
      // A different tempo must win three estimates in a row before we switch.
      if (++this.candidateVotes >= 3) {
        s.bpm = measured;
        s.confidence *= 0.5;
        this.candidateVotes = 0;
      }
    } else {
      this.candidate = measured;
      this.candidateVotes = 1;
      conf *= 0.5;
    }
    s.confidence += (conf - s.confidence) * 0.3;
  }

  /** Find where the beats fall and pull the clock towards them. */
  private alignPhase() {
    const s = this.state;
    const periodSec = 60 / s.bpm;
    let target = this.phaseFromOnsets(periodSec);
    if (target === null) target = this.phaseFromEnvelope();
    if (target === null) return;
    target = (target + LEAD_SECONDS / periodSec) % 1;
    let err = target - s.beatPhase;
    if (err > 0.5) err -= 1;
    if (err < -0.5) err += 1;
    const next = s.beatPhase + err * 0.5;
    // Never move the clock across a beat boundary: going forward would swallow
    // a beat, going backward would repeat one. Later estimates finish the job.
    s.beatPhase = Math.min(0.9999, Math.max(0, next));
  }

  /** Circular mean of recent kick positions within the beat; null if they don't agree. */
  private phaseFromOnsets(periodSec: number): number | null {
    if (this.onsets.length < 4) return null;
    let x = 0;
    let y = 0;
    for (const t of this.onsets) {
      const angle = (((this.clock - t) / periodSec) % 1) * Math.PI * 2;
      const weight = 1 - (this.clock - t) / 8;
      x += Math.cos(angle) * weight;
      y += Math.sin(angle) * weight;
    }
    const total = this.onsets.reduce((sum, t) => sum + 1 - (this.clock - t) / 8, 0);
    if (Math.hypot(x, y) / total < 0.5) return null;
    // "The last beat was this fraction of a period ago" equals the current phase.
    return ((Math.atan2(y, x) / (Math.PI * 2)) % 1 + 1) % 1;
  }

  /** Comb over the onset envelope at the current period. */
  private phaseFromEnvelope(): number | null {
    const s = this.state;
    const period = (RATE * 60) / s.bpm;
    const beats = Math.floor((this.filled - 2) / period);
    if (beats < 3) return null;
    let bestOffset = 0;
    let best = -Infinity;
    for (let o = 0; o < period; o += 0.5) {
      let sum = 0;
      for (let k = 0; k < beats; k++) sum += this.sample(o + k * period) * (1 - k / (beats * 2));
      if (sum > best) {
        best = sum;
        bestOffset = o;
      }
    }
    // The last beat happened bestOffset slots (+ the partial slot) ago.
    return ((bestOffset + this.slotTime * RATE) / period) % 1;
  }
}
