import * as THREE from 'three';
import { BANDS, type AudioFrame } from '../../audio/analysis';
import { HistoryTexture } from '../AudioTextures';
import { AUDIO_UNIFORMS, COMMON, HISTORY } from '../glsl';
import { ScenePreset, createGlow } from '../helpers';
import type { PresetContext } from '../types';

const COLS = 64;
const ROWS = 34;
const SPACING = 0.22;
const BAR_W = 0.17;
const DEPTH = 0.42;
const MAX_H = 4.2;

/**
 * "Bars and Waves : Bars", in 3D: the live spectrum stands at the front and
 * every past frame scrolls back into the dark like a city of light, with
 * falling peak caps and a glossy floor reflection.
 */
export class BarsPreset extends ScenePreset {
  readonly bloom = { strength: 0.65, radius: 0.45, threshold: 0.3 };
  private readonly history = this.own(new HistoryTexture(BANDS, ROWS + 4, 22));
  private readonly caps: THREE.InstancedMesh;
  private readonly glow;
  private readonly matrix = new THREE.Matrix4();
  private readonly lookAt = new THREE.Vector3(0, 1.3, -3.5);

  constructor(ctx: PresetContext) {
    super(ctx, 46, 0.1, 200);
    this.scene.background = new THREE.Color(0x010208);

    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setIndex(box.getIndex());
    geometry.setAttribute('position', box.getAttribute('position'));
    geometry.setAttribute('normal', box.getAttribute('normal'));
    const cells = new Float32Array(COLS * ROWS * 2);
    for (let r = 0, i = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++, i += 2) {
        cells[i] = c;
        cells[i + 1] = r;
      }
    }
    geometry.setAttribute('aCell', new THREE.InstancedBufferAttribute(cells, 2));
    geometry.instanceCount = COLS * ROWS;

    const makeMaterial = (mirror: boolean) =>
      new THREE.ShaderMaterial({
        uniforms: { ...this.u, ...this.history.uniforms, uMirror: { value: mirror ? -1 : 1 } },
        vertexShader: /* glsl */ `
          ${AUDIO_UNIFORMS}
          ${HISTORY}
          attribute vec2 aCell;
          uniform float uMirror;
          varying float vLevel;
          varying float vAge;
          varying float vFront;
          varying float vY;
          varying float vX;
          varying vec3 vN;
          void main() {
            float x = (aCell.x + 0.5) / ${COLS.toFixed(1)};
            float row = aCell.y;
            bool front = row < 0.5;
            float v = front ? texture2D(uSpectrum, vec2(x, 0.5)).r : histRow(x, row - 1.0);
            float h = max(pow(v, 1.35) * ${MAX_H.toFixed(2)}, 0.035);
            float rowPos = front ? 0.0 : row + uHistFrac;
            vec3 p = position;
            p.x = p.x * ${BAR_W.toFixed(3)} + (aCell.x - ${((COLS - 1) / 2).toFixed(1)}) * ${SPACING.toFixed(3)};
            p.z = p.z * ${BAR_W.toFixed(3)} * (front ? 1.0 : 0.8) - rowPos * ${DEPTH.toFixed(3)};
            p.y *= h * uMirror;
            vLevel = v;
            vAge = rowPos / ${ROWS.toFixed(1)};
            vFront = front ? 1.0 : 0.0;
            vY = position.y;
            vX = x;
            vN = normal;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          ${COMMON}
          uniform float uTime;
          uniform float uMirror;
          varying float vLevel;
          varying float vAge;
          varying float vFront;
          varying float vY;
          varying float vX;
          varying vec3 vN;
          void main() {
            // Bass is deep blue, highs drift through cyan and green to warm.
            vec3 base = hue(0.63 - vX * 0.52 + sin(uTime * 0.05) * 0.04 - vAge * 0.12, 0.85, 1.0);
            float shade = vN.y > 0.5 ? 1.3 : (abs(vN.x) > 0.5 ? 0.55 : 0.85);
            float glow = mix(0.12, 1.0, vY * vY) * (0.1 + 1.5 * vLevel * vLevel);
            float fade = pow(1.0 - clamp(vAge, 0.0, 1.0), 1.7);
            vec3 col = base * shade * glow * fade;
            col += vec3(0.6, 0.85, 1.0) * smoothstep(0.93, 1.0, vY) * vLevel * 1.4 * vFront;
            if (uMirror < 0.0) col *= 0.18 * (1.0 - vY);
            gl_FragColor = vec4(col, 1.0);
          }
        `,
        ...(mirror ? { blending: THREE.AdditiveBlending, transparent: true, depthWrite: false } : {}),
      });

