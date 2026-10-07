import * as THREE from 'three';
import { BANDS, type AudioFrame } from '../../audio/analysis';
import { HistoryTexture } from '../AudioTextures';
import { AUDIO_UNIFORMS, COMMON, HISTORY, NOISE } from '../glsl';
import { ScenePreset, createGlow, createStars } from '../helpers';
import type { PresetContext } from '../types';

const ROWS = 200;
const MIST = 500;

/**
 * "Bars and Waves : Ocean Mist" as a glowing spectrogram sea: each moment of
 * sound becomes a wave that rolls away towards a misty horizon.
 */
export class OceanPreset extends ScenePreset {
  readonly bloom = { strength: 1.0, radius: 0.7, threshold: 0.08 };
  private readonly history = this.own(new HistoryTexture(BANDS, ROWS, 28));
  private readonly stars;
  private readonly moon;
  private readonly mistMaterial: THREE.ShaderMaterial;
  private readonly target = new THREE.Vector3(0, 0.6, -14);

  constructor(ctx: PresetContext) {
    super(ctx, 55, 0.1, 400);
    this.scene.background = new THREE.Color(0x01040a);

    const terrain = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 46, 220, 240).rotateX(-Math.PI / 2).translate(0, 0, -17),
      new THREE.ShaderMaterial({
        uniforms: { ...this.u, ...this.history.uniforms },
        vertexShader: /* glsl */ `
          ${AUDIO_UNIFORMS}
          ${HISTORY}
          ${NOISE}
          varying float vH;
          varying vec2 vUv;
          varying float vDist;
          void main() {
            float f = abs(uv.x - 0.5) * 2.0;
            float fx = 0.02 + pow(f, 1.25) * 0.85;
            float age = uv.y;
            float v = histSmooth(fx, age * ${(ROWS - 4).toFixed(1)});
            float edge = smoothstep(1.0, 0.7, f);
            float h = pow(v, 1.6) * 5.0 * edge * (1.0 - 0.35 * f) * (1.0 - age * 0.3);
            vec3 p = position;
            h += snoise(vec3(p.x * 0.11, p.z * 0.11 + uTime * 0.12, uTime * 0.05)) * (0.35 + uLevel * 0.35);
            p.y += h;
            vH = h;
            vUv = uv;
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            vDist = -mv.z;
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: /* glsl */ `
          ${COMMON}
          uniform float uBass;
          uniform float uTreble;
          varying float vH;
          varying vec2 vUv;
          varying float vDist;
          void main() {
            vec2 grid = vUv * vec2(110.0, 120.0);
            vec2 gd = abs(fract(grid - 0.5) - 0.5) / fwidth(grid);
            float line = 1.0 - min(min(gd.x, gd.y), 1.0);
            float hN = clamp(vH / 4.0, 0.0, 1.0);
            vec3 lineCol = mix(toLinear(vec3(0.05, 0.35, 1.0)), toLinear(vec3(0.15, 1.0, 0.85)), smoothstep(0.05, 0.45, hN));
            lineCol = mix(lineCol, vec3(1.0), smoothstep(0.65, 1.0, hN));
            float fog = exp(-vDist * 0.05);
            vec3 col = vec3(0.0, 0.006, 0.02);
            col += lineCol * line * (0.25 + hN * 2.6 + uTreble * 0.4) * fog;
            col += lineCol * hN * 0.18;
            vec3 fogCol = toLinear(vec3(0.02, 0.09, 0.16)) * (1.0 + uBass * 1.5);
            col = mix(fogCol, col, fog);
            gl_FragColor = vec4(col, 1.0);
          }
        `,
      }),
    );
    terrain.frustumCulled = false;
    this.scene.add(terrain);

    // Sky gradient with a haze line at the horizon.
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(200, 32, 16),
      new THREE.ShaderMaterial({
        uniforms: { uBass: this.u.uBass },
        side: THREE.BackSide,
        depthWrite: false,
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          ${COMMON}
          uniform float uBass;
          varying vec3 vDir;
          void main() {
            float y = vDir.y;
            vec3 zenith = toLinear(vec3(0.0, 0.02, 0.07));
            vec3 horizon = toLinear(vec3(0.02, 0.13, 0.22)) * (1.0 + uBass * 0.6);
            vec3 col = mix(horizon, zenith, smoothstep(-0.02, 0.35, y));
            gl_FragColor = vec4(col, 1.0);
          }
        `,
      }),
    );
    this.scene.add(sky);

    this.stars = createStars(1400, 150, this.u, true);
    this.scene.add(this.stars.points);

    this.moon = createGlow(0x6fdcff, 26);
    this.moon.mesh.position.set(0, 9, -120);
    this.scene.add(this.moon.mesh);

    // Drifting mist: big, soft additive sprites hovering above the waves.
    const seeds = new Float32Array(MIST * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    const mistGeo = new THREE.BufferGeometry();
    mistGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MIST * 3), 3));
    mistGeo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    this.mistMaterial = new THREE.ShaderMaterial({
      uniforms: { ...this.u, uScale: { value: 1 } },
      vertexShader: /* glsl */ `
        ${AUDIO_UNIFORMS}
        attribute vec4 aSeed;
        uniform float uScale;
        varying float vAlpha;
        void main() {
          float z = -mod(aSeed.z * 44.0 + uTime * (0.8 + aSeed.w * 0.6), 44.0) + 5.0;
          vec3 p = vec3((aSeed.x - 0.5) * 36.0 + sin(uTime * 0.2 + aSeed.w * 6.28) * 1.5, 0.8 + aSeed.y * 3.5, z);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = (60.0 + aSeed.w * 90.0) * uScale / -mv.z * (1.0 + uBass * 0.6);
          float lifeFade = smoothstep(5.0, 1.0, z) * smoothstep(-39.0, -30.0, z);
          vAlpha = lifeFade * (0.012 + uMid * 0.035 + uBeat * 0.015);
        }
      `,
      fragmentShader: /* glsl */ `
        ${COMMON}
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float a = exp(-d * d * 3.5) * smoothstep(1.0, 0.8, d);
          gl_FragColor = vec4(toLinear(vec3(0.3, 0.95, 0.9)) * a * vAlpha, 1.0);
        }
      `,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    const mist = new THREE.Points(mistGeo, this.mistMaterial);
    mist.frustumCulled = false;
    this.scene.add(mist);
  }

  resize(width: number, height: number) {
    super.resize(width, height);
    const scale = height / 900;
    this.stars.material.uniforms.uScale.value = scale;
    this.mistMaterial.uniforms.uScale.value = scale * 12;
  }

  protected animate(frame: AudioFrame, dt: number, t: number) {
    this.history.update(frame.spectrum, dt);
    this.moon.material.uniforms.uIntensity.value = 0.25 + frame.bass * 0.5 + frame.beat * 0.2;
    const cam = this.camera;
    cam.position.set(Math.sin(t * 0.07) * 2.2, 3.4 + Math.sin(t * 0.11) * 0.5, 8.5);
    this.target.x = Math.sin(t * 0.05) * 1.5;
    cam.lookAt(this.target);
  }
}
