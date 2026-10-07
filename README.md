# XP Media Visualizer

The Windows Media Player visualizer from the Windows XP era, rebuilt: the Luna window, the WMP 9 frame,
the feature taskbar, the playlist and the round transport buttons look and feel the same, but the
visualizations are modern real-time 3D scenes (three.js + WebGL 2 with bloom).

It listens to your **microphone**, a **browser tab** (e.g. the Spotify Web Player), **audio files**, or a
built-in **demo beat**. Audio is analysed locally in the browser; nothing is recorded or uploaded.

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:5173, then pick a source in the welcome dialog.

```bash
npm run build     # static site in dist/
npm run preview   # serve the production build locally
```

## Listening to Spotify

1. **Microphone (easiest):** play Spotify out loud, choose *Microphone*. If the visuals stay small, raise
   *Sensitivity* in **Radio Tuner**. Echo cancellation, noise suppression and auto gain are switched off so
   the music is not filtered away.
2. **Browser tab audio (best quality, Chrome or Edge):** open open.spotify.com in another tab, start a song,
   choose *Browser tab audio*, pick that tab and switch on *Share tab audio*. You keep hearing it normally.
3. **Spotify desktop app without a mic:** install a loopback driver such as [BlackHole](https://github.com/ExistentialAudio/BlackHole),
   route Spotify through it (a macOS Multi-Output Device keeps your speakers working) and select it as the
   input device in **Radio Tuner**.

## Visualizations

| Collection | Name | What it does |
| --- | --- | --- |
| Alchemy | Random | Hops between all the others, switching on the beat |
| Ambience | Swirl | 70k-particle spiral galaxy; bass in the core, treble on the rim |
| Ambience | Water | Iridescent liquid orb that swells, ripples and shimmers |
| Bars and Waves | Bars | 3D spectrum bars with falling peaks and history scrolling into the distance |
| Bars and Waves | Ocean Mist | Glowing spectrogram sea rolling toward a misty horizon |
| Bars and Waves | Scope | The oscilloscope as a tunnel of waveform rings |
| Battery | event horizon | Video-feedback warp pouring out of a pulsing waveform ring |
| Battery | chemical star | Kaleidoscopic star collapsing inward on every beat |
| Battery | hyperspace | Flight through a tunnel built from spectrum rings |

## Controls

| Key | Action |
| --- | --- |
| Space / K | Play, pause |
| S | Stop (releases the microphone) |
| Left / Right | Previous / next visualization |
| 1 to 9 | Pick from the playlist |
| R | Shuffle visualizations (Alchemy) |
| F or double-click | Full screen |
| M | Mute |
| Up / Down | Volume (files and demo) |
| Ctrl+O | Open audio files (or drag them onto the window) |

The window can be dragged, resized, minimized to the taskbar and maximized. **Skin Chooser** switches between
Blue, Olive Green, Silver and Royale Noir. Settings are remembered per browser.

## Use it as an app

It is an installable PWA that also works offline after the first load:

- **Chrome / Edge:** *Tools > Install as App* in the player, or the install icon in the address bar.
- **Safari (macOS):** *File > Add to Dock*.

## Share it

`npm run build` produces a fully static site in `dist/` with relative paths, so it can be hosted anywhere
(GitHub Pages, Netlify, Vercel, any static server). Microphone and tab capture require **HTTPS** (or
`localhost`).

## How it works

```
src/
  audio/
    AudioEngine.ts   sources (mic, tab capture, files, demo) feeding one AnalyserNode
    analysis.ts      128 log bands, auto gain, falling peaks, beat detection, aligned waveform
    DemoSynth.ts     small Web Audio groove for trying it without a mic
  viz/
    Visualizer.ts    render loop, crossfades, bloom + finishing pass, Alchemy mode, adaptive resolution
    AudioTextures.ts spectrum/waveform as GPU textures, plus scrolling history textures
    presets/         one file per scene (bars, ocean, scope, swirl, water, feedback, tunnel)
  ui/                XP window manager, menus, balloons, dialogs, playlist, transport, skins
  styles/xp.css      Luna chrome and the WMP 9 frame, four skins
```

The analysis is normalised against the loudest recent band, so the visuals react the same whether the
signal is a quiet laptop mic or a full-scale tab capture. Each scene reads the spectrum and waveform from
small textures; the Bars, Ocean, Scope and hyperspace scenes also keep a ring buffer of past frames in a
texture, which is how the history scrolls smoothly at any refresh rate.

## Notes

Fan project, not affiliated with or endorsed by Microsoft. Windows and Windows Media are trademarks of
Microsoft Corporation. The look is recreated in CSS; no original artwork is used.
