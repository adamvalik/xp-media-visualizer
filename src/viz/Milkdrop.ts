import type { ButterchurnVisualizer } from 'butterchurn';
import * as THREE from 'three';
import type { AudioAnalysis } from '../audio/analysis';

const BASE = `${import.meta.env.BASE_URL}milkdrop/`;
/** MilkDrop's soft look doesn't need more pixels, and every frame is copied into the main canvas. */
const MAX_PIXELS = 1280 * 800;
/** Shuffle doesn't repeat any of the last this many presets. */
const RECENT = 60;
/** Fetched presets kept in memory (the upcoming one, and a few for going back and forth). */
const CACHE = 6;

interface MilkdropIndex {
  /** Every preset's name; preset i is in `milkdrop/<i>.json`. */
  names: string[];
  /** The presets Shuffle picks from. */
  shuffle: number[];
}

/**
 * MilkDrop through Butterchurn (its WebGL port), shared by the MilkDrop scenes. Butterchurn draws into
 * its own canvas, which becomes a texture in the main pipeline, so bloom, the drop effects, the album
 * tint and Classic Mode apply to it like to any other scene. It listens to the same analysed audio as
 * everything else, so Sensitivity and the automatic gain work for it too.
 *
 * Butterchurn and the presets load only when a MilkDrop scene first needs them.
 */
export class Milkdrop extends EventTarget {
  texture: THREE.CanvasTexture;
  /** The preset Single Preset shows, an index into `names()`; -1 until one is chosen. */
  choice = -1;
  /** Name of the preset Single Preset starts with (the one picked last time). */
  preferred = '';
  /** The preset showing (or loading), and the name of the one showing. */
  requested = -1;
  name = '';
  /** The scene in charge of picking presets: the MilkDrop scene that came on screen last. */
  owner: object | null = null;
  /** Frame time `owner` last changed. */
  claimedAt = -1;
  /** Follow breakdowns and drops (View > React to Drops). */
  sectionFx = true;
  private readonly canvas = document.createElement('canvas');
  private viz: ButterchurnVisualizer | null = null;
  private setup: Promise<ButterchurnVisualizer> | null = null;
  private indexFile: Promise<MilkdropIndex> | null = null;
  private readonly cache = new Map<number, Promise<object>>();
  private readonly recent: number[] = [];
  private upcoming = -1;
  private readonly bytes = new Uint8Array(1024);
  private lastRender = NaN;
  private resolving = false;

  constructor(private readonly analysis: AudioAnalysis) {
    super();
    this.texture = this.makeTexture();
  }

  /** Names of every preset, in the order of their files. */
  async names(): Promise<string[]> {
    return (await this.index()).names;
  }

  private index(): Promise<MilkdropIndex> {
    this.indexFile ??= fetch(`${BASE}index.json`)
      .then((r) => (r.ok ? (r.json() as Promise<MilkdropIndex>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .catch((err) => {
        this.indexFile = null;
        throw err;
      });
    return this.indexFile;
  }

  /** Loads Butterchurn and the first shuffle preset ahead of time, so the first switch has no gap. */
  warmUp() {
    void this.start()
      .then(() => this.index())
      .then(({ shuffle }) => this.prefetch((this.upcoming = this.pickRandom(shuffle))))
      .catch(() => {});
  }

  /** Chooses the preset for Single Preset. */
  choose(index: number) {
    this.choice = index;
  }

  /** Single Preset with nothing chosen yet: the preferred preset, or a random one. */
  resolveChoice() {
    if (this.resolving || this.choice >= 0) return;
    this.resolving = true;
    void this.index()
      .then(({ names, shuffle }) => {
        if (this.choice >= 0) return;
        const i = names.indexOf(this.preferred);
        this.choose(i >= 0 ? i : this.pickRandom(shuffle));
      })
      .catch(() => {})
      .finally(() => (this.resolving = false));
  }

  /** Shows a random preset, blending over `blend` seconds (0 cuts). */
  async shuffle(blend: number) {
    const { shuffle } = await this.index();
    for (let attempt = 0; attempt < 4; attempt++) {
      const index = this.upcoming >= 0 ? this.upcoming : this.pickRandom(shuffle);
      this.upcoming = this.pickRandom(shuffle, index);
      void this.prefetch(this.upcoming).catch(() => {});
      if (await this.show(index, blend)) return;
    }
  }

  /** Shows preset `index`; false when it couldn't be loaded. A newer request cancels this one. */
  async show(index: number, blend: number): Promise<boolean> {
    this.requested = index;
    this.remember(index);
    try {
      const [viz, preset, names] = await Promise.all([this.start(), this.prefetch(index), this.names()]);
      if (this.requested !== index) return true;
      viz.loadPreset(preset, blend);
      this.name = names[index] ?? '';
      this.dispatchEvent(new Event('change'));
      return true;
    } catch (err) {
      console.warn(`Could not load MilkDrop preset ${index}`, err);
      this.cache.delete(index);
      return false;
    }
  }

  /** Size of the scene in device pixels; MilkDrop renders at most MAX_PIXELS of it. */
  resize(width: number, height: number) {
    const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (width * height)));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    if (w === this.canvas.width && h === this.canvas.height) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.viz?.setRendererSize(w, h, { pixelRatio: 1, textureRatio: 1 });
    // The GPU copy of the canvas has a fixed size once uploaded.
    this.texture.dispose();
    this.texture = this.makeTexture();
  }

  /** Draws the next frame, once per frame however many scenes show it. */
  render(time: number) {
    if (!this.viz || time === this.lastRender) return;
    this.lastRender = time;
    this.analysis.timeBytes(this.bytes);
    const b = this.bytes;
    this.viz.render({ audioLevels: { timeByteArray: b, timeByteArrayL: b, timeByteArrayR: b } });
    this.texture.needsUpdate = true;
  }

  private start() {
    this.setup ??= import('butterchurn').then((module) => {
      // The UMD build puts its ES module (with its own default export) behind the CommonJS default.
      const butterchurn = 'createVisualizer' in module.default ? module.default : (module.default as unknown as typeof module).default;
      // No audio context: the samples come from our own analysis every frame.
      const viz = butterchurn.createVisualizer(null, this.canvas, {
        width: this.canvas.width,
        height: this.canvas.height,
        pixelRatio: 1,
        textureRatio: 1,
      });
      this.viz = viz;
      return viz;
    });
    this.setup.catch(() => (this.setup = null));
    return this.setup;
  }

  private prefetch(index: number): Promise<object> {
    let preset = this.cache.get(index);
    if (!preset) {
      preset = fetch(`${BASE}${index}.json`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))));
      this.cache.set(index, preset);
      if (this.cache.size > CACHE) this.cache.delete(this.cache.keys().next().value!);
    }
    return preset;
  }

  private pickRandom(from: number[], not = -1) {
    for (let tries = 0; ; tries++) {
      const i = from[Math.floor(Math.random() * from.length)];
      if (tries > 50 || (i !== not && !this.recent.includes(i))) return i;
    }
  }

  private remember(index: number) {
    this.recent.push(index);
    if (this.recent.length > RECENT) this.recent.shift();
  }

  private makeTexture() {
    const texture = new THREE.CanvasTexture(this.canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    return texture;
  }
}
