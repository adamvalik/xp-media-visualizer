import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const MILKDROP_DIR = 'node_modules/butterchurn-presets/presets/converted';
/** Butterchurn's own preset packs: the presets its author picked as working well in it. */
const MILKDROP_PACKS = ['butterchurnPresets', 'butterchurnPresetsExtra', 'butterchurnPresetsExtra2', 'butterchurnPresetsMD1'];

/**
 * Serves the MilkDrop presets as `milkdrop/<n>.json`, one small file each, plus `milkdrop/index.json`
 * with their names in the same order and which of them Shuffle uses (the ones in Butterchurn's packs;
 * the full collection has presets that don't render well in it). The player fetches a preset only
 * when it shows it, so the 12 MB collection never weighs on the page load. Numbered files keep the
 * odd characters in preset names out of URLs.
 */
function milkdropPresets(): Plugin {
  const files = () => readdirSync(MILKDROP_DIR).filter((f) => f.endsWith('.json')).sort((a, b) => a.localeCompare(b));
  const indexJson = (list: string[]) => {
    const require = createRequire(import.meta.url);
    const picked = new Set(
      MILKDROP_PACKS.flatMap((pack) => Object.keys(require(`butterchurn-presets/lib/${pack}.min.js`).getPresets())),
    );
    const all = list.map((f) => f.slice(0, -'.json'.length));
    const shuffle = all.flatMap((name, i) => (picked.has(name) ? [i] : []));
    return JSON.stringify({ names: all, shuffle });
  };
  return {
    name: 'milkdrop-presets',
    configureServer(server) {
      const list = files();
      server.middlewares.use('/milkdrop/', (req, res, next) => {
        const path = (req.url ?? '').split('?')[0];
        const match = /^\/(\d+)\.json$/.exec(path);
        let body: string | null = null;
        if (path === '/index.json') body = indexJson(list);
        else if (match && list[Number(match[1])]) body = readFileSync(join(MILKDROP_DIR, list[Number(match[1])]), 'utf8');
        if (body === null) return next();
        res.setHeader('Content-Type', 'application/json');
        res.end(body);
      });
    },
    generateBundle() {
      const list = files();
      this.emitFile({ type: 'asset', fileName: 'milkdrop/index.json', source: indexJson(list) });
      list.forEach((file, i) => {
        this.emitFile({ type: 'asset', fileName: `milkdrop/${i}.json`, source: readFileSync(join(MILKDROP_DIR, file)) });
      });
    },
  };
}

export default defineConfig({
  // Relative base so the build works from any sub-path (GitHub Pages, Netlify, a USB stick...).
  base: './',
  plugins: [milkdropPresets()],
  // Spotify only accepts loopback redirect URIs as 127.0.0.1 (not "localhost"), so serve there.
  server: { host: '127.0.0.1' },
  preview: { host: '127.0.0.1' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
