import * as THREE from 'three';
import type { AudioFrame } from '../../audio/analysis';
import { AUDIO_UNIFORMS, COMMON, NOISE } from '../glsl';
import { ScenePreset, createGlow, createStars } from '../helpers';
import type { PresetContext } from '../types';

const COUNT = 70000;

/**
 * "Ambience : Swirl" as a living galaxy of particles. Each ring of the
 * spiral listens to its own slice of the spectrum, bass in the core and
 * treble on the rim.
 */
export class SwirlPreset extends ScenePreset {
  readonly bloom = { strength: 0.8, radius: 0.6, threshold: 0.2 };
  private readonly material: THREE.ShaderMaterial;
  private readonly core;
  private readonly stars;
  private spin = 0;
  private orbit = 0;

  constructor(ctx: PresetContext) {
    super(ctx, 50, 0.1, 300);
    this.scene.background = new THREE.Color(0x010006);

    const seeds = new Float32Array(COUNT * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3));
    geometry.setAttribute('aRand', new THREE.BufferAttribute(seeds, 4));

    this.material = new THREE.ShaderMaterial({
      uniforms: { ...this.u, uSpin: { value: 0 }, uScale: { value: 1 } },
      vertexShader: /* glsl */ `
        ${AUDIO_UNIFORMS}
        ${COMMON}
        ${NOISE}
        attribute vec4 aRand;
        uniform float uSpin;
        uniform float uScale;
        varying vec3 vColor;
        void main() {
          const float ARMS = 4.0;
          float arm = floor(aRand.x * ARMS);
          float rad = pow(aRand.y, 0.6) * 7.0 + 0.15;
          float band = texture2D(uSpectrum, vec2(clamp(0.03 + rad / 7.2 * 0.78, 0.0, 1.0), 0.5)).r;
          float scatter = (aRand.z - 0.5) * (0.4 + rad * 0.06);
          float ang = arm * (6.2831853 / ARMS) + rad * 0.78 + scatter - uSpin * (1.5 / (0.6 + rad * 0.35));
          float r = rad * (1.0 + band * 0.3 + uBeat * 0.08);
          float y = (aRand.w - 0.5) * (0.12 + rad * 0.05) * (1.0 + band * 3.5);
          y += sin(rad * 1.6 - uTime * 2.4) * 0.4 * uBass;
          vec3 p = vec3(cos(ang) * r, y, sin(ang) * r);
          vec3 q = p * 0.32 + vec3(0.0, uTime * 0.18, 0.0);
          p += vec3(snoise(q), snoise(q + 17.0), snoise(q + 31.0)) * (0.12 + uMid * 0.55);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = (1.1 + band * 3.2 + aRand.z) * uScale * (12.0 / -mv.z);
          float h = 0.6 + rad * 0.045 + uTime * 0.02 + band * 0.1;
          vColor = hue(h, 0.8 - band * 0.3, 1.0) * (0.09 + band * 1.15 + uBeat * 0.1);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = dot(c, c) * 4.0;
          if (d > 1.0) discard;
          gl_FragColor = vec4(vColor * exp(-d * 4.0), 1.0);
        }
      `,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    const points = new THREE.Points(geometry, this.material);
    points.frustumCulled = false;
    this.scene.add(points);

    this.core = createGlow(0x9a7bff, 4.5);
    this.scene.add(this.core.mesh);

    this.stars = createStars(1800, 120, this.u);
    this.scene.add(this.stars.points);
  }

  resize(width: number, height: number) {
    super.resize(width, height);
    this.material.uniforms.uScale.value = height / 1000;
    this.stars.material.uniforms.uScale.value = height / 900;
    this.camera.fov = this.aspect < 1 ? 70 : 50;
    this.camera.updateProjectionMatrix();
  }

  protected animate(frame: AudioFrame, dt: number, t: number) {
    this.spin += dt * (0.22 + frame.mid * 0.6 + frame.beat * 0.35);
    this.orbit += dt * (0.05 + frame.level * 0.08);
    this.material.uniforms.uSpin.value = this.spin;

    const glow = this.core.material.uniforms;
    glow.uSize.value = 3 + frame.bass * 3 + frame.beat * 1.2;
    glow.uIntensity.value = 0.25 + frame.bass * 0.7 + frame.beat * 0.4;

    const elevation = 0.55 + Math.sin(t * 0.09) * 0.3;
    const distance = 11.5 - frame.beat * 0.6;
    this.camera.position.set(
      Math.cos(this.orbit) * Math.cos(elevation) * distance,
      Math.sin(elevation) * distance,
      Math.sin(this.orbit) * Math.cos(elevation) * distance,
    );
    this.camera.lookAt(0, 0, 0);
  }
}