    const bars = new THREE.Mesh(geometry, makeMaterial(false));
    bars.frustumCulled = false;
    const reflection = new THREE.Mesh(geometry, makeMaterial(true));
    reflection.frustumCulled = false;
    reflection.renderOrder = 1;
    this.scene.add(bars, reflection);

    // A dark, slightly transparent floor with a faint grid that sits over the reflection.
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(60, 60).rotateX(-Math.PI / 2),
      new THREE.ShaderMaterial({
        uniforms: { uBass: this.u.uBass },
        vertexShader: /* glsl */ `
          varying vec3 vPos;
          void main() {
            vPos = (modelMatrix * vec4(position, 1.0)).xyz;
            gl_Position = projectionMatrix * viewMatrix * vec4(vPos, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform float uBass;
          varying vec3 vPos;
          void main() {
            vec2 g = vec2(vPos.x / ${SPACING.toFixed(3)} + 0.5, vPos.z / ${DEPTH.toFixed(3)});
            vec2 gd = abs(fract(g - 0.5) - 0.5) / fwidth(g);
            float line = 1.0 - min(min(gd.x, gd.y), 1.0);
            float fade = exp(-length(vPos.xz - vec2(0.0, -3.0)) * 0.13);
            vec3 col = vec3(0.015, 0.04, 0.12) * line * fade * (1.0 + uBass * 2.5);
            gl_FragColor = vec4(col, 0.74);
          }
        `,
        transparent: true,
        depthWrite: false,
      }),
    );
    floor.position.y = -0.001;
    floor.renderOrder = 2;
    this.scene.add(floor);

    this.caps = new THREE.InstancedMesh(
      new THREE.BoxGeometry(BAR_W, 0.045, BAR_W),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0.75, 0.9, 1).multiplyScalar(1.4) }),
      COLS,
    );
    this.caps.frustumCulled = false;
    this.scene.add(this.caps);

    this.glow = createGlow(0x2a4dff, 34);
    this.glow.mesh.position.set(0, 2, -24);
    this.scene.add(this.glow.mesh);
  }

  resize(width: number, height: number) {
    super.resize(width, height);
    // Keep the whole row of bars in view on narrow screens.
    this.camera.fov = this.aspect < 1.4 ? 46 + (1.4 - this.aspect) * 22 : 46;
    this.camera.updateProjectionMatrix();
  }

  protected animate(frame: AudioFrame, dt: number, t: number) {
    this.history.update(frame.spectrum, dt);

    for (let c = 0; c < COLS; c++) {
      const peak = Math.max(frame.peaks[c * 2], frame.peaks[c * 2 + 1]);
      const y = Math.pow(peak, 1.35) * MAX_H + 0.06;
      this.matrix.makeTranslation((c - (COLS - 1) / 2) * SPACING, y, 0);
      this.caps.setMatrixAt(c, this.matrix);
    }
    this.caps.instanceMatrix.needsUpdate = true;

    this.glow.material.uniforms.uIntensity.value = 0.05 + frame.bass * 0.15 + frame.beat * 0.08;

    const cam = this.camera;
    cam.position.set(
      Math.sin(t * 0.13) * 3.4,
      2.7 + Math.sin(t * 0.09) * 0.7 + frame.beat * 0.06,
      10.5 + Math.cos(t * 0.11) * 1.2,
    );
    cam.lookAt(this.lookAt);
  }
}
