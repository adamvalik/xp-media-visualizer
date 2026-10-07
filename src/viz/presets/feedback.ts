import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import type { AudioFrame } from '../../audio/analysis';
import { AUDIO_UNIFORMS, COMMON, FULLSCREEN_VERT } from '../glsl';
import { applyAudio, createAudioUniforms } from '../helpers';
import type { BloomSettings, Preset, PresetContext } from '../types';

export interface FeedbackOptions {
  /** 0 = "event horizon" (outward flow, wave ring), 1 = "chemical star" (inward flow, star), 2 = "spiderbite" (web). */
  mode: 0 | 1 | 2;
  /** Kaleidoscope segments for the final image, 0 disables it. */
  kaleido: number;
  bloom: BloomSettings;
}

/**
 * The Battery family in HD: each frame is the previous frame warped (zoom,
 * twist, hue drift) plus new shapes drawn from the audio. This is the
 * classic video-feedback trick behind Battery and MilkDrop.
 */
export class FeedbackPreset implements Preset {
  readonly bloom: BloomSettings;
  private readonly u;
  private readonly quad = new FullScreenQuad();
  private readonly feedback: THREE.ShaderMaterial;
  private readonly display: THREE.ShaderMaterial;
  private read: THREE.WebGLRenderTarget;
  private write: THREE.WebGLRenderTarget;
  private hueOffset = Math.random();
  private dt = 1 / 60;

