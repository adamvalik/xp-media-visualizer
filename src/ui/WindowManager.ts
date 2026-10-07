const MIN_W = 480;
const MIN_H = 360;
const SMALL_SCREEN = 760;

/** Moves, resizes, minimizes and maximizes the single XP window on the fake desktop. */
export class WindowManager {
  maximized = false;
  minimized = false;
  closed = false;
  private rect = { x: 40, y: 30, w: 1100, h: 720 };

  constructor(
    private readonly win: HTMLElement,
    private readonly desktop: HTMLElement,
    private readonly taskButton: HTMLElement,
    private readonly onChange: () => void,
    private readonly onMaximizeToggle: (maximized: boolean) => void,
  ) {}

  get visible() {
    return !this.minimized && !this.closed;
  }

  init(maximized: boolean | null) {
    const { clientWidth: dw, clientHeight: dh } = this.desktop;
    const w = Math.min(1180, dw - 48);
    const h = Math.min(780, dh - 40);
    this.rect = { w, h, x: Math.round((dw - w) / 2), y: Math.max(8, Math.round((dh - h) / 2.4)) };
    const standalone = window.matchMedia('(display-mode: standalone)').matches;
    this.maximized = maximized ?? (standalone || dw < 1000 || dh < 640);
    this.bindDrag();
    this.bindResize();
    this.bindFocus();
    window.addEventListener('resize', () => this.apply());
    this.apply();
  }

  toggleMaximize() {
    this.maximized = !this.maximized;
    this.apply();
    this.onMaximizeToggle(this.maximized);
  }

  minimize() {
    this.minimized = true;
    this.apply();
  }

  close() {
    this.closed = true;
    this.apply();
  }

  open() {
    this.closed = false;
    this.minimized = false;
    this.apply();
  }

  /** Taskbar button: restore when minimized, minimize when already in front. */
  taskToggle() {
    if (this.minimized) this.minimized = false;
    else if (this.win.classList.contains('inactive')) this.setActive(true);
    else this.minimized = true;
    this.apply();
  }

  private apply() {
    const forcedMax = this.desktop.clientWidth < SMALL_SCREEN;
    const max = this.maximized || forcedMax;
    this.win.classList.toggle('maximized', max);
    this.win.classList.toggle('minimized', this.minimized);
    this.win.classList.toggle('closed', this.closed);
    this.taskButton.classList.toggle('gone', this.closed);
    this.taskButton.classList.toggle('active', this.visible && !this.win.classList.contains('inactive'));
    if (!max) {
      this.clamp();
      const s = this.win.style;
      s.left = `${this.rect.x}px`;
      s.top = `${this.rect.y}px`;
      s.width = `${this.rect.w}px`;
      s.height = `${this.rect.h}px`;
    }
    this.onChange();
  }

  private clamp() {
    const { clientWidth: dw, clientHeight: dh } = this.desktop;
    const r = this.rect;
    r.w = Math.max(MIN_W, Math.min(r.w, dw));
    r.h = Math.max(MIN_H, Math.min(r.h, dh));
    r.x = Math.min(Math.max(r.x, 60 - r.w), dw - 60);
    r.y = Math.min(Math.max(r.y, 0), dh - 30);
  }

  private setActive(active: boolean) {
    this.win.classList.toggle('inactive', !active);
    this.taskButton.classList.toggle('active', active && this.visible);
  }

  private bindFocus() {
    this.desktop.addEventListener('pointerdown', (e) => {
      if (e.target === this.desktop || (e.target as HTMLElement).closest('.desktop-icon')) this.setActive(false);
    });
    this.win.addEventListener('pointerdown', () => this.setActive(true));
  }

  private bindDrag() {
    const bar = this.win.querySelector<HTMLElement>('.title-bar')!;
    bar.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      this.toggleMaximize();
    });
    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || this.win.classList.contains('maximized')) return;
      if ((e.target as HTMLElement).closest('button')) return;
      const startX = e.clientX - this.rect.x;
      const startY = e.clientY - this.rect.y;
      bar.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        this.rect.x = ev.clientX - startX;
        this.rect.y = ev.clientY - startY;
        this.apply();
      };
      const up = () => {
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', up);
        bar.removeEventListener('pointercancel', up);
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
      bar.addEventListener('pointercancel', up);
    });
  }

  private bindResize() {
    const grip = this.win.querySelector<HTMLElement>('.resize-grip')!;
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const start = { x: e.clientX, y: e.clientY, w: this.rect.w, h: this.rect.h };
      grip.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        this.rect.w = start.w + ev.clientX - start.x;
        this.rect.h = start.h + ev.clientY - start.y;
        this.apply();
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
    });
  }
}
