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
/** A drop slams the next Alchemy scene in instead of crossfading. */
const DROP_TRANSITION_SECONDS = 0.15;

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

/**
 * Vignette, beat-driven chromatic aberration, film grain, an optional colour tint (album art), and the
 * zoom punch and flash for drops.
 */
const FinishShader = {
  name: 'FinishShader',
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uAberration: { value: 0 },
    uVignette: { value: 0.45 },
    uGrain: { value: 0.01 },
    uTint: { value: new THREE.Vector3(1, 1, 1) },
    uTintAmount: { value: 0 },
    uZoom: { value: 1 },
    uFlash: { value: 0 },
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
    uniform vec3 uTint;
    uniform float uTintAmount;
    uniform float uZoom;
    uniform float uFlash;
    varying vec2 vUv;
    void main() {
      vec2 uv = (vUv - 0.5) * uZoom + 0.5;
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);
      vec2 off = c * r2 * uAberration;
      vec3 col = vec3(
        texture2D(tDiffuse, uv + off).r,
        texture2D(tDiffuse, uv).g,
        texture2D(tDiffuse, uv - off).b
      );
      // Re-colour towards the tint while keeping brightness, so scenes keep their contrast.
      const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
      vec3 tinted = dot(col, LUMA) * uTint / max(dot(uTint, LUMA), 0.05);
      col = mix(col, tinted, uTintAmount);
      col *= 1.0 - uVignette * r2 * 1.8;
      float n = fract(sin(dot(vUv * 1000.0 + fract(uTime) * 100.0, vec2(12.9898, 78.233))) * 43758.5453);
      col += (n - 0.5) * uGrain;
      col += vec3(1.0, 0.96, 0.9) * uFlash;
      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
};