  constructor(private readonly ctx: PresetContext, options: FeedbackOptions) {
    this.bloom = options.bloom;
    this.u = createAudioUniforms(ctx);
    const rtOptions = { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    this.read = new THREE.WebGLRenderTarget(1, 1, rtOptions);
    this.write = new THREE.WebGLRenderTarget(1, 1, rtOptions);

    this.feedback = new THREE.ShaderMaterial({
      uniforms: {
        ...this.u,
        uPrev: { value: null as THREE.Texture | null },
        uAspect: { value: 1 },
        uDt: { value: 1 / 60 },
        uHue: { value: 0 },
        uMode: { value: options.mode },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        ${AUDIO_UNIFORMS}
        ${COMMON}
        uniform sampler2D uPrev;
        uniform float uAspect;
        uniform float uDt;
        uniform float uHue;
        uniform float uMode;
        varying vec2 vUv;

        // Rotate a colour around the grey axis.
        vec3 hueShift(vec3 c, float a) {
          const vec3 k = vec3(0.57735);
          float ca = cos(a);
          return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
        }

        void main() {
          float f = uDt * 60.0;
          vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
          float r = length(p);
          float a0 = atan(p.y, p.x);

          // Flow field: where did this pixel come from last frame?
          float zoom;
          float rot;
          if (uMode < 0.5) {
            zoom = 1.0 - (0.006 + uBass * 0.022 + uBeat * 0.02) * f;
            rot = (0.002 + uMid * 0.012) * f * sin(uTime * 0.11 + 0.7);
          } else if (uMode < 1.5) {
            zoom = 1.0 + (0.005 + uBass * 0.012 + uBeat * 0.01) * f;
            rot = (0.005 + uMid * 0.012) * f;
          } else {
            // Web: a slow outward creep that rocks back and forth with the music.
            zoom = 1.0 - (0.003 + uBeat * 0.012) * f;
            rot = sin(uTime * 0.4) * (0.004 + uMid * 0.01) * f;
          }
          float swirl = sin(r * 9.0 - uTime * 1.3) * 0.004 * f * (0.3 + uTreble * 2.0);
          float a = a0 + rot + swirl;
          vec2 q = vec2(cos(a), sin(a)) * r * zoom;
          q += vec2(sin(q.y * 7.0 + uTime), cos(q.x * 7.0 - uTime * 0.8)) * 0.0015 * f;
          vec2 prevUv = q / vec2(uAspect, 1.0) + 0.5;

          vec3 prev = texture2D(uPrev, prevUv).rgb;
          if (prevUv.x < 0.0 || prevUv.x > 1.0 || prevUv.y < 0.0 || prevUv.y > 1.0) prev = vec3(0.0);
          prev = max(hueShift(prev, (0.01 + uTreble * 0.03) * f), 0.0);
          prev *= pow(0.94, f);
          // Subtract a tiny floor so old trails die out to true black.
          prev = max(prev - 0.004 * f, 0.0);

          // New shapes drawn from the audio.
          float u = fract(a0 / 6.2831853 + 0.5);
          float tt = u < 0.5 ? u * 2.0 : 2.0 - u * 2.0;
          float w = texture2D(uWave, vec2(tt, 0.5)).r * 2.0 - 1.0;
          float sp = texture2D(uSpectrum, vec2(0.04 + tt * 0.7, 0.5)).r;
          vec3 inj = vec3(0.0);
          if (uMode < 0.5) {
            float ringR = 0.15 + uBass * 0.11 + w * 0.06 * (0.4 + uLevel);
            inj += hue(uHue + u, 0.85, 1.0) * smoothstep(0.011, 0.0, abs(r - ringR)) * (0.4 + uLevel * 1.6);
            float petalR = 0.05 + sp * 0.07;
            inj += hue(uHue + 0.5 + tt * 0.3, 0.7, 1.0) * smoothstep(0.012, 0.0, abs(r - petalR)) * sp * 1.4;
          } else if (uMode > 1.5) {
            // Spider web: spokes plus polygonal rings that sag between them.
            const float SPOKES = 10.0;
            const float SEG = 6.2831853 / SPOKES;
            float spin = uTime * 0.07;
            float am = mod(a0 + spin, SEG) - SEG * 0.5;
            float spokeIdx = floor((a0 + spin) / SEG + SPOKES);
            float spokeBand = texture2D(uSpectrum, vec2(0.05 + mod(spokeIdx, SPOKES) / SPOKES * 0.7, 0.5)).r;
            float spokeLen = 0.12 + spokeBand * 0.45;
            float spoke = smoothstep(0.005, 0.0, abs(sin(am)) * r) * step(r, spokeLen) * (0.2 + spokeBand * 0.9);
            // Distance from centre to the polygon edge in this direction, so rings bend like silk.
            float poly = cos(SEG * 0.5) / cos(am);
            float ringR = r / poly;
            float ringIdx = floor(ringR / 0.075 + 0.5);
            float ringBand = texture2D(uSpectrum, vec2(0.03 + ringIdx * 0.09, 0.5)).r;
            float ring = smoothstep(0.007, 0.0, abs(ringR - ringIdx * 0.075 - w * 0.012)) * step(0.5, ringIdx) * step(ringIdx, 6.5);
            ring *= ringBand * 0.9;
            inj += hue(uHue + 0.28 + ringIdx * 0.04, 0.85, 1.0) * ring;
            inj += hue(uHue + 0.82, 0.7, 1.0) * spoke;
            inj += hue(uHue + 0.1, 0.5, 1.0) * smoothstep(0.035, 0.0, r) * (0.3 + uBeat * 1.5);
          } else {
            const float POINTS = 6.0;
            float k = abs(fract(u * POINTS) - 0.5) * 2.0;
            float starR = 0.22 + (1.0 - k) * (0.06 + uBass * 0.16) + w * 0.04 + sp * 0.05;
            inj += hue(uHue + r * 1.5, 0.9, 1.0) * smoothstep(0.009, 0.0, abs(r - starR)) * (0.4 + uLevel * 1.6);
            inj += hue(uHue + 0.33, 0.6, 1.0) * smoothstep(0.03, 0.0, r) * uBeat * 2.0;
          }

          vec3 col = max(prev, inj) + inj * 0.25;
          gl_FragColor = vec4(min(col, vec3(6.0)), 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });

    this.display = new THREE.ShaderMaterial({
      uniforms: {
        tFeed: { value: null as THREE.Texture | null },
        uAspect: { value: 1 },
        uKaleido: { value: options.kaleido },
        uTime: this.u.uTime,
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tFeed;
        uniform float uAspect;
        uniform float uKaleido;
        uniform float uTime;
        varying vec2 vUv;
        void main() {
          vec2 uv = vUv;
          if (uKaleido > 0.5) {
            vec2 p = (uv - 0.5) * vec2(uAspect, 1.0);
            float r = length(p);
            float seg = 6.2831853 / uKaleido;
            float a = mod(atan(p.y, p.x) + uTime * 0.05, seg);
            a = abs(a - seg * 0.5);
            uv = vec2(cos(a), sin(a)) * r / vec2(uAspect, 1.0) + 0.5;
          }
          gl_FragColor = vec4(texture2D(tFeed, uv).rgb, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
  }

  resize(width: number, height: number) {
    this.read.setSize(width, height);
    this.write.setSize(width, height);
    const aspect = width / Math.max(1, height);
    this.feedback.uniforms.uAspect.value = aspect;
    this.display.uniforms.uAspect.value = aspect;
    // Start from black after a resize.
    const renderer = this.ctx.renderer;
    for (const rt of [this.read, this.write]) {
      renderer.setRenderTarget(rt);
      renderer.clear();
    }
    renderer.setRenderTarget(null);
  }

  update(frame: AudioFrame, dt: number, time: number) {
    applyAudio(this.u, frame, time);
    this.dt = dt;
    this.hueOffset += dt * (0.03 + frame.treble * 0.05) + (frame.tempo.downbeat ? 0.12 : frame.hit ? 0.05 : 0);
  }

  render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget) {
    const fu = this.feedback.uniforms;
    fu.uPrev.value = this.read.texture;
    fu.uDt.value = Math.min(this.dt, 1 / 20);
    fu.uHue.value = this.hueOffset;
    this.quad.material = this.feedback;
    renderer.setRenderTarget(this.write);
    this.quad.render(renderer);
    [this.read, this.write] = [this.write, this.read];

    this.display.uniforms.tFeed.value = this.read.texture;
    this.quad.material = this.display;
    renderer.setRenderTarget(target);
    this.quad.render(renderer);
  }

  dispose() {
    this.read.dispose();
    this.write.dispose();
    this.feedback.dispose();
    this.display.dispose();
    this.quad.dispose();
  }
}
