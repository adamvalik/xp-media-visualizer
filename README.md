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

Open http://127.0.0.1:5173, then pick a source in the welcome dialog. (The dev server binds to 127.0.0.1
because Spotify does not accept `localhost` redirect addresses.)

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

## Song info from Spotify

Optionally connect your Spotify account (read-only) to show the title, artist and album art of whatever is
playing, with a WMP-style overlay on every song change and the visuals tinted by the album colors. It is shown
while the visualizer listens to the microphone or a tab; the sound itself still comes from that source.

One-time setup (Radio Tuner > *Spotify: song info*, or *File > Connect to Spotify...*):

1. Create an app at https://developer.spotify.com/dashboard (select *Web API*).
2. Add the Redirect URI shown in the player: `http://127.0.0.1:5173/` locally, and your deployed address,
   e.g. `https://your-app.vercel.app/`, once hosted.
3. Paste the app's Client ID into the player and click *Connect*. To skip the paste on a deployment, set
   `VITE_SPOTIFY_CLIENT_ID` as a build environment variable.

Login uses the Authorization Code flow with PKCE, entirely in the browser; there is no server and no client
secret. Apps in Spotify's development mode only work for accounts you add under *User Management* in the
dashboard.

## Tempo sync

A beat tracker estimates the tempo (70 to 180 BPM) and where the beats fall, usually within a few seconds of
music starting. Once it is confident, every scene's beat pulse follows that steady grid instead of single
kicks, so accents keep landing in time through breaks and fills. Alchemy changes scenes on a bar line after 8
or 16 bars with a crossfade two beats long, and the Battery scenes shift color on each bar. The display shows
the detected BPM with a dot that pulses on every beat (yellow on the first beat of the bar). With no clear beat
(ambient music, speech) everything falls back to reacting to the sound directly.

## Drops and song sections

The player also listens for the shape of the song. When the bass drops out for a few seconds (a breakdown),
the picture tightens: the vignette closes in, the image slowly pushes in and the colors fringe more as risers
and snare rolls build up. When the bass slams back in, the drop gets a flash, a zoom punch and extra glow, and
Alchemy cuts straight to a new scene; it holds its scene through the breakdown to save the change for that
moment. A clearly louder new section (a chorus kicking in) gets a smaller kick and is where Alchemy changes
scene. The display shows **BUILD** during a breakdown and **DROP** when one lands.

Detection is deliberately cautious and needs about 12 seconds of music to learn what "full" sounds like. It
works best with electronic and pop music. If it misfires on your music, switch it off with
*View > React to Drops* (or **D**); the choice is remembered. The demo beat has a breakdown and drop after 16
bars to show it off.

## Record a clip

Press **V** (or the red dot next to full screen) to record the visualization with its sound; press it again or
click the REC badge to stop early. When it's done, a dialog shows the clip with a *Save Clip* button.
*Tools > Record Clip...* sets the format (wide 1920 × 1080, square 1080 × 1080 or tall 1080 × 1920 for stories),
the length (10 to 60 seconds), whether the song title appears in the lower left, and whether the sound is
included. Clips are MP4 in Chrome, Edge and Safari and WebM in Firefox.

The clip is made from the visualization on screen, cropped to fill the format, so full screen gives the
sharpest picture. The sound is what the visualizer hears, before the volume slider: a clean recording for
files, the demo and tab audio, but the room sound for the microphone.

## Visualizations

| Collection | Name | What it does |
| --- | --- | --- |
| Alchemy | Random | Hops between all the others, switching on bar lines |
| Alchemy | Mix | Two scenes layered at once; blend modes and layers change every few bars |
| Ambience | Bubbles | Iridescent soap bubbles rising through dark water, each swelling with its own band |
| Ambience | Swirl | 70k-particle spiral galaxy; bass in the core, treble on the rim |
| Ambience | Water | Iridescent liquid orb that swells, ripples and shimmers |
| Bars and Waves | Bars | 3D spectrum bars with falling peaks and history scrolling into the distance |
| Bars and Waves | Fire Storm | Flat bars that burn, with flames and smoke rising off the tops |
| Bars and Waves | Ocean Mist | Glowing spectrogram sea rolling toward a misty horizon |
| Bars and Waves | Scope | The oscilloscope as a tunnel of waveform rings |
| Battery | chemical star | Kaleidoscopic star collapsing inward on every beat |
| Battery | event horizon | Video-feedback warp pouring out of a pulsing waveform ring |
| Battery | hyperspace | Flight through a tunnel built from spectrum rings |
| Battery | spiderbite | A trembling spider web of light; every strand is a frequency band |

