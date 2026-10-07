import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import type { AudioFrame } from '../../audio/analysis';
import { AUDIO_UNIFORMS, COMMON, FULLSCREEN_VERT } from '../glsl';
import { applyAudio, createAudioUniforms } from '../helpers';
import type { BloomSettings, Preset, PresetContext } from '../types';

/**
 * Flat 2D scenes in the spirit of the original WMP visualizations. Each one is
 * a single fragment shader that draws into a ping-pong buffer, so it can read
 * the previous frame (uPrev) for trails, smoke and phosphor persistence.
 */
abstract class FlatPreset implements Preset {
  abstract readonly bloom: BloomSettings;
  protected readonly u;
  private readonly quad = new FullScreenQuad();
  protected readonly material: THREE.ShaderMaterial;
  private readonly copy: THREE.ShaderMaterial;
  private read: THREE.WebGLRenderTarget;
  private write: THREE.WebGLRenderTarget;
  private dt = 1 / 60;

  /**
   * @param fragmentBody draws the next frame into the feedback buffer (can read uPrev)
   * @param displayBody optional final pass reading tFeed, for things that must not leave trails
   */
  constructor(
    private readonly ctx: PresetContext,
    fragmentBody: string,
    extraUniforms: Record<string, THREE.IUniform> = {},
    displayBody = 'void main() { gl_FragColor = vec4(texture2D(tFeed, vUv).rgb, 1.0); }',
  ) {
    this.u = createAudioUniforms(ctx);
    const rt = { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    this.read = new THREE.WebGLRenderTarget(1, 1, rt);
    this.write = new THREE.WebGLRenderTarget(1, 1, rt);
    const shared = {
      ...this.u,
      ...extraUniforms,
      uPeaks: { value: ctx.textures.peaks },
      uRes: { value: new THREE.Vector2(1, 1) },
      uDt: { value: 1 / 60 },
    };
    const header = /* glsl */ `
      ${AUDIO_UNIFORMS}
      ${COMMON}
      uniform sampler2D uPeaks;
      uniform vec2 uRes;
      uniform float uDt;
      varying vec2 vUv;
    `;
    this.material = new THREE.ShaderMaterial({
      uniforms: { ...shared, uPrev: { value: null as THREE.Texture | null } },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: `${header}\nuniform sampler2D uPrev;\n${fragmentBody}`,
      depthTest: false,
      depthWrite: false,
    });
    this.copy = new THREE.ShaderMaterial({
      uniforms: { ...shared, tFeed: { value: null as THREE.Texture | null } },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: `${header}\nuniform sampler2D tFeed;\n${displayBody}`,
      depthTest: false,
      depthWrite: false,
    });
  }

  resize(width: number, height: number) {
    this.read.setSize(width, height);
    this.write.setSize(width, height);
    this.material.uniforms.uRes.value.set(width, height);
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
  }

  render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget) {
    const m = this.material.uniforms;
    m.uPrev.value = this.read.texture;
    m.uDt.value = Math.min(this.dt, 1 / 20);
    this.quad.material = this.material;
    renderer.setRenderTarget(this.write);
    this.quad.render(renderer);
    [this.read, this.write] = [this.write, this.read];

    this.copy.uniforms.tFeed.value = this.read.texture;
    this.quad.material = this.copy;
    renderer.setRenderTarget(target);
    this.quad.render(renderer);
  }

  dispose() {
    this.read.dispose();
    this.write.dispose();
    this.material.dispose();
    this.copy.dispose();
    this.quad.dispose();
  }
}

export type BarsPalette = 'bars' | 'ocean' | 'fire';

const PALETTES: Record<BarsPalette, { index: number; trail: number; rise: number; decay: number; bloom: BloomSettings }> = {
  bars: { index: 0, trail: 0, rise: 0, decay: 0, bloom: { strength: 0.35, radius: 0.3, threshold: 0.5 } },
  ocean: { index: 1, trail: 1, rise: 0.0016, decay: 0.955, bloom: { strength: 0.45, radius: 0.5, threshold: 0.35 } },
  fire: { index: 2, trail: 1, rise: 0.0045, decay: 0.94, bloom: { strength: 0.55, radius: 0.45, threshold: 0.3 } },
};

/**
 * The classic flat spectrum bars with falling peak caps. "ocean" lets mist
 * drift off the tops, "fire" turns them into "Fire Storm" with rising flames.
 */
export class ClassicBarsPreset extends FlatPreset {
  readonly bloom: BloomSettings;

