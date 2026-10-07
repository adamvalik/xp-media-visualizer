import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the build works from any sub-path (GitHub Pages, Netlify, a USB stick...).
  base: './',
  // Spotify only accepts loopback redirect URIs as 127.0.0.1 (not "localhost"), so serve there.
  server: { host: '127.0.0.1' },
  preview: { host: '127.0.0.1' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
