import * as THREE from 'three';
import type { AudioFrame } from '../../audio/analysis';
import { HistoryTexture } from '../AudioTextures';
import { AUDIO_UNIFORMS, COMMON, HISTORY } from '../glsl';
import { ScenePreset } from '../helpers';
import type { PresetContext } from '../types';

const SEGMENTS = 320;
const RINGS = 46;
const SPACING = 0.6;
const STARS = 2500;

/**
 * "Bars and Waves : Scope" turned into a tunnel: the oscilloscope is drawn
 * as a glowing ring, and every past waveform keeps flying away from you.
 */
export class ScopePreset extends ScenePreset {
  readonly bloom = { strength: 0.75, radius: 0.45, threshold: 0.2 };
  private readonly history = this.own(new HistoryTexture(256, RINGS + 4, 20, true));
  private readonly starMaterial: THREE.ShaderMaterial;
  private travel = 0;
  private roll = 0;

  constructor(ctx: PresetContext) {
    super(ctx, 70, 0.05, 200);
    this.scene.background = new THREE.Color(0x000000);

    // One ribbon ring (inner/outer vertex per step), instanced once per history row.
    const positions = new Float32Array((SEGMENTS + 1) * 2 * 3);
    const index: number[] = [];
    for (let i = 0; i <= SEGMENTS; i++) {
      positions.set([i / SEGMENTS, -1, 0, i / SEGMENTS, 1, 0], i * 6);
      if (i < SEGMENTS) {
        const a = i * 2;
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(index);
    geometry.setAttribute('aRow', new THREE.InstancedBufferAttribute(Float32Array.from({ length: RINGS }, (_, i) => i), 1));
    geometry.instanceCount = RINGS;

    const rings = new THREE.Mesh(
      geometry,
      new THREE.ShaderMaterial({
        uniforms: { ...this.u, ...this.history.uniforms },
        vertexShader: /* glsl */ `
          ${AUDIO_UNIFORMS}
          ${HISTORY}
          attribute float aRow;
          varying float vSide;
          varying float vRow;
          varying float vFront;
          varying float vW;
          void main() {
            float t = position.x;
            float side = position.y;
            // Mirror the waveform around the ring so the seam is invisible.
            float tt = t < 0.5 ? t * 2.0 : 2.0 - t * 2.0;
            bool front = aRow < 0.5;
            float w = front
              ? texture2D(uWave, vec2(tt, 0.5)).r * 2.0 - 1.0
              : histRow(tt, aRow - 1.0) * 2.0 - 1.0;
            float rowPos = front ? 0.0 : aRow + uHistFrac;
            float ang = t * 6.2831853 + uTime * 0.2 + rowPos * 0.07;
            float radius = 1.5 + uBass * 0.35 + uBeat * 0.12;
            float r = radius + w * (0.45 + uLevel * 0.35);
            float thick = (front ? 0.026 : 0.014) + uLevel * 0.01;
            vec2 dir = vec2(cos(ang), sin(ang));
            vec3 p = vec3(dir * (r + side * thick), -rowPos * ${SPACING.toFixed(2)});
            vSide = side;
            vRow = rowPos;
            vFront = front ? 1.0 : 0.0;
            vW = abs(w);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          ${COMMON}
          uniform float uTime;
          uniform float uLevel;
          varying float vSide;
          varying float vRow;
          varying float vFront;
          varying float vW;
          void main() {
            float edge = 1.0 - abs(vSide);
            edge = smoothstep(0.0, 0.7, edge);
            vec3 col = hue(0.52 + vRow * 0.013 + uTime * 0.025 + vW * 0.08, 0.75 - vFront * 0.35, 1.0);
            float fade = pow(1.0 - clamp(vRow / ${RINGS.toFixed(1)}, 0.0, 1.0), 2.2);
            float intensity = mix(fade * (0.12 + uLevel * 0.25), 1.3 + uLevel * 1.2, vFront);
            gl_FragColor = vec4(col * edge * intensity, 1.0);
          }
        `,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    rings.frustumCulled = false;
    this.scene.add(rings);

    // Star streaks rushing past, faster with louder music.
    const seeds = new Float32Array(STARS * 3);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(STARS * 3), 3));
    starGeo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
    this.starMaterial = new THREE.ShaderMaterial({
      uniforms: { ...this.u, uTravel: { value: 0 }, uScale: { value: 1 } },
      vertexShader: /* glsl */ `
        ${AUDIO_UNIFORMS}
        attribute vec3 aSeed;
        uniform float uTravel;
        uniform float uScale;
        varying float vAlpha;
        void main() {
          float ang = aSeed.x * 6.2831853;
          float rad = 2.6 + aSeed.y * 9.0;
          float z = mod(aSeed.z * 60.0 + uTravel, 60.0) - 56.0;
          vec4 mv = modelViewMatrix * vec4(cos(ang) * rad, sin(ang) * rad, z, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = (1.0 + aSeed.y * 2.0) * uScale * (1.0 + uTreble);
          vAlpha = smoothstep(-56.0, -40.0, z) * smoothstep(4.0, 0.0, z);
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          gl_FragColor = vec4(vec3(0.6, 0.8, 1.0) * smoothstep(1.0, 0.0, d) * vAlpha * 0.8, 1.0);
        }
      `,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    const stars = new THREE.Points(starGeo, this.starMaterial);
    stars.frustumCulled = false;
    this.scene.add(stars);
  }

  resize(width: number, height: number) {
    super.resize(width, height);
    this.starMaterial.uniforms.uScale.value = height / 900;
  }

  protected animate(frame: AudioFrame, dt: number, t: number) {
    this.history.update(frame.waveform, dt);
    this.travel += dt * (3 + frame.level * 14 + frame.beat * 8);
    this.starMaterial.uniforms.uTravel.value = this.travel;
    this.roll += dt * (0.05 + frame.mid * 0.25);

    const cam = this.camera;
    cam.position.set(Math.sin(t * 0.21) * 0.45, Math.cos(t * 0.17) * 0.35, 3.4 - frame.beat * 0.25);
    cam.lookAt(Math.sin(t * 0.13) * 0.6, Math.cos(t * 0.11) * 0.4, -10);
    cam.rotateZ(this.roll);
  }
}
