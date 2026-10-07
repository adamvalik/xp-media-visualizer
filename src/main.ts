import './styles/xp.css';
import { AudioEngine } from './audio/AudioEngine';
import { App } from './ui/App';
import { Visualizer } from './viz/Visualizer';

const engine = new AudioEngine();

let visualizer: Visualizer | null = null;
try {
  visualizer = new Visualizer(document.querySelector<HTMLCanvasElement>('#vis-canvas')!, engine);
} catch (err) {
  console.error('Could not start the visualizer', err);
}

const app = new App(engine, visualizer);

if (import.meta.env.DEV) Object.assign(window, { __xp: { engine, visualizer, app } });

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Service worker registration failed', err));
  });
}
