/** Ignore input for a moment after starting, so the click on "Preview" or a jittery mouse doesn't end it. */
const GRACE_MS = 800;
/** How far the mouse has to move (px) to wake up, like the XP screen savers. */
const WAKE_DISTANCE = 6;

export interface ScreensaverHooks {
  enabled(): boolean;
  minutes(): number;
  /** Whether the screen saver may start on its own right now (e.g. music is playing). */
  canStart(): boolean;
  start(): void;
  stop(preview: boolean): void;
}

/**
 * Idle timer for the screen saver: starts it after a few minutes without mouse or keyboard input and
 * stops it on the next input, which is swallowed so it doesn't also press whatever is under the cursor.
 */
export class Screensaver {
  private running = false;
  private preview = false;
  private lastInput = performance.now();
  private startedAt = 0;
  private pointer: [number, number] | null = null;
  private origin: [number, number] | null = null;

  constructor(private readonly hooks: ScreensaverHooks) {
    const onInput = (e: Event) => this.onInput(e);
    for (const type of ['pointerdown', 'keydown', 'wheel']) window.addEventListener(type, onInput, { capture: true });
    window.addEventListener('pointermove', (e) => this.onMove(e), { capture: true });
    // Time spent in another tab doesn't count; coming back shouldn't instantly start the screen saver.
    document.addEventListener('visibilitychange', () => (this.lastInput = performance.now()));
    window.setInterval(() => this.check(), 1000);
  }

  get active() {
    return this.running;
  }

  /** Starts right away, e.g. from the Preview button. */
  startNow(preview = false) {
    if (this.running) return;
    this.running = true;
    this.preview = preview;
    this.startedAt = performance.now();
    this.origin = this.pointer;
    this.hooks.start();
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.lastInput = performance.now();
    this.hooks.stop(this.preview);
  }

  private check() {
    if (this.running || !this.hooks.enabled() || document.hidden) return;
    if (performance.now() - this.lastInput < this.hooks.minutes() * 60_000) return;
    if (this.hooks.canStart()) this.startNow();
  }

  private onInput(e: Event) {
    if (e instanceof PointerEvent) this.pointer = [e.clientX, e.clientY];
    if (!this.running) {
      this.lastInput = performance.now();
      return;
    }
    if (e.type !== 'wheel') e.preventDefault(); // wheel listeners are passive
    e.stopPropagation();
    if (performance.now() - this.startedAt < GRACE_MS) return;
    if (e.type === 'pointerdown') swallowClicks();
    this.stop();
  }

  private onMove(e: PointerEvent) {
    this.pointer = [e.clientX, e.clientY];
    if (!this.running) {
      this.lastInput = performance.now();
      return;
    }
    if (performance.now() - this.startedAt < GRACE_MS) {
      this.origin = this.pointer;
      return;
    }
    if (!this.origin) {
      this.origin = this.pointer;
      return;
    }
    if (Math.hypot(e.clientX - this.origin[0], e.clientY - this.origin[1]) > WAKE_DISTANCE) this.stop();
  }
}

/** The click (and double-click) that woke the screen saver must not reach the player underneath. */
function swallowClicks() {
  const block = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener('click', block, { capture: true });
  window.addEventListener('dblclick', block, { capture: true });
  window.setTimeout(() => {
    window.removeEventListener('click', block, { capture: true });
    window.removeEventListener('dblclick', block, { capture: true });
  }, 600);
}
