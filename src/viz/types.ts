import type * as THREE from 'three';
import type { AudioFrame } from '../audio/analysis';
import type { AudioTextures } from './AudioTextures';
import type { Milkdrop } from './Milkdrop';

export interface BloomSettings {
  strength: number;
  radius: number;
  threshold: number;
}

export interface PresetContext {
  renderer: THREE.WebGLRenderer;
  textures: AudioTextures;
  milkdrop: Milkdrop;
}

export interface Preset {
  readonly bloom: BloomSettings;
  /** Size of the render target in device pixels. */
  resize(width: number, height: number): void;
  update(frame: AudioFrame, dt: number, time: number): void;
  render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget): void;
  dispose(): void;
}

export interface PresetDef {
  id: string;
  group: string;
  name: string;
  description: string;
  create(ctx: PresetContext): Preset;
  /** Faithful flat 2D version used in Classic Mode, when the scene has one. */
  classic?(ctx: PresetContext): Preset;
}
