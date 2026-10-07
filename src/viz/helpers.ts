import * as THREE from 'three';
import type { AudioFrame } from '../audio/analysis';
import { COMMON } from './glsl';
import type { BloomSettings, Preset, PresetContext } from './types';

export type AudioUniforms = ReturnType<typeof createAudioUniforms>;

export function createAudioUniforms(ctx: PresetContext) {
  return {
    uTime: { value: 0 },
    uBass: { value: 0 },
    uMid: { value: 0 },
    uTreble: { value: 0 },
    uLevel: { value: 0 },
    uBeat: { value: 0 },
    uSpectrum: { value: ctx.textures.spectrum as THREE.Texture },
    uWave: { value: ctx.textures.waveform as THREE.Texture },
  };
}

export function applyAudio(u: AudioUniforms, frame: AudioFrame, time: number) {
  u.uTime.value = time;
  u.uBass.value = frame.bass;
  u.uMid.value = frame.mid;
  u.uTreble.value = frame.treble;
  u.uLevel.value = frame.level;
  u.uBeat.value = frame.beat;
}

/** Base class for presets that are a regular three.js scene + perspective camera. */
export abstract class ScenePreset implements Preset {
  abstract readonly bloom: BloomSettings;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  protected readonly u: AudioUniforms;
  protected aspect = 16 / 9;
  private readonly disposables: { dispose(): void }[] = [];

  constructor(protected readonly ctx: PresetContext, fov = 50, near = 0.1, far = 500) {
    this.camera = new THREE.PerspectiveCamera(fov, this.aspect, near, far);
    this.u = createAudioUniforms(ctx);
  }

  resize(width: number, height: number) {
    this.aspect = width / Math.max(1, height);
    this.camera.aspect = this.aspect;
    this.camera.updateProjectionMatrix();
  }

  update(frame: AudioFrame, dt: number, time: number) {
    applyAudio(this.u, frame, time);
    this.animate(frame, dt, time);
  }

  protected abstract animate(frame: AudioFrame, dt: number, time: number): void;

  render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget) {
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
  }

  /** Register non-scene resources (history textures, render targets) for disposal. */
  protected own<T extends { dispose(): void }>(resource: T): T {
    this.disposables.push(resource);
    return resource;
  }

  dispose() {
    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      mesh.geometry?.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    });
    this.disposables.forEach((d) => d.dispose());
  }
}

/** A camera-facing soft glow (additive), handy for cores, suns and singularities. */
export function createGlow(color: THREE.ColorRepresentation, size: number) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uSize: { value: size },
      uIntensity: { value: 1 },
    },
    vertexShader: /* glsl */ `
      uniform float uSize;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        mv.xy += position.xy * uSize;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uIntensity;
      varying vec2 vUv;
      void main() {
        float d = length(vUv - 0.5) * 2.0;
        float g = exp(-d * d * 5.0) * 0.8 + exp(-d * 18.0) * 0.6;
        g *= smoothstep(1.0, 0.7, d);
        gl_FragColor = vec4(uColor * g * uIntensity, 1.0);
      }
    `,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  mesh.frustumCulled = false;
  return { mesh, material };
}

/** Twinkling background stars on a sphere shell. */
export function createStars(count: number, radius: number, u: AudioUniforms, upperOnly = false) {
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    let y = Math.random() * 2 - 1;
    if (upperOnly) y = Math.abs(y) * 0.9 + 0.02;
    const r = Math.sqrt(1 - y * y);
    positions.set([Math.cos(theta) * r * radius, y * radius, Math.sin(theta) * r * radius], i * 3);
    seeds[i] = Math.random();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: u.uTime, uTreble: u.uTreble, uScale: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      uniform float uTime;
      uniform float uTreble;
      uniform float uScale;
      varying float vAlpha;
      void main() {
        vAlpha = (0.35 + 0.65 * (0.5 + 0.5 * sin(uTime * (0.6 + aSeed * 2.0) + aSeed * 40.0))) * (0.4 + aSeed * 0.6);
        vAlpha *= 1.0 + uTreble * 1.5;
        gl_PointSize = (1.0 + aSeed * 1.8) * uScale;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${COMMON}
      varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float a = smoothstep(1.0, 0.0, d);
        gl_FragColor = vec4(vec3(0.7, 0.8, 1.0) * a * vAlpha * 0.6, 1.0);
      }
    `,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return { points, material };
}

export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
};

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
