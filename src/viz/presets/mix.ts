import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import type { AudioFrame } from '../../audio/analysis';
import { FULLSCREEN_VERT } from '../glsl';
import type { BloomSettings, Preset, PresetContext, PresetDef } from '../types';

/** Scenes that work as a backdrop, and scenes that read well layered on top. */
const BASES = ['bars-bars', 'bars-ocean-mist', 'battery-event-horizon', 'battery-hyperspace', 'ambience-water', 'battery-spiderbite'];
const OVERLAYS = ['bars-scope', 'ambience-swirl', 'ambience-bubbles', 'battery-chemical-star', 'bars-fire-storm'];

/** Blend modes, as weights for the composite shader: soft add, add, key, difference. */
const MODES = 4;

const pick = <T>(list: T[], not?: T) => {
  const choices = list.filter((x) => x !== not);
  return choices[Math.floor(Math.random() * choices.length)];
};

/**
 * "Alchemy : Mix": two scenes at once, a backdrop and an overlay, blended in
 * ways that change on bar lines. Every few bars one layer fades out and comes
 * back as a different scene, so the combinations keep mutating like the
 * original Alchemy did.
 */
export class MixPreset implements Preset {
  readonly bloom: BloomSettings = { strength: 0.5, radius: 0.45, threshold: 0.35 };
  private readonly cache = new Map<string, Preset>();
  private base = pick(BASES);
  private overlay = pick(OVERLAYS);
  private readonly rtA: THREE.WebGLRenderTarget;
  private readonly rtB: THREE.WebGLRenderTarget;
  private readonly material: THREE.ShaderMaterial;
  private readonly quad: FullScreenQuad;
  private readonly weights = new THREE.Vector4(1, 0, 0, 0);
  private readonly targetWeights = new THREE.Vector4(1, 0, 0, 0);
  private fadeA = 1;
  private fadeB = 1;
  /** A pending layer swap: fade the layer out, change the scene, fade it back in. */
  private swap: { layer: 'base' | 'overlay'; id: string; out: boolean } | null = null;
  private nextSwap: 'base' | 'overlay' = 'overlay';
  private bars = 0;
  private sinceChange = 0;
  private width = 1;
  private height = 1;

  constructor(private readonly ctx: PresetContext, private readonly defs: () => PresetDef[]) {
    const rt = { type: THREE.HalfFloatType, samples: 4 };
    this.rtA = new THREE.WebGLRenderTarget(1, 1, rt);
    this.rtB = new THREE.WebGLRenderTarget(1, 1, rt);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tA: { value: this.rtA.texture },
        tB: { value: this.rtB.texture },
        uW: { value: this.weights },
        uFadeA: { value: 1 },
        uFadeB: { value: 1 },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tA;
        uniform sampler2D tB;
        uniform vec4 uW;
        uniform float uFadeA;
        uniform float uFadeB;
        varying vec2 vUv;
        void main() {
          vec3 a = texture2D(tA, vUv).rgb * uFadeA;
          vec3 b = texture2D(tB, vUv).rgb * uFadeB;
          float lb = dot(b, vec3(0.2126, 0.7152, 0.0722));
          vec3 soft = a + b - min(a, b) * 0.5;
          vec3 add = a * 0.8 + b * 1.2;
          vec3 key = mix(a * 0.55, b * 1.2, smoothstep(0.04, 0.3, lb));
          vec3 diff = abs(a - b) * 1.4;
          vec3 col = soft * uW.x + add * uW.y + key * uW.z + diff * uW.w;
          gl_FragColor = vec4(col, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
    this.pickMode();
  }

  resize(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.rtA.setSize(width, height);
    this.rtB.setSize(width, height);
    for (const p of this.cache.values()) p.resize(width, height);
  }

  update(frame: AudioFrame, dt: number, time: number) {
    const tempo = frame.tempo;
    this.sinceChange += dt;
    if (tempo.downbeat) this.bars++;

    // Blend mode: every 4 bars when locked to the tempo, otherwise every ~10 s.
    const modeDue = tempo.locked ? tempo.downbeat && this.bars % 4 === 0 : this.sinceChange > 10;
    if (modeDue && !this.swap) {
      this.sinceChange = 0;
      // Every 8 bars (or every other change) swap a layer instead of the blend.
      if (tempo.locked ? this.bars % 8 === 0 : Math.random() < 0.5) this.startSwap();
      else this.pickMode();
    }

    const fadeRate = tempo.locked ? tempo.bpm / 60 : 2; // about one beat per fade
    if (this.swap) {
      const key = this.swap.layer === 'base' ? 'fadeA' : 'fadeB';
      if (this.swap.out) {
        this[key] = Math.max(0, this[key] - dt * fadeRate);
        if (this[key] === 0) {
          if (this.swap.layer === 'base') this.base = this.swap.id;
          else this.overlay = this.swap.id;
          this.swap.out = false;
        }
      } else {
        this[key] = Math.min(1, this[key] + dt * fadeRate);
        if (this[key] === 1) this.swap = null;
      }
    }
    this.weights.lerp(this.targetWeights, 1 - Math.exp(-dt * 4));

    this.layer(this.base).update(frame, dt, time);
    this.layer(this.overlay).update(frame, dt, time);
  }

  render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget) {
    this.layer(this.base).render(renderer, this.rtA);
    this.layer(this.overlay).render(renderer, this.rtB);
    const u = this.material.uniforms;
    u.uFadeA.value = this.fadeA;
    u.uFadeB.value = this.fadeB;
    renderer.setRenderTarget(target);
    this.quad.render(renderer);
  }

  dispose() {
    for (const p of this.cache.values()) p.dispose();
    this.rtA.dispose();
    this.rtB.dispose();
    this.material.dispose();
    this.quad.dispose();
  }

  private startSwap() {
    const layer = this.nextSwap;
    this.nextSwap = layer === 'base' ? 'overlay' : 'base';
    const id = layer === 'base' ? pick(BASES, this.base) : pick(OVERLAYS, this.overlay);
    this.swap = { layer, id, out: true };
  }

  private pickMode() {
    // Soft add is the safe default; the wilder modes come up less often.
    const weights = [0.4, 0.25, 0.2, 0.15];
    let r = Math.random();
    let mode = 0;
    while (mode < MODES - 1 && r > weights[mode]) r -= weights[mode++];
    this.targetWeights.set(mode === 0 ? 1 : 0, mode === 1 ? 1 : 0, mode === 2 ? 1 : 0, mode === 3 ? 1 : 0);
  }

  /** Mix keeps its own scene instances so it never double-updates the main ones. */
  private layer(id: string): Preset {
    let preset = this.cache.get(id);
    if (!preset) {
      const def = this.defs().find((d) => d.id === id)!;
      preset = def.create(this.ctx);
      preset.resize(this.width, this.height);
      this.cache.set(id, preset);
    }
    return preset;
  }
}
