# Ideas

## To do

Roughly in order of impact.

1. **Native app (Tauri) with a floating mini player.** Capture system audio directly (ScreenCaptureKit or
   Core Audio taps on macOS), so the Spotify desktop app works without a microphone or a loopback driver. The
   same app can show skin mode as a transparent, borderless, always-on-top window that lives on the desktop
   while you work, with clicks on its transparent corners passing through to the window underneath.
2. **Pop-out mini player in the browser.** Until the native app exists: a *Pop Out* button on the skin that
   moves it into a Document Picture-in-Picture window (Chrome and Edge), which stays on top of other apps. It
   is a rectangle with a title bar rather than the real shape, but it takes about a day and reuses skin mode.
3. **MilkDrop presets.** Add [Butterchurn](https://github.com/jberg/butterchurn), the WebGL port of MilkDrop, as
   a third collection next to the built-in scenes: thousands of community presets and the other half of the
   2000s visualizer nostalgia. Feed it the existing analysis and let Alchemy, drops and Classic Mode work with it.
4. **Colors that follow the harmony.** Build a chromagram (energy per pitch class) from the spectrum to follow
   chord changes and guess major or minor. Chord changes shift the hue on the bar line; minor passages lean
   cool, major ones warm. It complements the album-art tint, which only knows the cover.
5. **Album art kaleidoscope.** A Battery-style scene that folds the current Spotify cover (or a dropped image)
   into a kaleidoscope, rotating with the beat and shattering on drops. The cover already loads for the color
   tint, so the scene mostly needs a shader.
6. **Reduce flashing.** A setting (on by default when the system asks for reduced motion) that caps the drop
   flash, chromatic aberration and fast brightness changes for people sensitive to flicker. It matters more
   now that drops flash the whole screen.
7. **System media controls.** Report the current file or Spotify song to the operating system through the
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
- **Record a clip:** the visualization with its sound as an MP4 in wide, square or tall format. **V** or
  *Tools > Record Clip...*
