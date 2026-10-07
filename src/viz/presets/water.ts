import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type { AudioFrame } from '../../audio/analysis';
import { AUDIO_UNIFORMS, COMMON, NOISE } from '../glsl';
import { ScenePreset, createStars } from '../helpers';
import type { PresetContext } from '../types';

const DROPLETS = 4000;

/**
 * "Ambience : Water" as an iridescent liquid orb. Bass swells it, mids
 * ripple it, highs add a fine shimmer, and the spectrum runs around it in
 * latitude bands.
 */
export class WaterPreset extends ScenePreset {
  readonly bloom = { strength: 0.6, radius: 0.55, threshold: 0.45 };
  private readonly dropletMaterial: THREE.ShaderMaterial;
  private readonly stars;
  private orbit = 0;

  constructor(ctx: PresetContext) {
    super(ctx, 38, 0.1, 300);
    this.scene.background = new THREE.Color(0x00030a);

    // Normals are rebuilt in the shader, so share vertices to displace each point only once.
    const raw = new THREE.IcosahedronGeometry(1, 56);
    raw.deleteAttribute('normal');
    raw.deleteAttribute('uv');
    const sphere = mergeVertices(raw, 1e-5);
    raw.dispose();

    const orb = new THREE.Mesh(
      sphere,
      new THREE.ShaderMaterial({
        uniforms: { ...this.u },
        vertexShader: /* glsl */ `
          ${AUDIO_UNIFORMS}
          ${NOISE}
          varying vec3 vNormalW;
          varying vec3 vPosW;
          varying float vDisp;

          float displacement(vec3 n) {
            float t = uTime;
            float d = snoise(n * 1.1 + vec3(0.0, t * 0.25, 0.0)) * (0.08 + uBass * 0.3);
            d += snoise(n * 2.7 + vec3(t * 0.4, 0.0, -t * 0.3)) * (0.03 + uMid * 0.12);
            d += snoise(n * 6.5 - vec3(0.0, t * 0.9, 0.0)) * (0.008 + uTreble * 0.07);
            float lat = acos(clamp(n.y, -1.0, 1.0)) / 3.14159265;
            float band = texture2D(uSpectrum, vec2(0.04 + abs(lat - 0.5) * 1.3, 0.5)).r;
            d += band * 0.08 * (0.5 + 0.5 * sin(lat * 46.0 - t * 3.0));
            return d + uBeat * 0.05;
          }

          void main() {
            const float R = 1.65;
            vec3 n = normalize(position);
            vec3 tangent = normalize(abs(n.y) < 0.99 ? cross(n, vec3(0.0, 1.0, 0.0)) : cross(n, vec3(1.0, 0.0, 0.0)));
            vec3 bitangent = cross(n, tangent);
            const float e = 0.012;
            vec3 n1 = normalize(n + tangent * e);
            vec3 n2 = normalize(n + bitangent * e);
            float d0 = displacement(n);
            vec3 p0 = n * (R + d0);
            vec3 p1 = n1 * (R + displacement(n1));
            vec3 p2 = n2 * (R + displacement(n2));
            vec3 normal = normalize(cross(p1 - p0, p2 - p0));
            if (dot(normal, n) < 0.0) normal = -normal;
            vec4 world = modelMatrix * vec4(p0, 1.0);
            vPosW = world.xyz;
            vNormalW = normalize(mat3(modelMatrix) * normal);
            vDisp = d0;
            gl_Position = projectionMatrix * viewMatrix * world;
          }
        `,
        fragmentShader: /* glsl */ `
          ${COMMON}
          uniform float uTime;
          uniform float uBass;
          uniform float uLevel;
          uniform float uBeat;
          varying vec3 vNormalW;
          varying vec3 vPosW;
          varying float vDisp;
          void main() {
            vec3 N = normalize(vNormalW);
            vec3 V = normalize(cameraPosition - vPosW);
            float fres = pow(1.0 - max(dot(N, V), 0.0), 2.6);
            vec3 R = reflect(-V, N);
            vec3 env = mix(toLinear(vec3(0.01, 0.03, 0.08)), toLinear(vec3(0.2, 0.45, 0.9)), smoothstep(-0.3, 0.9, R.y));
            env += vec3(1.0, 0.92, 0.85) * pow(max(dot(R, normalize(vec3(0.6, 0.75, 0.35))), 0.0), 90.0) * 2.5;
            env += toLinear(vec3(0.4, 0.7, 1.0)) * pow(max(dot(R, normalize(vec3(-0.7, 0.15, -0.6))), 0.0), 18.0) * 0.8;
            vec3 irid = hue(fres * 0.9 + vDisp * 1.6 + uTime * 0.03, 0.7, 1.0);
            vec3 col = toLinear(vec3(0.0, 0.04, 0.1));
            col += env * (0.12 + 0.6 * fres);
            col += irid * fres * (0.25 + uLevel * 0.9);
            col += irid * smoothstep(0.15, 0.4, vDisp) * (0.08 + uBass * 0.45 + uBeat * 0.2);
            gl_FragColor = vec4(col, 1.0);
          }
        `,
      }),
    );
    orb.frustumCulled = false;
    this.scene.add(orb);

    // Droplets orbiting in a loose shell around the orb.
    const seeds = new Float32Array(DROPLETS * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    const dropGeo = new THREE.BufferGeometry();
    dropGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(DROPLETS * 3), 3));
    dropGeo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    this.dropletMaterial = new THREE.ShaderMaterial({
      uniforms: { ...this.u, uScale: { value: 1 } },
      vertexShader: /* glsl */ `
        ${AUDIO_UNIFORMS}
        ${COMMON}
        attribute vec4 aSeed;
        uniform float uScale;
        varying vec3 vColor;
        void main() {
          float theta = aSeed.x * 6.2831853 + uTime * (0.08 + aSeed.w * 0.12);
          float phi = acos(aSeed.y * 2.0 - 1.0);
          float band = texture2D(uSpectrum, vec2(0.1 + aSeed.w * 0.8, 0.5)).r;
          float r = 2.6 + aSeed.z * 2.6 + band * 0.6 + uBeat * 0.2;
          vec3 p = vec3(sin(phi) * cos(theta), cos(phi) * 0.65, sin(phi) * sin(theta)) * r;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = (1.0 + band * 3.0) * uScale * (8.0 / -mv.z);
          vColor = hue(0.5 + aSeed.w * 0.2 + uTime * 0.02, 0.6, 1.0) * (0.1 + band * 1.3);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          gl_FragColor = vec4(vColor * smoothstep(1.0, 0.0, d), 1.0);
        }
      `,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    const droplets = new THREE.Points(dropGeo, this.dropletMaterial);
    droplets.frustumCulled = false;
    this.scene.add(droplets);

    this.stars = createStars(1200, 120, this.u);
    this.scene.add(this.stars.points);
  }

  resize(width: number, height: number) {
    super.resize(width, height);
    this.dropletMaterial.uniforms.uScale.value = height / 900;
    this.stars.material.uniforms.uScale.value = height / 900;
    this.camera.fov = this.aspect < 1.4 ? 40 + (1.4 - this.aspect) * 45 : 40;
    this.camera.updateProjectionMatrix();
  }

  protected animate(frame: AudioFrame, dt: number, t: number) {
    this.orbit += dt * (0.08 + frame.level * 0.1);
    const distance = 8 - frame.beat * 0.2;
    this.camera.position.set(
      Math.sin(this.orbit) * distance,
      Math.sin(t * 0.13) * 1.6,
      Math.cos(this.orbit) * distance,
    );
    this.camera.lookAt(0, 0, 0);
  }
}
