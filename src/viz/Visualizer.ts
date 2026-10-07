import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { AudioFrame } from '../audio/analysis';
import type { AudioEngine } from '../audio/AudioEngine';
import { AudioTextures } from './AudioTextures';
import { FULLSCREEN_VERT } from './glsl';
import { lerp, smoothstep } from './helpers';
import { PRESETS } from './presets';
import type { Preset, PresetDef } from './types';

const TRANSITION_SECONDS = 1.8;
const AUTO_MIN_SECONDS = 16;
const AUTO_MAX_SECONDS = 32;

/** Renders the active preset (and the outgoing one during a crossfade) into the composer. */
class PresetPass extends Pass {
  current: Preset | null = null;
  previous: Preset | null = null;
  mix = 1;
  private readonly rtA: THREE.WebGLRenderTarget;
  private readonly rtB: THREE.WebGLRenderTarget;
  private readonly material: THREE.ShaderMaterial;
  private readonly quad: FullScreenQuad;

  constructor() {
    super();
    this.needsSwap = false;
    const options = { type: THREE.HalfFloatType, samples: 4 };
    this.rtA = new THREE.WebGLRenderTarget(1, 1, options);
    this.rtB = new THREE.WebGLRenderTarget(1, 1, options);
    this.material = new THREE.ShaderMaterial({
      uniforms: { tA: { value: null }, tB: { value: null }, uMix: { value: 1 } },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tA;
        uniform sampler2D tB;
        uniform float uMix;
        varying vec2 vUv;
        void main() {
          gl_FragColor = vec4(mix(texture2D(tB, vUv).rgb, texture2D(tA, vUv).rgb, uMix), 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  setSize(width: number, height: number) {
    this.rtA.setSize(width, height);
    this.rtB.setSize(width, height);
  }

  render(renderer: THREE.WebGLRenderer, _writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    const out = this.renderToScreen ? null : readBuffer;
    if (!this.current) {
      renderer.setRenderTarget(out);
      renderer.clear();
      return;
    }
    this.current.render(renderer, this.rtA);
    const blending = this.previous !== null && this.mix < 1;
    if (blending) this.previous!.render(renderer, this.rtB);
    const u = this.material.uniforms;
    u.tA.value = this.rtA.texture;
    u.tB.value = blending ? this.rtB.texture : this.rtA.texture;
    u.uMix.value = blending ? this.mix : 1;
    renderer.setRenderTarget(out);
    this.quad.render(renderer);
  }

  dispose() {
    this.rtA.dispose();
    this.rtB.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}

/** Vignette, a touch of beat-driven chromatic aberration and film grain. */
const FinishShader = {
  name: 'FinishShader',
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uAberration: { value: 0 },
    uVignette: { value: 0.45 },
    uGrain: { value: 0.01 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uAberration;
    uniform float uVignette;
    uniform float uGrain;
    varying vec2 vUv;
    void main() {
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);
      vec2 off = c * r2 * uAberration;
      vec3 col = vec3(
        texture2D(tDiffuse, vUv + off).r,
        texture2D(tDiffuse, vUv).g,
        texture2D(tDiffuse, vUv - off).b
      );
      col *= 1.0 - uVignette * r2 * 1.8;
      float n = fract(sin(dot(vUv * 1000.0 + fract(uTime) * 100.0, vec2(12.9898, 78.233))) * 43758.5453);
      col += (n - 0.5) * uGrain;
      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
};

export interface PresetChangeDetail {
  def: PresetDef;
  auto: boolean;
}

export class Visualizer extends EventTarget {
  readonly renderer: THREE.WebGLRenderer;
  readonly textures = new AudioTextures();
  /** Called every frame with fresh analysis, even when the canvas is hidden. */
  onFrame: ((frame: AudioFrame, dt: number) => void) | null = null;

  private readonly composer: EffectComposer;
  private readonly presetPass = new PresetPass();
  private readonly bloomPass: UnrealBloomPass;
  private readonly finishPass: ShaderPass;
  private readonly instances = new Map<string, Preset>();
  private currentId = '';
  private previousId: string | null = null;
  private transition = 1;
  private autoMode = false;
  private autoTimer = 0;
  private autoLimit = AUTO_MAX_SECONDS;
  private cssWidth = 0;
  private cssHeight = 0;
  private pixelRatio: number;
  private readonly maxPixelRatio: number;
  private readonly minPixelRatio: number;
  private raf = 0;
  private last = 0;
  private time = 0;
  private renderEnabled = true;
  private readonly perf = { time: 0, frames: 0, slow: 0, sinceDrop: 1e9 };

  constructor(private readonly canvas: HTMLCanvasElement, private readonly engine: AudioEngine) {
    super();
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      stencil: false,
      powerPreference: 'high-performance',
    });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.maxPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.minPixelRatio = Math.max(0.75, this.maxPixelRatio / 2);
    this.pixelRatio = this.maxPixelRatio;

    this.composer = new EffectComposer(this.renderer);
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.8, 0.5, 0.2);
    this.finishPass = new ShaderPass(FinishShader);
    this.composer.addPass(this.presetPass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.finishPass);
    this.composer.addPass(new OutputPass());

    new ResizeObserver(() => this.resize()).observe(canvas.parentElement ?? canvas);
    this.resize();
  }

  get presetId() {
    return this.currentId;
  }

  get auto() {
    return this.autoMode;
  }

  start() {
    if (this.raf) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Skip rendering (e.g. while another view covers the canvas) but keep analysing audio. */
  setRenderEnabled(enabled: boolean) {
    this.renderEnabled = enabled;
    if (enabled) this.resize();
  }

  setPreset(id: string, auto = false) {
    const def = PRESETS.find((p) => p.id === id);
    if (!def) return;
    if (!auto) this.autoMode = false;
    this.autoTimer = 0;
    if (id !== this.currentId) {
      this.instance(def);
      if (this.currentId) {
        this.previousId = this.currentId;
        this.transition = 0;
      }
      this.currentId = id;
    }
    this.dispatchEvent(new CustomEvent<PresetChangeDetail>('presetchange', { detail: { def, auto: this.autoMode } }));
  }

  step(delta: number) {
    const i = PRESETS.findIndex((p) => p.id === this.currentId);
    const next = PRESETS[(i + delta + PRESETS.length) % PRESETS.length];
    this.setPreset(next.id);
  }

  setAuto(on: boolean) {
    this.autoMode = on;
    this.autoTimer = 0;
    if (on) this.randomize();
    else {
      const def = PRESETS.find((p) => p.id === this.currentId);
      if (def) this.dispatchEvent(new CustomEvent<PresetChangeDetail>('presetchange', { detail: { def, auto: false } }));
    }
  }

  private randomize() {
    const choices = PRESETS.filter((p) => p.id !== this.currentId);
    const pick = choices[Math.floor(Math.random() * choices.length)];
    this.autoMode = true;
    this.autoLimit = lerp(AUTO_MIN_SECONDS + 6, AUTO_MAX_SECONDS, Math.random());
    this.setPreset(pick.id, true);
  }

  private instance(def: PresetDef): Preset {
    let preset = this.instances.get(def.id);
    if (!preset) {
      preset = def.create({ renderer: this.renderer, textures: this.textures });
      preset.resize(this.deviceWidth, this.deviceHeight);
      this.instances.set(def.id, preset);
    }
    return preset;
  }

  private get deviceWidth() {
    return Math.max(1, Math.floor(this.cssWidth * this.pixelRatio));
  }

  private get deviceHeight() {
    return Math.max(1, Math.floor(this.cssHeight * this.pixelRatio));
  }

  private resize() {
    const host = this.canvas.parentElement ?? this.canvas;
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (w < 2 || h < 2) return;
    if (w === this.cssWidth && h === this.cssHeight) return;
    this.cssWidth = w;
    this.cssHeight = h;
    this.applySize();
  }

  private applySize() {
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(this.cssWidth, this.cssHeight, false);
    this.composer.setPixelRatio(this.pixelRatio);
    this.composer.setSize(this.cssWidth, this.cssHeight);
    for (const preset of this.instances.values()) preset.resize(this.deviceWidth, this.deviceHeight);
  }

  private loop = (now: number) => {
    this.raf = requestAnimationFrame(this.loop);
    const rawDt = Math.max((now - this.last) / 1000, 0);
    const dt = Math.min(rawDt, 0.1);
    this.last = now;
    this.time += dt;

    const frame = this.engine.analysis.update(dt);
    this.onFrame?.(frame, dt);
    if (!this.renderEnabled || !this.currentId || this.cssWidth < 2) return;

    this.textures.update(frame);

    if (this.autoMode) {
      this.autoTimer += dt;
      const onBeat = frame.onset && this.autoTimer > AUTO_MIN_SECONDS && Math.random() < 0.2;
      if (onBeat || this.autoTimer > this.autoLimit) this.randomize();
    }

    const current = this.instances.get(this.currentId)!;
    current.update(frame, dt, this.time);

    let previous: Preset | null = null;
    if (this.previousId) {
      this.transition += dt / TRANSITION_SECONDS;
      if (this.transition >= 1) this.previousId = null;
      else {
        previous = this.instances.get(this.previousId) ?? null;
        previous?.update(frame, dt, this.time);
      }
    }
    const k = smoothstep(0, 1, this.transition);
    this.presetPass.current = current;
    this.presetPass.previous = previous;
    this.presetPass.mix = previous ? k : 1;

    const a = previous?.bloom ?? current.bloom;
    const b = current.bloom;
    const t = previous ? k : 1;
    this.bloomPass.strength = lerp(a.strength, b.strength, t) * (1 + frame.beat * 0.25);
    this.bloomPass.radius = lerp(a.radius, b.radius, t);
    this.bloomPass.threshold = lerp(a.threshold, b.threshold, t);

    const fu = this.finishPass.uniforms;
    fu.uTime.value = this.time;
    fu.uAberration.value = 0.25 + frame.beat * 0.9;

    this.composer.render(dt);
    this.adaptResolution(rawDt);
  };

  /**
   * Lowers the resolution a notch when most frames are slow, and slowly
   * climbs back when there is headroom. Ignores hiccups (shader compiles,
   * hidden tabs) and crossfades, which render two scenes at once.
   */
  private adaptResolution(rawDt: number) {
    const p = this.perf;
    p.sinceDrop += rawDt;
    if (rawDt > 0.25 || this.previousId) return;
    p.time += rawDt;
    p.frames++;
    if (rawDt > 1 / 40) p.slow++;
    if (p.time < 4) return;
    const slowShare = p.slow / p.frames;
    p.time = p.frames = p.slow = 0;
    if (slowShare > 0.7 && this.pixelRatio > this.minPixelRatio) {
      this.pixelRatio = Math.max(this.minPixelRatio, this.pixelRatio - 0.25);
      p.sinceDrop = 0;
      this.applySize();
    } else if (slowShare < 0.02 && p.sinceDrop > 20 && this.pixelRatio < this.maxPixelRatio) {
      this.pixelRatio = Math.min(this.maxPixelRatio, this.pixelRatio + 0.25);
      this.applySize();
    }
  }

  dispose() {
    this.stop();
    for (const preset of this.instances.values()) preset.dispose();
    this.presetPass.dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }
}