/** Classic Mode output: 16-bit colour (5-6-5) with 4x4 ordered dithering, applied after tone mapping. */
const RetroShader = {
  name: 'RetroShader',
  uniforms: {
    tDiffuse: { value: null },
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
    varying vec2 vUv;
    float bayer2(vec2 a) {
      a = floor(a);
      return fract(dot(a, vec2(0.5, a.y * 0.75)));
    }
    float bayer4(vec2 a) {
      return bayer2(0.5 * a) * 0.25 + bayer2(a);
    }
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float d = bayer4(gl_FragCoord.xy) - 0.5;
      vec3 levels = vec3(31.0, 63.0, 31.0);
      c = floor(c * levels + 0.5 + d) / levels;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }
  `,
};

/** Classic Mode renders about this many lines tall, roughly a 2003 visualization window. */
const CLASSIC_LINES = 340;

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
  private readonly retroPass: ShaderPass;
  private classic = false;
  private readonly instances = new Map<string, Preset>();
  private currentId = '';
  /** Instance keys: the preset id, plus "#classic" for the flat 2D variants. */
  private currentKey = '';
  private previousKey: string | null = null;
  private transition = 1;
  private autoMode = false;
  private autoTimer = 0;
  private autoLimit = AUTO_MAX_SECONDS;
  private barsSinceSwitch = 0;
  private transitionSeconds = TRANSITION_SECONDS;
  private nextTransitionSeconds: number | null = null;
  /** React to breakdowns, build-ups and drops (View > React to Drops). */
  private sectionFx = true;
  /** 1 when a drop lands, fading out; a louder section gives a smaller kick. */
  private dropPulse = 0;
  private lastFrame: AudioFrame | null = null;
  private cssWidth = 0;
  private cssHeight = 0;
  private pixelRatio: number;
  private readonly maxPixelRatio: number;
  private readonly minPixelRatio: number;
  private raf = 0;
  private last = 0;
  private time = 0;
  private renderEnabled = true;
  private readonly tint = new THREE.Vector3(1, 1, 1);
  private readonly tintTarget = new THREE.Vector3(1, 1, 1);
  private tintAmount = 0;
  private tintAmountTarget = 0;
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
    this.retroPass = new ShaderPass(RetroShader);
    this.retroPass.enabled = false;
    this.composer.addPass(this.retroPass);

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
    this.barsSinceSwitch = 0;
    if (id !== this.currentId) {
      this.switchTo(def);
      this.currentId = id;
    }
    this.dispatchEvent(new CustomEvent<PresetChangeDetail>('presetchange', { detail: { def, auto: this.autoMode } }));
  }

  get classicMode() {
    return this.classic;
  }

  /**
   * Classic Mode: low-resolution pixels, no bloom, 16-bit colour, and the flat
   * 2D versions of the scenes that have one.
   */
  setClassic(on: boolean) {
    if (on === this.classic) return;
    this.classic = on;
    this.bloomPass.enabled = !on;
    this.retroPass.enabled = on;
    this.canvas.style.imageRendering = on ? 'pixelated' : '';
    this.applySize();
    const def = PRESETS.find((p) => p.id === this.currentId);
    if (def) this.switchTo(def);
  }

  setSectionFx(on: boolean) {
    this.sectionFx = on;
  }

  /** Crossfade to the instance for `def` (classic or modern variant). */
  private switchTo(def: PresetDef) {
    const key = this.keyFor(def);
    if (key === this.currentKey) return;
    this.instance(def);
    if (this.currentKey) {
      this.previousKey = this.currentKey;
      this.transition = 0;
      // With a tempo lock, crossfade over two beats so the new scene arrives in time.
      const tempo = this.lastFrame?.tempo;
      this.transitionSeconds =
        this.nextTransitionSeconds ??
        (tempo?.locked ? Math.min(Math.max((60 / tempo.bpm) * 2, 0.6), 2) : TRANSITION_SECONDS);
    }
    this.currentKey = key;
  }

  private keyFor(def: PresetDef) {
    return this.classic && def.classic ? `${def.id}#classic` : def.id;
  }

  step(delta: number) {
    const i = PRESETS.findIndex((p) => p.id === this.currentId);
    const next = PRESETS[(i + delta + PRESETS.length) % PRESETS.length];
    this.setPreset(next.id);
  }

  /** Tint the image towards a colour (0..1 sRGB), e.g. from album art; null fades it out. */
  setTint(rgb: [number, number, number] | null, amount = 0.35) {
    if (rgb) {
      const c = new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
      this.tintTarget.set(c.r, c.g, c.b);
    }
    this.tintAmountTarget = rgb ? amount : 0;
  }

  setAuto(on: boolean) {
    this.autoMode = on;
    this.autoTimer = 0;
    this.barsSinceSwitch = 0;
    if (on) this.randomize();
    else {
      const def = PRESETS.find((p) => p.id === this.currentId);
      if (def) this.dispatchEvent(new CustomEvent<PresetChangeDetail>('presetchange', { detail: { def, auto: false } }));
    }
  }

  private randomize(transitionSeconds: number | null = null) {
    this.nextTransitionSeconds = transitionSeconds;
    const choices = PRESETS.filter((p) => p.id !== this.currentId);
    const pick = choices[Math.floor(Math.random() * choices.length)];
    this.autoMode = true;
    this.autoLimit = lerp(AUTO_MIN_SECONDS + 6, AUTO_MAX_SECONDS, Math.random());
    this.setPreset(pick.id, true);
    this.nextTransitionSeconds = null;
  }

  private instance(def: PresetDef): Preset {
    const key = this.keyFor(def);
    let preset = this.instances.get(key);
    if (!preset) {
      const ctx = { renderer: this.renderer, textures: this.textures };
      preset = key.endsWith('#classic') ? def.classic!(ctx) : def.create(ctx);
      preset.resize(this.deviceWidth, this.deviceHeight);
      this.instances.set(key, preset);
    }
    return preset;
  }

  /** Pixel ratio actually rendered at; Classic Mode drops to a fixed low line count. */
  private get renderRatio() {
    return this.classic ? Math.min(this.pixelRatio, CLASSIC_LINES / Math.max(1, this.cssHeight)) : this.pixelRatio;
  }

  private get deviceWidth() {
    return Math.max(1, Math.floor(this.cssWidth * this.renderRatio));
  }

  private get deviceHeight() {
    return Math.max(1, Math.floor(this.cssHeight * this.renderRatio));
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
    const ratio = this.renderRatio;
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(this.cssWidth, this.cssHeight, false);
    this.composer.setPixelRatio(ratio);
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
    this.lastFrame = frame;

    const section = frame.section;
    let switched = false;
    if (this.sectionFx) {
      if (section.drop) {
        this.dropPulse = 1;
        if (this.autoMode) {
          this.randomize(DROP_TRANSITION_SECONDS);
          switched = true;
        }
      } else if (section.lift) {
        this.dropPulse = Math.max(this.dropPulse, 0.35);
        // A new section is the natural moment for Alchemy to change scene.
        if (this.autoMode && this.barsSinceSwitch >= 4) {
          this.randomize();
          switched = true;
        }
      }
    }
    this.dropPulse *= Math.exp(-dt * 1.8);
    const build = this.sectionFx ? section.build : 0;

    // During a breakdown Alchemy holds its scene and saves the change for the drop.
    const holdForDrop = this.sectionFx && section.breakdown;
    if (this.autoMode && !switched && !holdForDrop) {
      this.autoTimer += dt;
      if (frame.tempo.locked) {
        // Switch on a bar line after 8 or 16 bars, like a DJ changing phrase.
        if (frame.tempo.downbeat) this.barsSinceSwitch++;
        const phraseEnd = frame.tempo.downbeat && this.autoTimer > AUTO_MIN_SECONDS / 2;
        if (phraseEnd && ((this.barsSinceSwitch >= 8 && Math.random() < 0.4) || this.barsSinceSwitch >= 16)) this.randomize();
      } else {
        const onBeat = frame.onset && this.autoTimer > AUTO_MIN_SECONDS && Math.random() < 0.2;
        if (onBeat || this.autoTimer > this.autoLimit) this.randomize();
      }
    }

    const current = this.instances.get(this.currentKey)!;
    current.update(frame, dt, this.time);

    let previous: Preset | null = null;
    if (this.previousKey) {
      this.transition += dt / this.transitionSeconds;
      if (this.transition >= 1) this.previousKey = null;
      else {
        previous = this.instances.get(this.previousKey) ?? null;
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
    this.bloomPass.strength = lerp(a.strength, b.strength, t) * (1 + frame.beat * 0.25 + this.dropPulse * 0.9 + build * 0.2);
    this.bloomPass.radius = lerp(a.radius, b.radius, t);
    this.bloomPass.threshold = lerp(a.threshold, b.threshold, t);

    const fu = this.finishPass.uniforms;
    fu.uTime.value = this.time;
    // Classic Mode skips the modern lens effects; the retro pass does the styling.
    const pulse = this.dropPulse;
    fu.uAberration.value = this.classic ? 0 : 0.25 + frame.beat * 0.9 + build * 0.6 + pulse * 2.5;
    fu.uGrain.value = this.classic ? 0 : 0.01 + build * 0.03;
    fu.uVignette.value = (this.classic ? 0.15 : 0.45) + build * 0.5;
    // A build slowly pushes in; the drop punches in and springs back.
    fu.uZoom.value = 1 - build * 0.04 - pulse * 0.08;
    fu.uFlash.value = pulse * pulse * pulse * 0.6;
    const ease = 1 - Math.exp(-dt * 1.5);
    this.tint.lerp(this.tintTarget, ease);
    this.tintAmount += (this.tintAmountTarget - this.tintAmount) * ease;
    fu.uTint.value.copy(this.tint);
    fu.uTintAmount.value = this.tintAmount;

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
    if (rawDt > 0.25 || this.previousKey || this.classic) return;
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
