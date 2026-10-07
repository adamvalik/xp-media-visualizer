import * as THREE from 'three';
import { BANDS, type AudioFrame } from '../../audio/analysis';
import { HistoryTexture } from '../AudioTextures';
import { AUDIO_UNIFORMS, COMMON, HISTORY } from '../glsl';
import { ScenePreset, createGlow } from '../helpers';
import type { PresetContext } from '../types';

const SEGS = 48;
const RINGS = 56;
const RADIUS = 3.2;
const SPACING = 1.05;

/**
 * "Battery : hyperspace": a tunnel built from spectrum rings. The newest
 * ring is right in front of you; older ones stream away towards a pulsing
 * light at the vanishing point.
 */
export class TunnelPreset extends ScenePreset {
  readonly bloom = { strength: 0.6, radius: 0.45, threshold: 0.35 };
  private readonly history = this.own(new HistoryTexture(BANDS, RINGS + 4, 15));
  private readonly core;
  private readonly material: THREE.ShaderMaterial;
  private roll = 0;
  private kick = 0;

  constructor(ctx: PresetContext) {
    super(ctx, 72, 0.05, 200);
    this.scene.background = new THREE.Color(0x000000);

    const box = new THREE.BoxGeometry(1, 1, 1);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setIndex(box.getIndex());
    geometry.setAttribute('position', box.getAttribute('position'));
    geometry.setAttribute('normal', box.getAttribute('normal'));
    const cells = new Float32Array(SEGS * RINGS * 2);
    for (let r = 0, i = 0; r < RINGS; r++) {
      for (let s = 0; s < SEGS; s++, i += 2) {
        cells[i] = s;
        cells[i + 1] = r;
      }
    }
    geometry.setAttribute('aCell', new THREE.InstancedBufferAttribute(cells, 2));
    geometry.instanceCount = SEGS * RINGS;

    this.material = new THREE.ShaderMaterial({
      uniforms: { ...this.u, ...this.history.uniforms, uTwist: { value: 0 } },
      vertexShader: /* glsl */ `
        ${AUDIO_UNIFORMS}
        ${HISTORY}
        attribute vec2 aCell;
        uniform float uTwist;
        varying float vLevel;
        varying float vRing;
        varying float vFront;
        varying float vT;
        varying float vY;
        varying vec3 vN;
        void main() {
          float s = aCell.x / ${SEGS.toFixed(1)};
          float tt = s < 0.5 ? s * 2.0 : 2.0 - s * 2.0;
          float fx = 0.03 + tt * 0.75;
          bool front = aCell.y < 0.5;
          float v = front ? texture2D(uSpectrum, vec2(fx, 0.5)).r : histRow(fx, aCell.y - 1.0);
          float ringPos = front ? 0.0 : aCell.y + uHistFrac;
          float len = 0.08 + pow(v, 1.3) * 1.7;
          vec3 b = position;
          vec3 local = vec3(b.x * 0.27, (b.y + 0.5) * len, b.z * 0.2);
          float ang = s * 6.2831853 + ringPos * 0.045 + uTwist;
          vec2 radial = vec2(cos(ang), sin(ang));
          vec2 tangent = vec2(-radial.y, radial.x);
          vec2 xy = radial * (${RADIUS.toFixed(2)} - local.y) + tangent * local.x;
          vec3 p = vec3(xy, local.z - ringPos * ${SPACING.toFixed(2)});
          vLevel = v;
          vRing = ringPos;
          vFront = front ? 1.0 : 0.0;
          vT = tt;
          vY = b.y + 0.5;
          vN = normal;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        ${COMMON}
        uniform float uTime;
        uniform float uBeat;
        varying float vLevel;
        varying float vRing;
        varying float vFront;
        varying float vT;
        varying float vY;
        varying vec3 vN;
        void main() {
          vec3 base = hue(0.78 + vRing * 0.012 + uTime * 0.035 + vT * 0.18, 0.8, 1.0);
          float shade = abs(vN.z) > 0.5 ? 1.0 : (abs(vN.y) > 0.5 ? 1.25 : 0.6);
          float glow = (0.05 + vLevel * vLevel * 1.4) * mix(0.35, 1.0, vY);
          float fade = pow(1.0 - clamp(vRing / ${RINGS.toFixed(1)}, 0.0, 1.0), 1.5);
          vec3 col = base * shade * glow * fade;
          col += vec3(1.0, 0.8, 1.0) * vFront * smoothstep(0.85, 1.0, vY) * vLevel * (0.6 + uBeat * 0.6);
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    const segments = new THREE.Mesh(geometry, this.material);
    segments.frustumCulled = false;
    this.scene.add(segments);

    this.core = createGlow(0xff5cf0, 16);
    this.core.mesh.position.set(0, 0, -RINGS * SPACING - 4);
    this.scene.add(this.core.mesh);
  }

  protected animate(frame: AudioFrame, dt: number, t: number) {
    this.history.update(frame.spectrum, dt);
    if (frame.onset) this.kick += 0.5;
    this.kick *= Math.exp(-dt * 3);
    this.roll += dt * (0.12 + frame.mid * 0.3) + this.kick * dt * 2;
    this.material.uniforms.uTwist.value = t * 0.05;

    const glow = this.core.material.uniforms;
    glow.uIntensity.value = 0.15 + frame.bass * 0.5 + frame.beat * 0.3;
    glow.uSize.value = 14 + frame.bass * 10;

    const cam = this.camera;
    cam.position.set(Math.sin(t * 0.3) * 0.5, Math.cos(t * 0.23) * 0.5, 3.5 - frame.beat * 0.3);
    cam.lookAt(Math.sin(t * 0.17) * 0.8, Math.cos(t * 0.13) * 0.8, -20);
    cam.rotateZ(this.roll);
  }
}