### Classic Mode

*View > Classic Mode* (or **C**) brings back the 2003 look: the picture is rendered at about 340 lines and
scaled up with hard pixels, bloom and lens effects are off, colors are reduced to 16-bit with ordered
dithering, and Bars, Ocean Mist and Scope switch to faithful flat 2D versions of the originals.

### Skin mode

*View > Skin Mode* (**Ctrl+2**, or the small button next to full screen) shrinks the player into a compact,
oddly shaped skin like WMP's: the visualization in a round window, transport and display on a deck beside it,
and visualization buttons set into the rim. Drag it by any part that isn't a button; double-click the
visualization for full screen. **Ctrl+1** or the window button on the skin returns to full mode. The skin
follows the color scheme picked in **Skin Chooser**, and the mode is remembered.

### Pop-out player

In Chrome and Edge, the pop-out button on the skin (or *View > Pop Out Player*, **Ctrl+3**) moves the skin into
a small Picture-in-Picture window that stays on top of other apps, so the visualization keeps going next to
whatever you work on. It is a plain rectangle with the browser's own frame rather than the skin's shape, and
you can resize it; double-click the visualization (or the full screen button) to let it fill the window.
Closing that window, the close button on the skin or the player's button in the page's taskbar puts the
player back in the page. The audio is still captured by the page, so keep its tab open.

### Screen saver

When the mouse and keyboard have been idle for a few minutes while music is playing, the player switches to
Alchemy and fills the window, like a screen saver. Moving the mouse or pressing a key brings back the previous
visualization and view; that input is swallowed, so a click doesn't also press a button. Set it up (or switch
it off) under *Tools > Screen Saver...*, which also has a Preview. Browsers only allow real full screen right
after a click, so it fills the browser window; put the browser in full screen or install the app to cover the
whole screen.

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
| I | Keep the song title visible in full screen (also *View > Show Song in Full Screen*) |
| C | Classic Mode |
| D | React to drops and new sections |
| V | Record a clip / stop recording |
| Up / Down | Volume (files and demo) |
| Ctrl+O | Open audio files (or drag them onto the window) |
| Ctrl+1 / Ctrl+2 | Full mode / skin mode |
| Ctrl+3 | Pop out the player into a window that stays on top (Chrome and Edge) |

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
    tempo.ts         BPM via autocorrelation, beat phase locked to kicks, bar/downbeat tracking
    sections.ts      breakdowns, build-ups, drops and louder sections
    DemoSynth.ts     small Web Audio groove for trying it without a mic
  viz/
    Visualizer.ts    render loop, crossfades, bloom + finishing pass, Alchemy mode, adaptive resolution
    AudioTextures.ts spectrum/waveform as GPU textures, plus scrolling history textures
    presets/         one file per scene; flat.ts holds the 2D classics, mix.ts the Alchemy layering
  spotify/           PKCE login, now-playing polling, album art color extraction
  ui/                XP window manager, menus, balloons, dialogs, playlist, transport, skins
  styles/xp.css      Luna chrome and the WMP 9 frame, four skins
```

The analysis is normalised against the loudest recent band, so the visuals react the same whether the
signal is a quiet laptop mic or a full-scale tab capture. Each scene reads the spectrum and waveform from
small textures; the Bars, Ocean, Scope and hyperspace scenes also keep a ring buffer of past frames in a
texture, which is how the history scrolls smoothly at any refresh rate.

More ideas for the future are in [IDEAS.md](IDEAS.md).

## Notes

Fan project, not affiliated with or endorsed by Microsoft. Windows and Windows Media are trademarks of
Microsoft Corporation. The look is recreated in CSS; no original artwork is used.