  constructor(ctx: PresetContext, palette: BarsPalette) {
    const p = PALETTES[palette];
    const lib = /* glsl */ `
      uniform float uPalette;
      uniform float uTrail;
      uniform float uRise;
      uniform float uDecay;

      const float BARS = 40.0;
      const float BASE = 0.07;
      const float TOP = 0.86;

      vec3 barColor(float t) {
        if (uPalette < 0.5) return toLinear(mix(mix(vec3(0.05, 0.2, 1.0), vec3(0.2, 0.65, 1.0), smoothstep(0.0, 0.5, t)), vec3(0.8, 0.95, 1.0), smoothstep(0.5, 1.0, t)));
        if (uPalette < 1.5) return toLinear(mix(mix(vec3(0.0, 0.3, 0.6), vec3(0.0, 0.8, 0.75), smoothstep(0.0, 0.55, t)), vec3(0.75, 1.0, 0.85), smoothstep(0.55, 1.0, t)));
        return toLinear(mix(mix(vec3(0.6, 0.02, 0.0), vec3(1.0, 0.45, 0.0), smoothstep(0.0, 0.5, t)), vec3(1.0, 0.95, 0.4), smoothstep(0.5, 1.0, t)));
      }

      // body: the bar itself (feeds the trails); overlay: caps and reflection (drawn on top only).
      void bars(vec2 uv, out vec3 body, out vec3 overlay) {
        body = vec3(0.0);
        overlay = vec3(0.0);
        float margin = 0.035;
        float x = (uv.x - margin) / (1.0 - 2.0 * margin);
        if (x <= 0.0 || x >= 1.0) return;
        float i = floor(x * BARS);
        float fx = fract(x * BARS);
        if (fx < 0.14 || fx > 0.86) return;
        float bandX = 0.02 + (i + 0.5) / BARS * 0.9;
        float v = texture2D(uSpectrum, vec2(bandX, 0.5)).r;
        float pk = texture2D(uPeaks, vec2(bandX, 0.5)).r;
        float h = v * (TOP - BASE);
        float y = uv.y - BASE;
        if (y >= 0.0 && y <= h) body = barColor(y / (TOP - BASE)) * (0.75 + 0.5 * y / max(h, 0.001));
        float capY = pk * (TOP - BASE) + 0.006;
        if (pk > 0.02 && abs(y - capY) < 0.005) overlay = uPalette > 1.5 ? toLinear(vec3(1.0, 0.9, 0.6)) : vec3(1.0);
        // Glossy floor reflection, like the WMP skin's mirrored bars.
        if (y < 0.0 && -y < h * 0.3) overlay = barColor(-y / (TOP - BASE)) * 0.18 * (1.0 + y / (h * 0.3 + 0.0001));
      }
    `;
    super(
      ctx,
      /* glsl */ `
        ${lib}
        void main() {
          float f = uDt * 60.0;
          vec2 uv = vUv;
          vec3 prev = vec3(0.0);
          if (uTrail > 0.5) {
            // Trails drift upwards, sway a little and cool down.
            float sway = sin(uv.y * 28.0 + uTime * 3.0) * 0.0012 * (uPalette > 1.5 ? 2.0 : 0.7);
            vec2 src = uv - vec2(sway, uRise * f);
            vec2 px = vec2(1.0 / uRes.x, 0.0);
            prev = (texture2D(uPrev, src).rgb * 2.0 + texture2D(uPrev, src + px).rgb + texture2D(uPrev, src - px).rgb) * 0.25;
            prev *= pow(uDecay, f);
            if (uPalette > 1.5) prev *= vec3(1.0, pow(0.97, f), pow(0.9, f));
          }
          vec3 body;
          vec3 overlay;
          bars(uv, body, overlay);
          gl_FragColor = vec4(max(prev, body), 1.0);
        }
      `,
      {
        uPalette: { value: p.index },
        uTrail: { value: p.trail },
        uRise: { value: p.rise },
        uDecay: { value: p.decay },
      },
      /* glsl */ `
        ${lib}
        void main() {
          vec3 body;
          vec3 overlay;
          bars(vUv, body, overlay);
          vec3 col = texture2D(tFeed, vUv).rgb;
          gl_FragColor = vec4(length(overlay) > 0.0 ? overlay : col, 1.0);
        }
      `,
    );
    this.bloom = p.bloom;
  }
}

/** The classic oscilloscope: one bright line across a dark graticule, with phosphor afterglow. */
export class ClassicScopePreset extends FlatPreset {
  readonly bloom = { strength: 0.6, radius: 0.4, threshold: 0.2 };

  constructor(ctx: PresetContext) {
    super(
      ctx,
      /* glsl */ `
        void main() {
          float f = uDt * 60.0;
          vec2 uv = vUv;
          vec2 pix = uv * uRes;
          float s = uRes.y / 600.0;
          vec3 prev = texture2D(uPrev, uv).rgb * pow(0.78, f);

          // Distance to the waveform polyline, sampled around this column.
          float best = 1e5;
          for (int k = -4; k <= 4; k++) {
            float xs = uv.x + float(k) * 1.5 * s / uRes.x;
            float w = texture2D(uWave, vec2(xs, 0.5)).r * 2.0 - 1.0;
            vec2 p = vec2(xs * uRes.x, (0.5 + w * 0.36) * uRes.y);
            best = min(best, length(p - pix));
          }
          vec3 lineCol = hue(0.36 + uTime * 0.01 + uBass * 0.1, 0.75, 1.0);
          float line = smoothstep(2.4 * s, 0.7 * s, best) * (0.8 + uLevel * 0.8);
          vec3 glow = lineCol * exp(-best / (10.0 * s)) * 0.15;

          vec2 g = abs(fract(uv * vec2(10.0, 8.0) - 0.5) - 0.5) / fwidth(uv * vec2(10.0, 8.0));
          float grid = (1.0 - min(min(g.x, g.y), 1.0)) * 0.025;
          float axis = (1.0 - min(abs(uv.y - 0.5) * uRes.y / s, 1.0)) * 0.05;

          vec3 col = max(prev, lineCol * line + glow) + vec3(0.1, 0.25, 0.15) * (grid + axis);
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    );
  }
}
