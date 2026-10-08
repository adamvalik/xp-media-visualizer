/** The Document Picture-in-Picture API (Chrome and Edge 116+). */
interface DocumentPictureInPicture {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
}

declare global {
  interface Window {
    documentPictureInPicture?: DocumentPictureInPicture;
  }
}

/** Size of the compact skin (must match `.skin-shape` in index.html). */
const SKIN_W = 460;
const SKIN_H = 210;
/** Room around the skin so its drop shadow isn't cut off. */
const MARGIN = 8;

export interface PopOutHooks {
  open(pip: Window): void;
  close(): void;
}

/**
 * Moves the player window into a Document Picture-in-Picture window, which floats above other apps,
 * and puts it back when that window closes. The element itself moves, so the WebGL canvas, the
 * listeners on it and the audio keep running in this page.
 */
export class PopOut {
  private pip: Window | null = null;
  private readonly placeholder = document.createComment('pop-out');

  constructor(private readonly win: HTMLElement, private readonly hooks: PopOutHooks) {}

  static supported() {
    return 'documentPictureInPicture' in window;
  }

  get isOpen() {
    return this.pip !== null;
  }

  get document() {
    return this.pip?.document ?? null;
  }

  async open() {
    if (this.pip || !window.documentPictureInPicture) return;
    const pip = await window.documentPictureInPicture.requestWindow({
      width: SKIN_W + MARGIN * 2,
      height: SKIN_H + MARGIN * 2,
    });
    this.pip = pip;
    const doc = pip.document;
    doc.title = document.title;
    doc.documentElement.className = 'pop-out';
    doc.documentElement.dataset.skin = document.documentElement.dataset.skin;
    const base = doc.createElement('base');
    base.href = document.baseURI;
    doc.head.append(base);
    for (const node of document.head.querySelectorAll('style, link[rel="stylesheet"]')) doc.head.append(node.cloneNode(true));
    // The icons are <use> references into the page's sprite, which has to be in the same document.
    const sprite = document.querySelector('body > svg');
    if (sprite) doc.body.append(sprite.cloneNode(true));

    this.win.before(this.placeholder);
    doc.body.append(this.win);
    this.win.classList.add('popped');
    const fit = () => {
      const scale = Math.min((pip.innerWidth - MARGIN * 2) / SKIN_W, (pip.innerHeight - MARGIN * 2) / SKIN_H);
      this.win.style.setProperty('--pip-scale', String(Math.max(0.2, scale)));
    };
    fit();
    pip.addEventListener('resize', fit);
    // Closing the window, or Chrome's "back to tab" button.
    pip.addEventListener('pagehide', () => this.restore(), { once: true });
    this.hooks.open(pip);
  }

  close() {
    const pip = this.pip;
    this.restore();
    pip?.close();
  }

  private restore() {
    if (!this.pip) return;
    this.pip = null;
    this.placeholder.replaceWith(this.win);
    this.win.classList.remove('popped');
    this.win.style.removeProperty('--pip-scale');
    this.hooks.close();
  }
}
