import type { PresetDef } from '../types';
import { BarsPreset } from './bars';
import { FeedbackPreset } from './feedback';
import { OceanPreset } from './ocean';
import { ScopePreset } from './scope';
import { SwirlPreset } from './swirl';
import { TunnelPreset } from './tunnel';
import { WaterPreset } from './water';

/** Pseudo preset that hops between all the others, like WMP's "Alchemy". */
export const RANDOM_ID = 'alchemy-random';

export const RANDOM_DEF = {
  id: RANDOM_ID,
  group: 'Alchemy',
  name: 'Random',
  description: 'Mixes every visualization below, switching on the beat.',
};

export const PRESETS: PresetDef[] = [
  {
    id: 'ambience-swirl',
    group: 'Ambience',
    name: 'Swirl',
    description: '70,000 particles in a spiral galaxy. Bass in the core, treble on the rim.',
    create: (ctx) => new SwirlPreset(ctx),
  },
  {
    id: 'ambience-water',
    group: 'Ambience',
    name: 'Water',
    description: 'An iridescent liquid orb that swells, ripples and shimmers.',
    create: (ctx) => new WaterPreset(ctx),
  },
  {
    id: 'bars-bars',
    group: 'Bars and Waves',
    name: 'Bars',
    description: 'The classic spectrum bars in 3D, with history scrolling into the distance.',
    create: (ctx) => new BarsPreset(ctx),
  },
  {
    id: 'bars-ocean-mist',
    group: 'Bars and Waves',
    name: 'Ocean Mist',
    description: 'A glowing spectrogram sea rolling towards a misty horizon.',
    create: (ctx) => new OceanPreset(ctx),
  },
  {
    id: 'bars-scope',
    group: 'Bars and Waves',
    name: 'Scope',
    description: 'The oscilloscope as a tunnel of waveform rings.',
    create: (ctx) => new ScopePreset(ctx),
  },
  {
    id: 'battery-event-horizon',
    group: 'Battery',
    name: 'event horizon',
    description: 'Video feedback pouring out of a pulsing waveform ring.',
    create: (ctx) => new FeedbackPreset(ctx, { mode: 0, kaleido: 0, bloom: { strength: 0.35, radius: 0.35, threshold: 0.55 } }),
  },
  {
    id: 'battery-chemical-star',
    group: 'Battery',
    name: 'chemical star',
    description: 'A kaleidoscopic star collapsing inward on every beat.',
    create: (ctx) => new FeedbackPreset(ctx, { mode: 1, kaleido: 6, bloom: { strength: 0.35, radius: 0.35, threshold: 0.55 } }),
  },
  {
    id: 'battery-hyperspace',
    group: 'Battery',
    name: 'hyperspace',
    description: 'Fly through a tunnel made of spectrum rings.',
    create: (ctx) => new TunnelPreset(ctx),
  },
];

export const presetLabel = (def: { group: string; name: string }) => `${def.group} : ${def.name}`;
