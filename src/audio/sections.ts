import type { TempoState } from './tempo';

/**
 * Song-section tracking: breakdowns, build-ups, drops and louder sections.
 *
 * The spectrum is normalised against the loudest band, so overall level says
 * little about the arrangement. What does survive normalisation is the balance:
 * in a breakdown the bass is far below what the song had before, while pads or
 * a riser carry on. So:
 *
 * - "Full" bass is a slow reference of the bass level while the song is going.
 * - A breakdown is the bass staying well under that for a few seconds (silence
 *   doesn't count, so a pause between songs isn't one).
 * - The build grows with the length of the breakdown and with rising highs
 *   (risers, snare rolls).
 * - A drop is the bass coming back hard after a breakdown.
 * - A lift is a clearly louder section starting on a beat, measured on the
 *   absolute level the analysis follows (the loudest band in dB).
 *
 * Everything is deliberately conservative: missing a drop looks fine, a fake
 * one every few bars doesn't.
 */

/** Seconds of signal before anything is reported; the references need time to settle. */
const WARMUP_SECONDS = 12;
/** Bass under this share of the full level counts as "cut". */
const BREAKDOWN_RATIO = 0.45;
/** How long the bass must stay cut before it is a breakdown. */
const BREAKDOWN_SECONDS = 3.5;
/** Bass back above this share of the full level ends a breakdown with a drop. */
const DROP_RATIO = 0.7;
const MIN_DROP_GAP_SECONDS = 15;
/** A bar this many dB louder than the previous four starts a new section. */
const LIFT_DB = 3.5;
const MIN_LIFT_GAP_BARS = 8;

export interface SectionState {
  /** 0..1, how strongly the music is building towards a drop. */
  build: number;
  /** True while the bass has been cut for a while. */
  breakdown: boolean;
  /** True on the frame a drop lands. */
  drop: boolean;
  /** True on the frame a clearly louder section starts (at the start of a beat). */
  lift: boolean;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class SectionTracker {
  readonly state: SectionState = { build: 0, breakdown: false, drop: false, lift: false };

  private playing = 0;
  private fastBass = 0;
  private fastTreble = 0;
  private fullBass = 0;
  private lowTime = 0;
  private trebleFloor = 1;
  private sinceDrop = 1e9;
  private barLoudness = 0;
  private barFrames = 0;
  private readonly bars: number[] = [];
  private barsSinceLift = 0;

  /**
   * @param bass smoothed bass level, 0..1
   * @param treble smoothed treble level, 0..1
   * @param loudness level of the loudest band in dB (the analysis' reference)
   * @param presence 0 in silence, 1 with a healthy signal
   */
  update(bass: number, treble: number, loudness: number, presence: number, tempo: TempoState, dt: number): SectionState {
    const s = this.state;
    s.drop = false;
    s.lift = false;
    this.sinceDrop += dt;

    if (presence < 0.3) {
      // A pause is not a breakdown; hold everything until the music is back.
      s.build = Math.max(0, s.build - dt * 2);
      return s;
    }
    this.playing += dt;
    this.fastBass += (bass - this.fastBass) * (1 - Math.exp(-dt * 2));
    this.fastTreble += (treble - this.fastTreble) * (1 - Math.exp(-dt * 1));

    const warm = this.playing > WARMUP_SECONDS;
    if (!warm) {
      this.fullBass += (this.fastBass - this.fullBass) * (1 - Math.exp(-dt * 0.5));
    } else if (!s.breakdown && this.fastBass > this.fullBass * 0.6) {
      // Rise quickly to louder bass, sink slowly; dips don't drag the reference down.
      const rate = this.fastBass > this.fullBass ? 0.5 : 0.12;
      this.fullBass += (this.fastBass - this.fullBass) * (1 - Math.exp(-dt * rate));
    }

    if (s.breakdown && bass > this.fullBass * DROP_RATIO && this.sinceDrop > MIN_DROP_GAP_SECONDS) {
      s.drop = true;
      s.lift = true;
      this.sinceDrop = 0;
      this.barsSinceLift = 0;
      this.lowTime = 0;
    } else if (this.fastBass < this.fullBass * BREAKDOWN_RATIO) {
      if (this.lowTime === 0) this.trebleFloor = this.fastTreble;
      this.lowTime += dt;
      this.trebleFloor = Math.min(this.trebleFloor, this.fastTreble);
    } else if (this.fastBass > this.fullBass * 0.65) {
      // The bass came back gradually: no drop, the breakdown just ends.
      this.lowTime = 0;
    }
    s.breakdown = warm && this.fullBass > 0.12 && this.lowTime > BREAKDOWN_SECONDS;

    const target = s.breakdown
      ? clamp01((this.lowTime - BREAKDOWN_SECONDS) / 12) * 0.45 + clamp01((this.fastTreble - this.trebleFloor) / 0.2) * 0.55
      : 0;
    s.build += (target - s.build) * (1 - Math.exp(-dt * (target > s.build ? 2 : 6)));

    this.trackBars(loudness, tempo, warm);
    return s;
  }

  private trackBars(loudness: number, tempo: TempoState, warm: boolean) {
    const s = this.state;
    if (!tempo.locked) {
      this.bars.length = 0;
      this.barFrames = 0;
      this.barLoudness = 0;
      return;
    }
    if (tempo.downbeat) {
      if (this.barFrames > 0) {
        this.bars.push(this.barLoudness / this.barFrames);
        if (this.bars.length > 4) this.bars.shift();
        this.barsSinceLift++;
      }
      this.barLoudness = 0;
      this.barFrames = 0;
    }
    this.barLoudness += loudness;
    this.barFrames++;

    // The analysis follows a louder signal within ~0.1 s, so look at the start of each beat. Not just
    // bar starts: with four equal kicks the tracker's downbeat can be a beat off, and the gap of
    // several bars between lifts already keeps one section from firing twice.
    // Out of a breakdown, the drop is what fires.
    if (tempo.beatPhase > 0.3 || !warm || s.breakdown || this.bars.length < 4) return;
    const before = this.bars.reduce((sum, v) => sum + v, 0) / this.bars.length;
    if (loudness - before > LIFT_DB && this.barsSinceLift >= MIN_LIFT_GAP_BARS) {
      s.lift = true;
      this.barsSinceLift = 0;
    }
  }
}
