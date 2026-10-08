# Ideas

## To do

Roughly in order of impact.

1. **Native app (Tauri) with a floating mini player.** Capture system audio directly (ScreenCaptureKit or
   Core Audio taps on macOS), so the Spotify desktop app works without a microphone or a loopback driver. The
   same app can show skin mode as a transparent, borderless, always-on-top window that lives on the desktop
   while you work, with clicks on its transparent corners passing through to the window underneath.
2. **MilkDrop presets.** Add [Butterchurn](https://github.com/jberg/butterchurn), the WebGL port of MilkDrop, as
   a third collection next to the built-in scenes: thousands of community presets and the other half of the
   2000s visualizer nostalgia. Feed it the existing analysis and let Alchemy, drops and Classic Mode work with it.
3. **Colors that follow the harmony.** Build a chromagram (energy per pitch class) from the spectrum to follow
   chord changes and guess major or minor. Chord changes shift the hue on the bar line; minor passages lean
   cool, major ones warm. It complements the album-art tint, which only knows the cover.
4. **Reduce flashing.** A setting (on by default when the system asks for reduced motion) that caps the drop
   flash, chromatic aberration and fast brightness changes for people sensitive to flicker. It matters more
   now that drops flash the whole screen.
5. **System media controls.** Report the current file or Spotify song to the operating system through the
   Media Session API, so the media keys, the lock screen and the Control Center show it and can play, pause and
   skip files.

## Done

- **Song info from Spotify:** title, artist and album art in a WMP-style overlay, with the scenes tinted by the
  album colors. See *Spotify: song info* in Radio Tuner.
- **Tempo detection:** BPM and beat phase, so camera moves, color shifts and Alchemy switches land on the beat
  grid. See `src/audio/tempo.ts`; the BPM shows in the player's display.
- **Song-section detection:** breakdowns, build-ups, drops and louder sections trigger tension, a flash and
  zoom punch, and Alchemy scene changes. See `src/audio/sections.ts` and *View > React to Drops* (D).
- **More scenes from the originals:** spiderbite, Bubbles, Fire Storm, Alchemy : Mix, and *View > Classic Mode*
  (C) for the flat 2D look of 2003.
- **Skin mode:** the compact, oddly shaped mini player. *View > Skin Mode* (Ctrl+2).
- **Screen saver:** Alchemy fills the window after a few idle minutes while music plays. *Tools > Screen
  Saver...*
- **Pop-out player:** skin mode in a Document Picture-in-Picture window that stays on top of other apps
  (Chrome and Edge). *View > Pop Out Player* (Ctrl+3).
- **Record a clip:** the visualization with its sound as an MP4 in wide, square or tall format. **V** or
  *Tools > Record Clip...*
