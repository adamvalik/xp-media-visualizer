import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import type { AudioFrame } from '../../audio/analysis';
import { FULLSCREEN_VERT } from '../glsl';
import type { BloomSettings, Preset, PresetContext } from '../types';

/** Seconds without music changing presets when there is no tempo lock. */
const UNLOCKED_SECONDS = 24;

/**
 * A MilkDrop preset as a scene. "Shuffle" hops through the whole collection like Alchemy: on a bar
 * line after 8 or 16 bars, on a louder new section, and with a hard cut on a drop, holding its preset
 * through breakdowns. "Single" stays on the preset chosen in Media Library.
 */
export class MilkdropPreset implements Preset {
  // MilkDrop presets bring their own glow; bloom only lifts the brightest parts a little.
  readonly bloom: BloomSettings = { strength: 0.3, radius: 0.35, threshold: 0.7 };
  private readonly material: THREE.ShaderMaterial;
  private readonly quad: FullScreenQuad;
  private lastTime = -1;
  private bars = 0;
  private timer = 0;
  /** Single: the choice last sent to the engine. */
  private shown = -1;

  constructor(private readonly ctx: PresetContext, private readonly mode: 'shuffle' | 'single') {
    this.material = new THREE.ShaderMaterial({
      uniforms: { tMilkdrop: { value: null } },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tMilkdrop;
        varying vec2 vUv;
        void main() {
          // A little extra light makes up for the tone mapping, which flattens MilkDrop's colours.
          gl_FragColor = vec4(texture2D(tMilkdrop, vUv).rgb * 1.25, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  resize(width: number, height: number) {
    this.ctx.milkdrop.resize(width, height);
  }

  update(frame: AudioFrame, dt: number, time: number) {
    const md = this.ctx.milkdrop;
    // Scenes only get updates while they show, so a gap means this one just came on screen.
    const activated = this.lastTime < 0 || time - this.lastTime > 0.5;
    this.lastTime = time;
    // Both MilkDrop scenes share one engine; the one that came on screen last decides what it shows.
    // The incoming scene updates first, so the outgoing one of a crossfade can't take it back.
    if (activated && md.claimedAt !== time) {
      md.owner = this;
      md.claimedAt = time;
    }
    if (md.owner === this) {
      if (this.mode === 'single') {
        md.resolveChoice();
        if (md.choice >= 0 && (activated || md.choice !== this.shown)) {
          this.shown = md.choice;
          void md.show(md.choice, 1.5);
        }
      } else if (activated) {
        this.bars = 0;
        this.timer = 0;
        void md.shuffle(1.5);
      } else {
        this.followMusic(frame, dt);
      }
    }
    md.render(time);
  }

  private followMusic(frame: AudioFrame, dt: number) {
    const md = this.ctx.milkdrop;
    const { section, tempo } = frame;
    if (md.sectionFx) {
      if (section.drop) return this.next(0);
      if (section.lift && this.bars >= 4) return this.next(this.blendSeconds(frame));
      if (section.breakdown) return;
    }
    this.timer += dt;
    if (tempo.locked) {
      if (!tempo.downbeat) return;
      this.bars++;
      if ((this.bars >= 8 && Math.random() < 0.4) || this.bars >= 16) this.next(this.blendSeconds(frame));
    } else if (this.timer > UNLOCKED_SECONDS) {
      this.next(this.blendSeconds(frame));
    }
  }

  /** A bar long with a tempo lock, like a DJ's blend. */
  private blendSeconds(frame: AudioFrame) {
    return frame.tempo.locked ? Math.min(Math.max((60 / frame.tempo.bpm) * 4, 1), 4) : 2.5;
  }

  private next(blend: number) {
    this.bars = 0;
    this.timer = 0;
    void this.ctx.milkdrop.shuffle(blend);
  }

  render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget) {
    this.material.uniforms.tMilkdrop.value = this.ctx.milkdrop.texture;
    renderer.setRenderTarget(target);
    this.quad.render(renderer);
  }

  dispose() {
    this.material.dispose();
    this.quad.dispose();
  }
}
