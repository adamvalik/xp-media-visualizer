import * as THREE from 'three';
import { BANDS, WAVE_SIZE, type AudioFrame } from '../audio/analysis';

function byteTexture(width: number, height: number, data: Uint8Array, wrapRows = false) {
  const tex = new THREE.DataTexture(data, width, height, THREE.RedFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = wrapRows ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

const toByte = (v: number) => (v <= 0 ? 0 : v >= 1 ? 255 : (v * 255) | 0);

/** Live spectrum and waveform as 1-row GPU textures, shared by every preset. */
export class AudioTextures {
  private readonly specData = new Uint8Array(BANDS);
  private readonly waveData = new Uint8Array(WAVE_SIZE).fill(128);
  readonly spectrum = byteTexture(BANDS, 1, this.specData);
  readonly waveform = byteTexture(WAVE_SIZE, 1, this.waveData);

  update(frame: AudioFrame) {
    for (let i = 0; i < BANDS; i++) this.specData[i] = toByte(frame.spectrum[i]);
    for (let i = 0; i < WAVE_SIZE; i++) this.waveData[i] = toByte(frame.waveform[i] * 0.5 + 0.5);
    this.spectrum.needsUpdate = true;
    this.waveform.needsUpdate = true;
  }
}

/**
 * A ring buffer of past rows (spectrum or waveform snapshots) stored in a
 * texture. Rows are pushed at a fixed rate so scrolling speed does not
 * depend on the display refresh rate.
 */
export class HistoryTexture {
  readonly texture: THREE.DataTexture;
  readonly uniforms = {
    uHist: { value: null as THREE.Texture | null },
    uHistHead: { value: 0.5 },
    uHistRows: { value: 1 },
    uHistFrac: { value: 0 },
  };
  private readonly data: Uint8Array;
  private head = 0;
  private acc = 0;

  constructor(
    readonly width: number,
    readonly rows: number,
    readonly rate: number,
    private readonly signed = false,
  ) {
    this.data = new Uint8Array(width * rows).fill(signed ? 128 : 0);
    this.texture = byteTexture(width, rows, this.data, true);
    this.uniforms.uHist.value = this.texture;
    this.uniforms.uHistRows.value = rows;
  }

  update(source: Float32Array, dt: number) {
    this.acc += dt * this.rate;
    let pushes = 0;
    while (this.acc >= 1) {
      this.acc -= 1;
      if (pushes++ < 4) this.push(source);
    }
    this.uniforms.uHistHead.value = (this.head + 0.5) / this.rows;
    this.uniforms.uHistFrac.value = this.acc;
  }

  private push(source: Float32Array) {
    this.head = (this.head + 1) % this.rows;
    const row = this.head * this.width;
    const scale = (source.length - 1) / Math.max(1, this.width - 1);
    for (let x = 0; x < this.width; x++) {
      const p = x * scale;
      const i = Math.floor(p);
      const t = p - i;
      const v = source[i] * (1 - t) + (source[Math.min(i + 1, source.length - 1)] ?? 0) * t;
      this.data[row + x] = toByte(this.signed ? v * 0.5 + 0.5 : v);
    }
    this.texture.needsUpdate = true;
  }

  dispose() {
    this.texture.dispose();
  }
}
