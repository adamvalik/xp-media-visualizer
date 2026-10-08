import type { PresetDef } from '../types';
import { BarsPreset } from './bars';
import { BubblesPreset } from './bubbles';
import { FeedbackPreset } from './feedback';
import { ClassicBarsPreset, ClassicScopePreset } from './flat';
import { MilkdropPreset } from './milkdrop';
import { MixPreset } from './mix';
import { OceanPreset } from './ocean';
import { ScopePreset } from './scope';
import { SwirlPreset } from './swirl';
import { TunnelPreset } from './tunnel';
import { WaterPreset } from './water';

/** Pseudo preset that hops between all the others, like WMP's "Alchemy". */
export const RANDOM_ID = 'alchemy-random';

export const MILKDROP_SHUFFLE_ID = 'milkdrop-shuffle';
export const MILKDROP_SINGLE_ID = 'milkdrop-single';

export const RANDOM_DEF = {
  id: RANDOM_ID,
  group: 'Alchemy',
  name: 'Random',
  description: 'Mixes every visualization below, switching on the beat.',
};

// Alphabetical within each collection, like the original menus.
export const PRESETS: PresetDef[] = [
  {
    id: 'alchemy-mix',
    group: 'Alchemy',
    name: 'Mix',
    description: 'Two visualizations layered at once, blended in ways that change on the bar.',
    create: (ctx) => new MixPreset(ctx, () => PRESETS),
  },
  {
    id: 'ambience-bubbles',
    group: 'Ambience',
    name: 'Bubbles',
    description: 'Soap bubbles rising through dark water, each one swelling with its own band.',
    create: (ctx) => new BubblesPreset(ctx),
  },
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
    classic: (ctx) => new ClassicBarsPreset(ctx, 'bars'),
  },
  {
    id: 'bars-fire-storm',
    group: 'Bars and Waves',
    name: 'Fire Storm',
    description: 'Flat spectrum bars that burn, with flames and smoke rising off the tops.',
    create: (ctx) => new ClassicBarsPreset(ctx, 'fire'),
  },
  {
    id: 'bars-ocean-mist',
    group: 'Bars and Waves',
    name: 'Ocean Mist',
    description: 'A glowing spectrogram sea rolling towards a misty horizon.',
    create: (ctx) => new OceanPreset(ctx),
    classic: (ctx) => new ClassicBarsPreset(ctx, 'ocean'),
  },
  {
    id: 'bars-scope',
    group: 'Bars and Waves',
    name: 'Scope',
    description: 'The oscilloscope as a tunnel of waveform rings.',
    create: (ctx) => new ScopePreset(ctx),
    classic: (ctx) => new ClassicScopePreset(ctx),
  },
  {
    id: 'battery-chemical-star',
    group: 'Battery',
    name: 'chemical star',
    description: 'A kaleidoscopic star collapsing inward on every beat.',
    create: (ctx) => new FeedbackPreset(ctx, { mode: 1, kaleido: 6, bloom: { strength: 0.35, radius: 0.35, threshold: 0.55 } }),
  },
  {
    id: 'battery-event-horizon',
    group: 'Battery',
    name: 'event horizon',
    description: 'Video feedback pouring out of a pulsing waveform ring.',
    create: (ctx) => new FeedbackPreset(ctx, { mode: 0, kaleido: 0, bloom: { strength: 0.35, radius: 0.35, threshold: 0.55 } }),
  },
  {
    id: 'battery-hyperspace',
    group: 'Battery',
    name: 'hyperspace',
    description: 'Fly through a tunnel made of spectrum rings.',
    create: (ctx) => new TunnelPreset(ctx),
  },
  {
    id: 'battery-spiderbite',
    group: 'Battery',
    name: 'spiderbite',
    description: 'A trembling spider web of light; every strand is a frequency band.',
    create: (ctx) => new FeedbackPreset(ctx, { mode: 2, kaleido: 0, bloom: { strength: 0.4, radius: 0.35, threshold: 0.5 } }),
  },
  {
    id: MILKDROP_SHUFFLE_ID,
    group: 'MilkDrop',
    name: 'Shuffle',
    description: 'Hops through nearly 400 hand-picked presets from the Winamp classic, changing on the bar and cutting on drops.',
    create: (ctx) => new MilkdropPreset(ctx, 'shuffle'),
  },
  {
    id: MILKDROP_SINGLE_ID,
    group: 'MilkDrop',
    name: 'Single Preset',
    description: 'Stays on one MilkDrop preset. Pick it from the list in Media Library.',
    create: (ctx) => new MilkdropPreset(ctx, 'single'),
  },
];

export const presetLabel = (def: { group: string; name: string }) => `${def.group} : ${def.name}`;
