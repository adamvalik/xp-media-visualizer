import type { SourceKind } from '../audio/AudioEngine';

export type SkinId = 'blue' | 'olive' | 'silver' | 'noir';

export interface SkinDef {
  id: SkinId;
  name: string;
  /** title, frame, taskbar, stage, playlist, transport */
  preview: [string, string, string, string, string, string];
}

export const SKINS: SkinDef[] = [
  { id: 'blue', name: 'Windows XP (Blue)', preview: ['#0058ee', '#3a66d0', '#1d4096', '#000', '#0d2263', '#c6d7f5'] },
  { id: 'olive', name: 'Olive Green', preview: ['#8fa65c', '#869e57', '#4f6530', '#000', '#33441d', '#dce6c2'] },
  { id: 'silver', name: 'Silver', preview: ['#c9c9d8', '#c9c9d8', '#84849e', '#000', '#3c3c50', '#e6e6ef'] },
  { id: 'noir', name: 'Royale Noir', preview: ['#161616', '#161616', '#0d0d0d', '#000', '#0b0b0b', '#1d1d1d'] },
];

export interface Settings {
  preset: string;
  skin: SkinId;
  volume: number;
  muted: boolean;
  sensitivity: number;
  source: SourceKind;
  micDeviceId: string;
  showPlaylist: boolean;
  showTaskbar: boolean;
  maximized: boolean | null;
  albumTint: boolean;
  /** Keep the song title on screen in full screen instead of only on song changes. */
  fullscreenTrack: boolean;
  /** Low-res, 16-bit, flat 2D rendering like the original visualizations. */
  classicMode: boolean;
}

const KEY = 'xp-media-visualizer.settings.v1';

const DEFAULTS: Settings = {
  preset: 'bars-bars',
  skin: 'blue',
  volume: 0.8,
  muted: false,
  sensitivity: 0,
  source: 'mic',
  micDeviceId: '',
  showPlaylist: true,
  showTaskbar: true,
  maximized: null,
  albumTint: true,
  fullscreenTrack: true,
  classicMode: false,
};

export function loadSettings(): Settings {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
    const merged = { ...DEFAULTS, ...stored };
    if (!SKINS.some((s) => s.id === merged.skin)) merged.skin = DEFAULTS.skin;
    return merged;
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Storage can be unavailable (private mode, blocked site data); settings just won't persist.
  }
}
