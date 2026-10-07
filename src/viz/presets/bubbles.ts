import * as THREE from 'three';
import type { AudioFrame } from '../../audio/analysis';
import { AUDIO_UNIFORMS, COMMON, NOISE } from '../glsl';
import { ScenePreset, createStars } from '../helpers';
import type { PresetContext } from '../types';

const COUNT = 130;

/**
 * "Ambience : Bubbles": soap bubbles drifting up through dark water. Each
 * bubble belongs to a frequency band and swells when that band sounds; the
 * thin-film shading gives the rainbow sheen of real soap film.
 */
export class BubblesPreset extends ScenePreset {
  readonly bloom = { strength: 0.5, radius: 0.45, threshold: 0.4 };
  private readonly material: THREE.ShaderMaterial;
  private readonly stars;
  private rise = 0;
  private orbit = 0;

  constructor(ctx: PresetContext) {
    super(ctx, 50, 0.1, 300);
    this.scene.background = new THREE.Color(0x01060c);

    const sphere = new THREE.IcosahedronGeometry(1, 4);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setIndex(sphere.getIndex());
    geometry.setAttribute('position', sphere.getAttribute('position'));
    geometry.setAttribute('normal', sphere.getAttribute('normal'));
    const seeds = new Float32Array(COUNT * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    geometry.instanceCount = COUNT;

    this.material = new THREE.ShaderMaterial({
      uniforms: { ...this.u, uRise: { value: 0 } },
      vertexShader: /* glsl */ `
        ${AUDIO_UNIFORMS}
        ${NOISE}
        attribute vec4 aSeed;
        uniform float uRise;
        varying vec3 vNormalW;
        varying vec3 vPosW;
        varying float vBand;
        varying float vFade;
        varying float vSeed;
        void main() {
          // Rise from below the frame to above it, then wrap around.
          float life = fract(aSeed.x + uRise * (0.5 + aSeed.y * 0.8) / 14.0);
          float y = mix(-7.0, 7.0, life);
          float ang = aSeed.z * 6.2831853 + sin(uTime * 0.3 + aSeed.w * 6.0) * 0.4;
          float rad = 1.5 + aSeed.w * 7.5;
          vec3 center = vec3(cos(ang) * rad, y, sin(ang) * rad - 1.0);
          center.x += sin(y * 0.8 + aSeed.w * 10.0) * 0.35;

          float band = texture2D(uSpectrum, vec2(0.03 + aSeed.y * 0.85, 0.5)).r;
          float size = (0.1 + aSeed.y * aSeed.y * 0.45) * (1.0 + band * 0.9 + uBeat * 0.15 * (1.0 - aSeed.y));
          size *= smoothstep(0.0, 0.08, life) * smoothstep(1.0, 0.9, life);

          // Gentle wobble so they read as liquid film, not glass marbles.
          vec3 n = normal;
          float wob = snoise(n * 2.0 + vec3(uTime * 0.8 + aSeed.x * 20.0)) * (0.05 + uTreble * 0.12);
          vec3 p = center + n * size * (1.0 + wob);

          vec4 world = modelMatrix * vec4(p, 1.0);
          vPosW = world.xyz;
          vNormalW = normalize(mat3(modelMatrix) * n);
          vBand = band;
          vFade = smoothstep(0.0, 0.1, life) * smoothstep(1.0, 0.85, life);
          vSeed = aSeed.x;
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */ `
        ${COMMON}
        uniform float uTime;
        uniform float uLevel;
        varying vec3 vNormalW;
        varying vec3 vPosW;
        varying float vBand;
        varying float vFade;
        varying float vSeed;
        void main() {
          vec3 N = normalize(vNormalW);
          vec3 V = normalize(cameraPosition - vPosW);
          float facing = abs(dot(N, V));
          float fres = pow(1.0 - facing, 2.2);
          // Thin-film interference: hue follows the viewing angle and a drifting thickness.
          float thickness = facing * 1.6 + N.y * 0.35 + uTime * 0.05 + vSeed;
          vec3 film = hue(thickness, 0.75, 1.0);
          vec3 R = reflect(-V, N);
          float spec = pow(max(dot(R, normalize(vec3(0.4, 0.8, 0.5))), 0.0), 120.0) * 3.0;
          spec += pow(max(dot(R, normalize(vec3(-0.6, 0.3, 0.7))), 0.0), 40.0) * 0.6;
          vec3 col = film * fres * (0.1 + vBand * 0.6 + uLevel * 0.15) + vec3(spec) * 0.5;
          gl_FragColor = vec4(col * vFade, 1.0);
        }
      `,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const bubbles = new THREE.Mesh(geometry, this.material);
    bubbles.frustumCulled = false;
    this.scene.add(bubbles);

    // Water-column glow behind everything.
    const backdrop = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: { uBass: this.u.uBass, uTime: this.u.uTime },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = vec4(position.xy, 0.9999, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          ${COMMON}
          uniform float uBass;
          uniform float uTime;
          varying vec2 vUv;
          void main() {
            float shaft = pow(max(0.0, sin(vUv.x * 9.0 + uTime * 0.2) * 0.5 + 0.5), 6.0) * vUv.y;
            vec3 deep = toLinear(vec3(0.0, 0.03, 0.07));
            vec3 top = toLinear(vec3(0.02, 0.16, 0.24)) * (1.0 + uBass * 0.7);
            vec3 col = mix(deep, top, smoothstep(0.0, 1.0, vUv.y)) + top * shaft * 0.3;
            gl_FragColor = vec4(col, 1.0);
          }
        `,
        depthWrite: false,
      }),
    );
    backdrop.frustumCulled = false;
    backdrop.renderOrder = -1;
    this.scene.add(backdrop);

    this.stars = createStars(900, 60, this.u);
    this.scene.add(this.stars.points);
  }

  resize(width: number, height: number) {
    super.resize(width, height);
    this.stars.material.uniforms.uScale.value = height / 1100;
    this.camera.fov = this.aspect < 1 ? 70 : 50;
    this.camera.updateProjectionMatrix();
  }

  protected animate(frame: AudioFrame, dt: number, t: number) {
    this.rise += dt * (0.6 + frame.level * 1.4 + frame.beat * 0.6);
    this.orbit += dt * (0.04 + frame.mid * 0.06);
    this.material.uniforms.uRise.value = this.rise;
    const cam = this.camera;
    cam.position.set(Math.sin(this.orbit) * 14, Math.sin(t * 0.1) * 1.2, Math.cos(this.orbit) * 14);
    cam.lookAt(0, 0, -1);
  }
}
