# Ideas

Possible next steps, roughly in order of impact.

## Make the music feel more "seen"

1. **Song info from Spotify.** ~~Show the real track title and artist like WMP's "Now Playing" overlay, and tint
   the scenes with the album art colors.~~ Done: see *Spotify: song info* in Radio Tuner.
2. **Tempo detection.** ~~Estimate BPM and beat phase so camera moves, color shifts and Alchemy switches land on
   the actual beat grid instead of reacting to single onsets.~~ Done: see `src/audio/tempo.ts`; the BPM shows
   in the player's display.
3. **Song-section detection.** Track energy over longer windows to recognise build-ups and drops, then trigger
   bigger moments: a camera dive, a color flash, or a scene change exactly on the drop.

## More of the XP soul

4. **More scenes from the originals:** ~~Battery "spiderbite", Ambience "Bubbles", Alchemy-style mixes that combine
   parts of different scenes, and a faithful 2D "classic mode" toggle for pure nostalgia.~~ Done: spiderbite,
   Bubbles, Fire Storm, Alchemy : Mix, and *View > Classic Mode*.
5. **Equalizer and enhancements panel** from WMP 9, with working sliders that shape what the visuals react to
   (more bass, less treble).
6. **Compact "skin mode":** the famous oddly shaped mini player as a small window.
7. **Screensaver mode:** start Alchemy in full screen after a few idle minutes.

## Practical

8. **Per-scene settings** (speed, palette, intensity) and favorite presets saved to the playlist.
9. **Record a clip** of the visuals together with the audio as a video file for sharing.
10. **Native Mac app (Tauri)** that captures system audio directly, so the Spotify desktop app works without a
    microphone or a loopback driver.
