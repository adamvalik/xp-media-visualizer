import { BANDS, type AudioFrame } from '../audio/analysis';
import { AudioEngine, type SourceKind } from '../audio/AudioEngine';
import { albumColor } from '../spotify/albumColor';
import { SpotifyClient, redirectUri } from '../spotify/SpotifyClient';
import { MILKDROP_SINGLE_ID, PRESETS, RANDOM_DEF, RANDOM_ID, presetLabel } from '../viz/presets';
import type { PresetChangeDetail, Visualizer } from '../viz/Visualizer';
import { CLIP_FORMATS, ClipRecorder, type Clip, type ClipCaption, type ClipFormat } from './ClipRecorder';
import { setupMenus } from './menus';
import { Notifier } from './notify';
import { PopOut } from './PopOut';
import { Screensaver } from './Screensaver';
import { CLIP_SECONDS, SCREENSAVER_MINUTES, SKINS, loadSettings, saveSettings, type SkinId } from './settings';
import { WindowManager } from './WindowManager';

/** The pop-out player's document while it's open; the player window and its controls live there then. */
let popOutDoc: Document | null = null;

const $ = <T extends HTMLElement = HTMLElement>(selector: string, root?: ParentNode) =>
  (root ? root.querySelector<T>(selector) : document.querySelector<T>(selector) ?? popOutDoc?.querySelector<T>(selector))!;
const $$ = <T extends HTMLElement = HTMLElement>(selector: string, root?: ParentNode) =>
  root
    ? [...root.querySelectorAll<T>(selector)]
    : [...document.querySelectorAll<T>(selector), ...(popOutDoc?.querySelectorAll<T>(selector) ?? [])];

type ViewId = 'now-playing' | 'library' | 'sources' | 'skins';

const VIEW_TITLES: Record<ViewId, string> = {
  'now-playing': 'Now Playing',
  library: 'Media Library',
  sources: 'Radio Tuner',
  skins: 'Skin Chooser',
};

const SOURCE_NAMES: Record<SourceKind, string> = {
  mic: 'Microphone',
  tab: 'Browser tab audio',
  demo: 'Demo Beat',
  file: 'Audio file',
};

/** Playlist order: Alchemy first, then every real preset. */
const PLAYLIST = [RANDOM_DEF, ...PRESETS];

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

const formatTime = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  const mm = String(Math.floor(s / 60) % 60).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm}:${ss}` : `${mm}:${ss}`;
};

const setFill = (input: HTMLInputElement) => {
  const min = Number(input.min);
  const max = Number(input.max);
  input.style.setProperty('--fill', `${((Number(input.value) - min) / (max - min)) * 100}%`);
};

export class App {
  private readonly settings = loadSettings();
  private readonly notify = new Notifier();
  private readonly wm: WindowManager;
  private readonly menus: ReturnType<typeof setupMenus>;
  private readonly screensaver: Screensaver;
  private readonly clips = new ClipRecorder();
  private readonly popOut: PopOut;
  /** What to go back to when the screen saver ends. */
  private beforeScreensaver: { preset: string; auto: boolean; view: ViewId; minimized: boolean } | null = null;
  private readonly stage = $('#stage');
  private view: ViewId = 'now-playing';
  private lastToastLabel = '';
  private lastError = '';
  private trackToastTimer = 0;
  private idleTimer = 0;
  private seeking = false;
  private installPrompt: InstallPromptEvent | null = null;
  private readonly spotify = new SpotifyClient();
  private albumRgb: [number, number, number] | null = null;
  private lastSpotifyError = '';

  constructor(private readonly engine: AudioEngine, private readonly viz: Visualizer | null) {
    document.documentElement.dataset.skin = this.settings.skin;
    engine.volume = this.settings.volume;
    engine.muted = this.settings.muted;
    engine.micDeviceId = this.settings.micDeviceId;
    engine.analysis.gainDb = this.settings.sensitivity;

    this.wm = new WindowManager($('#win'), $('#desktop'), $('#task-button'), () => this.updateRenderState(), (maximized) => {
      this.settings.maximized = maximized;
      this.save();
    });
    this.wm.init(this.settings.maximized);
    this.menus = setupMenus($('.menubar'));
    this.popOut = new PopOut($('#win'), {
      open: (pip) => this.onPopOutOpen(pip),
      close: () => this.onPopOutClose(),
    });

    this.buildVisMenu();
    this.buildPlaylist();
    this.buildLibrary();
    this.buildSkins();
    this.bindCommands();
    this.bindTransport();
    this.bindSources();
    this.bindKeyboard();
    this.bindDragAndDrop();
    this.bindFullscreen();
    this.bindInstall();
    this.bindSpotify();
    this.applyLayout();
    this.setSkinMode(this.settings.skinMode);

    this.screensaver = new Screensaver({
      enabled: () => this.settings.screensaver,
      minutes: () => this.settings.screensaverMinutes,
      canStart: () => this.canStartScreensaver(),
      start: () => this.startScreensaver(),
      stop: (preview) => this.stopScreensaver(preview),
    });

    engine.addEventListener('change', () => this.onEngineChange());
    if (viz) {
      viz.addEventListener('presetchange', (e) => this.onPresetChange((e as CustomEvent<PresetChangeDetail>).detail));
      viz.milkdrop.preferred = this.settings.milkdrop;
      viz.milkdrop.addEventListener('change', () => this.onMilkdropChange());
      viz.onFrame = (frame) => this.onFrame(frame);
      viz.onRender = (canvas) => this.clips.drawFrame(canvas);
      this.clips.addEventListener('done', (e) => this.onClipDone((e as CustomEvent<Clip>).detail));
      if (this.settings.preset === RANDOM_ID) viz.setAuto(true);
      else viz.setPreset(PRESETS.some((p) => p.id === this.settings.preset) ? this.settings.preset : 'bars-bars');
      viz.start();
    } else {
      this.showWebGLError();
    }

    if (!viz || !ClipRecorder.supported()) {
      for (const el of $$<HTMLButtonElement>('[data-needs="record"]')) {
        el.disabled = true;
        el.title = 'Recording clips needs a browser with MediaRecorder and WebGL.';
      }
    }

    if (!PopOut.supported()) {
      for (const el of $$<HTMLButtonElement>('[data-needs="pip"]')) {
        el.disabled = true;
        el.title = 'The pop-out player needs Chrome or Edge on a desktop computer.';
      }
    }

    if (!AudioEngine.tabCaptureSupported()) {
      for (const el of $$<HTMLButtonElement>('[data-needs="tab"]')) {
        el.disabled = true;
        el.title = 'Tab audio capture needs Chrome or Edge on a desktop computer.';
      }
    }

    this.onEngineChange();
    void this.refreshDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', () => void this.refreshDevices());
    window.setInterval(() => this.tick(), 250);
    this.updateClock();
    window.setInterval(() => this.updateClock(), 10_000);
  }

  // ---------- Commands ----------

  private readonly onCommandClick = (e: MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-cmd]');
    if (!el || el.matches(':disabled') || el.classList.contains('desktop-icon')) return;
    this.run(el.dataset.cmd!, el);
  };

  private bindCommands() {
    document.addEventListener('click', this.onCommandClick);

    const icon = $('.desktop-icon');
    icon.addEventListener('dblclick', () => this.run('window-open'));
    icon.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.run('window-open');
    });

    for (const item of $$('.task-item')) {
      item.addEventListener('click', () => {
        if (item.dataset.view) this.setView(item.dataset.view as ViewId);
      });
    }

    $('#vis-name').addEventListener('click', () => this.setView('library'));

    const fileInput = $<HTMLInputElement>('#file-input');
    fileInput.addEventListener('change', () => {
      const files = [...(fileInput.files ?? [])];
      fileInput.value = '';
      if (files.length) this.playFiles(files);
    });
  }

  private run(cmd: string, source?: HTMLElement) {
    const viz = this.viz;
    switch (cmd) {
      case 'source-mic':
        return this.startSource('mic');
      case 'source-tab':
        return this.startSource('tab');
      case 'source-demo':
        return this.startSource('demo');
      case 'source-file':
        return this.openFiles();
      case 'play-pause':
        return this.playPause();
      case 'stop':
        return this.engine.stop();
      case 'prev':
        if (!this.engine.skip(-1)) viz?.step(-1);
        return;
      case 'next':
        if (!this.engine.skip(1)) viz?.step(1);
        return;
      case 'vis-prev':
        return viz?.step(-1);
      case 'vis-next':
        return viz?.step(1);
      case 'vis-random':
        return viz?.setAuto(!viz.auto);
      case 'mute':
        this.engine.muted = !this.engine.muted;
        return;
      case 'fullscreen':
        return this.toggleFullscreen();
      case 'view-now-playing':
        return this.setView('now-playing');
      case 'view-library':
        return this.setView('library');
      case 'view-sources':
        return this.setView('sources');
      case 'view-skins':
        return this.setView('skins');
      case 'view-spotify':
        this.setView('sources');
        return $('#spotify-box').scrollIntoView({ block: 'start', behavior: 'smooth' });
      case 'skin-mode':
        return this.setSkinMode(true);
      case 'full-mode':
        return this.setSkinMode(false);
      case 'pop-out':
        return void this.togglePopOut();
      case 'screensaver-settings':
        return this.showScreensaverSettings();
      case 'screensaver-preview':
        if (!this.viz) return;
        this.notify.closeModal();
        return this.screensaver.startNow(true);
      case 'record':
        return this.toggleRecording();
      case 'record-settings':
        return this.showRecordSettings();
      case 'record-start':
        this.notify.closeModal();
        return this.startRecording();
      case 'toggle-playlist':
        this.settings.showPlaylist = !this.settings.showPlaylist;
        return this.applyLayout();
      case 'toggle-taskbar':
        this.settings.showTaskbar = !this.settings.showTaskbar;
        return this.applyLayout();
      case 'toggle-classic':
        this.settings.classicMode = !this.settings.classicMode;
        this.applyLayout();
        return this.notify.showBalloon(
          $('#vis-name'),
          this.settings.classicMode ? 'Classic Mode on' : 'Classic Mode off',
          this.settings.classicMode
            ? 'Low-res pixels, 16-bit color and the flat 2D Bars, Ocean Mist and Scope, like it is 2003.'
            : 'Back to the modern 3D scenes.',
          4,
        );
      case 'toggle-sections':
        this.settings.sectionFx = !this.settings.sectionFx;
        this.applyLayout();
        return this.notify.showBalloon(
          $('#vis-name'),
          this.settings.sectionFx ? 'React to Drops on' : 'React to Drops off',
          this.settings.sectionFx
            ? 'Breakdowns build tension, drops flash and punch in, and Alchemy changes scene on them.'
            : 'The visuals follow the beat only, without guessing where the song is going.',
          4,
        );
      case 'toggle-fs-track':
        this.settings.fullscreenTrack = !this.settings.fullscreenTrack;
        return this.applyLayout();
      case 'about':
        return this.showAbout();
      case 'shortcuts':
        return this.showShortcuts();
      case 'spotify-help':
        return this.showSpotifyHelp();
      case 'install':
        return void this.installPrompt?.prompt();
      case 'window-min':
        return this.wm.minimize();
      case 'window-max':
        return this.wm.toggleMaximize();
      case 'window-close':
        // In the pop-out player, closing only closes the floating window.
        if (this.popOut.isOpen) return this.popOut.close();
        this.engine.stop();
        return this.wm.close();
      case 'window-open':
      case 'task-toggle':
        // While the player floats in its own window, the page's taskbar and desktop icon bring it back.
        if (this.popOut.isOpen) return this.popOut.close();
        return cmd === 'window-open' ? this.wm.open() : this.wm.taskToggle();
      case 'start':
        return this.notify.showBalloon(source ?? $('.start-button'), 'XP Media Visualizer', 'It is the only program installed on this computer. Turn the music up!');
      default:
        if (cmd.startsWith('vis:')) return this.choosePreset(cmd.slice(4));
        if (cmd.startsWith('skin:')) return this.setSkin(cmd.slice(5) as SkinId);
    }
  }

  // ---------- Audio sources ----------

  private startSource(kind: SourceKind) {
    this.settings.source = kind;
    this.save();
    this.setView('now-playing');
    if (kind === 'mic') void this.engine.useMic();
    else if (kind === 'tab') void this.engine.useTab();
    else if (kind === 'demo') this.engine.useDemo();
    else this.openFiles();
  }

  private openFiles() {
    $<HTMLInputElement>('#file-input').click();
  }

  private playFiles(files: File[]) {
    const accepted = this.engine.useFiles(files);
    if (accepted === 0) {
      this.notify.showBalloon($('#btn-play'), 'Unsupported file', 'Those files do not look like audio. Try MP3, WAV, FLAC, OGG or M4A.');
      return;
    }
    this.settings.source = 'file';
    this.save();
    this.setView('now-playing');
  }

  private playPause() {
    if (this.engine.kind) return this.engine.togglePlay();
    this.startSource(this.settings.source);
  }

  private async refreshDevices() {
    const select = $<HTMLSelectElement>('#mic-select');
    let inputs: MediaDeviceInfo[] = [];
    try {
      inputs = await this.engine.listInputs();
    } catch {
      return;
    }
    const current = this.engine.micDeviceId || this.settings.micDeviceId;
    select.replaceChildren(new Option('Default microphone', ''));
    inputs
      .filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .forEach((d, i) => select.append(new Option(d.label || `Microphone ${i + 1}`, d.deviceId)));
    select.value = [...select.options].some((o) => o.value === current) ? current : '';
  }

  private bindSources() {
    const select = $<HTMLSelectElement>('#mic-select');
    select.addEventListener('change', () => {
      this.engine.micDeviceId = select.value;
      this.settings.micDeviceId = select.value;
      this.save();
      if (this.engine.kind === 'mic' && this.engine.state !== 'idle') void this.engine.useMic(select.value);
    });

    const sens = $<HTMLInputElement>('#sensitivity');
    const out = $('#sensitivity-out');
    const update = () => {
      const v = Number(sens.value);
      out.textContent = `${v > 0 ? '+' : ''}${v} dB`;
      setFill(sens);
    };
    sens.value = String(this.settings.sensitivity);
    update();
    sens.addEventListener('input', () => {
      this.engine.analysis.gainDb = Number(sens.value);
      this.settings.sensitivity = Number(sens.value);
      update();
      this.save();
    });
  }

  // ---------- Transport ----------

  private bindTransport() {
    const volume = $<HTMLInputElement>('#volume');
    volume.value = String(Math.round(this.engine.volume * 100));
    setFill(volume);
    volume.addEventListener('input', () => {
      this.engine.volume = Number(volume.value) / 100;
      if (this.engine.muted) this.engine.muted = false;
      setFill(volume);
    });

    const seek = $('#seek');
    const seekTo = (e: PointerEvent) => {
      const r = seek.getBoundingClientRect();
      this.engine.seek((e.clientX - r.left) / r.width);
    };
    seek.addEventListener('pointerdown', (e) => {
      if (!this.engine.seekable) return;
      this.seeking = true;
      seek.setPointerCapture(e.pointerId);
      seekTo(e);
    });
    seek.addEventListener('pointermove', (e) => {
      if (this.seeking) seekTo(e);
    });
    const end = () => (this.seeking = false);
    seek.addEventListener('pointerup', end);
    seek.addEventListener('pointercancel', end);
    seek.addEventListener('keydown', (e) => {
      if (!this.engine.seekable) return;
      const step = e.key === 'ArrowRight' ? 5 : e.key === 'ArrowLeft' ? -5 : 0;
      if (!step) return;
      e.preventDefault();
      e.stopPropagation();
      this.engine.seek((this.engine.elapsed + step) / this.engine.duration);
    });
  }

  private onEngineChange() {
    const e = this.engine;
    const playing = e.state === 'playing';

    const playBtn = $('#btn-play');
    const icon = playing ? '#i-pause' : '#i-play';
    for (const use of $$('[data-cmd="play-pause"] use')) use.setAttribute('href', icon);
    playBtn.title = playing ? 'Pause' : 'Play';

    for (const use of $$('#btn-mute use, #tray-volume use')) use.setAttribute('href', e.muted ? '#i-muted' : '#i-speaker');
    $('#btn-mute').title = e.muted ? 'Sound' : 'Mute';
    const volume = $<HTMLInputElement>('#volume');
    if (Number(volume.value) !== Math.round(e.volume * 100)) {
      volume.value = String(Math.round(e.volume * 100));
      setFill(volume);
    }

    const status = this.spotifyLine() && playing ? `Playing: ${this.spotifyLine()}` : this.statusText();
    $('#lcd-status').textContent = status;
    $('#lcd-status').title = status;
    $('.lcd').classList.toggle('error', e.state === 'error');
    $('#top-info').textContent = this.spotifyLine() || (e.kind && e.state !== 'error' ? e.label : 'Ready');
    $('#pl-source').textContent = e.kind ? `Source: ${e.label}` : 'No source selected';

    // The seek bar only makes sense for files; live sources and Spotify can't be scrubbed.
    $('#seek').hidden = !e.seekable;

    for (const row of $$('.source-row')) row.classList.toggle('current', row.dataset.source === e.kind && e.state !== 'idle');
    this.checkMenuItem('mute', e.muted);

    const showStart = e.state === 'idle' || (e.state === 'error' && !e.kind);
    $('#start-screen').hidden = !showStart;

    if (e.state === 'error' && e.error) {
      $('#start-screen').hidden = false;
      if (e.error !== this.lastError) this.notify.showBalloon($('#btn-play'), 'Could not start', e.error, 9);
    }
    this.lastError = e.state === 'error' ? e.error : '';

    if (playing && e.label !== this.lastToastLabel) {
      this.lastToastLabel = e.label;
      const track = this.spotifyTrack();
      if (track) this.showTrackToast(track.title, track.artists, track.imageUrl);
      else this.showTrackToast(e.label, e.kind ? SOURCE_NAMES[e.kind] : '');
      if (e.kind === 'mic') void this.refreshDevices();
    }

    this.settings.volume = e.volume;
    this.settings.muted = e.muted;
    this.settings.micDeviceId = e.micDeviceId || this.settings.micDeviceId;
    this.save();
    this.applyTint();
    this.tick();
  }

  private statusText() {
    const e = this.engine;
    switch (e.state) {
      case 'idle':
        return 'Ready';
      case 'connecting':
        return e.kind === 'tab' ? 'Pick a tab and share its audio...' : e.kind === 'mic' ? 'Connecting to microphone...' : 'Opening...';
      case 'playing':
        return `Playing: ${e.label}`;
      case 'paused':
        return `Paused: ${e.label}`;
      case 'stopped':
        return 'Stopped';
      case 'error':
        return e.error || 'Error';
    }
  }

  /** Time display and seek bar, refreshed a few times per second. */
  private tick() {
    const e = this.engine;
    const track = this.spotify.track;
    if (track && track.durationMs > 0) {
      $('#now-progress-fill').style.width = `${(this.spotify.progressMs / track.durationMs) * 100}%`;
    }
    const time = $('#lcd-time');
    if (e.kind === 'file' && e.duration > 0) time.textContent = `${formatTime(e.elapsed)} / ${formatTime(e.duration)}`;
    else time.textContent = formatTime(e.elapsed);

    if (this.clips.recording) {
      $('#rec-time').textContent = `REC ${formatTime(this.clips.elapsed)} / ${formatTime(this.clips.limit)}`;
    }

    if (e.seekable) {
      const pct = `${Math.min(100, (e.elapsed / e.duration) * 100)}%`;
      $('#seek-fill').style.width = pct;
      $('#seek-thumb').style.left = pct;
    }
  }

  // ---------- Visualizations ----------

  private choosePreset(id: string) {
    if (!this.viz) return;
    if (id === RANDOM_ID) this.viz.setAuto(true);
    else this.viz.setPreset(id);
    this.setView('now-playing');
  }

  private onPresetChange({ def, auto }: PresetChangeDetail) {
    const label = auto ? presetLabel(RANDOM_DEF) : presetLabel(def);
    const name = $('#vis-name');
    name.textContent = label;
    name.title = auto ? `Now showing ${presetLabel(def)}` : 'Choose a visualization';
    $('#fs-label').textContent = presetLabel(def);

    const currentId = auto ? RANDOM_ID : def.id;
    for (const li of $$('.pl-item')) li.classList.toggle('current', li.dataset.id === currentId);
    for (const card of $$('.lib-card')) card.classList.toggle('current', card.dataset.cmd === `vis:${currentId}`);
    for (const item of $$('#vis-menu button')) item.setAttribute('aria-checked', String(item.dataset.cmd === `vis:${currentId}`));
    for (const btn of $$('[data-cmd="vis-random"][aria-pressed]')) btn.setAttribute('aria-pressed', String(auto));
    this.checkMenuItem('random', auto);
    $('#skin-vis-name').textContent = presetLabel(def);

    // The screen saver's Alchemy is temporary; keep the user's own choice saved.
    if (this.beforeScreensaver) return;
    this.settings.preset = currentId;
    this.save();
  }

  /** Updates the song overlay; `reveal` fades it in briefly (it stays pinned in full screen if enabled). */
  private showTrackToast(title: string, subtitle: string, imageUrl = '', reveal = true) {
    const toast = $('#track-toast');
    const text = document.createElement('div');
    text.append(document.createTextNode(title));
    if (subtitle) {
      const small = document.createElement('small');
      small.textContent = subtitle;
      text.append(small);
    }
    toast.replaceChildren();
    if (imageUrl) {
      const img = new Image();
      img.src = imageUrl;
      img.alt = '';
      toast.append(img);
    }
    toast.append(text);
    if (!reveal) return;
    toast.classList.add('show');
    window.clearTimeout(this.trackToastTimer);
    this.trackToastTimer = window.setTimeout(() => toast.classList.remove('show'), 4500);
  }

  private buildVisMenu() {
    const menu = $('#vis-menu');
    let group = '';
    for (const def of PLAYLIST) {
      if (def.group !== group) {
        group = def.group;
        const label = document.createElement('div');
        label.className = 'menu-group-label';
        label.textContent = group;
        menu.append(label);
      }
      const item = document.createElement('button');
      item.dataset.cmd = `vis:${def.id}`;
      item.setAttribute('role', 'menuitemradio');
      item.textContent = def.name;
      menu.append(item);
    }
  }

  private buildPlaylist() {
    const list = $('#pl-list');
    PLAYLIST.forEach((def, i) => {
      const li = document.createElement('li');
      li.className = 'pl-item';
      li.dataset.id = def.id;
      li.title = def.description;
      li.innerHTML = `<span class="pl-num">${i + 1}</span><span class="pl-name"></span>`;
      li.querySelector('.pl-name')!.textContent = presetLabel(def);
      li.addEventListener('click', () => {
        for (const other of $$('.pl-item')) other.classList.toggle('selected', other === li);
        this.choosePreset(def.id);
      });
      list.append(li);
    });
  }

  private buildLibrary() {
    const host = $('#library-list');
    const groups = new Map<string, typeof PLAYLIST>();
    for (const def of PLAYLIST) groups.set(def.group, [...(groups.get(def.group) ?? []), def]);
    for (const [group, defs] of groups) {
      const h = document.createElement('h3');
      h.textContent = group;
      const grid = document.createElement('div');
      grid.className = 'library-grid';
      for (const def of defs) {
        const card = document.createElement('button');
        card.className = 'lib-card';
        card.dataset.cmd = `vis:${def.id}`;
        const b = document.createElement('b');
        b.textContent = presetLabel(def);
        const small = document.createElement('small');
        small.textContent = def.description;
        card.append(b, small);
        grid.append(card);
      }
      host.append(h, grid);
    }
  }

  private milkdropListFilled = false;

  /** The MilkDrop preset list in Media Library, filled the first time the library opens. */
  private fillMilkdropList() {
    const viz = this.viz;
    if (this.milkdropListFilled || !viz) return;
    this.milkdropListFilled = true;
    const list = $('#md-list');
    const search = $<HTMLInputElement>('#md-search');
    const status = $('#md-status');
    viz.milkdrop
      .names()
      .then((names) => {
        list.replaceChildren(
          ...names.map((name, i) => {
            const item = document.createElement('button');
            item.className = 'md-item';
            item.dataset.md = String(i);
            item.textContent = name;
            return item;
          }),
        );
        search.disabled = false;
        status.textContent = `${names.length.toLocaleString('en-US')} presets`;
        this.markMilkdropItem();
      })
      .catch(() => {
        this.milkdropListFilled = false;
        status.textContent = 'Could not load the preset list. Check the connection and open Media Library again.';
      });

    list.addEventListener('click', (e) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>('.md-item');
      if (!item) return;
      viz.chooseMilkdrop(Number(item.dataset.md));
      this.setView('now-playing');
    });
    search.addEventListener('input', () => {
      const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
      let shown = 0;
      for (const item of list.children as HTMLCollectionOf<HTMLElement>) {
        const text = item.textContent!.toLowerCase();
        item.hidden = !words.every((w) => text.includes(w));
        if (!item.hidden) shown++;
      }
      status.textContent = words.length ? `${shown.toLocaleString('en-US')} found` : `${list.children.length.toLocaleString('en-US')} presets`;
    });
  }

  private markMilkdropItem() {
    const viz = this.viz;
    if (!viz) return;
    const current = viz.presetId === MILKDROP_SINGLE_ID ? viz.milkdrop.choice : -1;
    for (const item of $$('.md-item.current')) item.classList.remove('current');
    $(`.md-item[data-md="${current}"]`)?.classList.add('current');
  }

  /** MilkDrop scenes change presets on their own; the labels name the one showing. */
  private onMilkdropChange() {
    const viz = this.viz!;
    const def = PRESETS.find((p) => p.id === viz.presetId);
    if (def?.group !== 'MilkDrop') return;
    const label = `MilkDrop : ${viz.milkdrop.name}`;
    $('#fs-label').textContent = label;
    $('#skin-vis-name').textContent = label;
    $('#vis-name').title = `Now showing ${label}`;
    this.markMilkdropItem();
    if (def.id === MILKDROP_SINGLE_ID && !this.beforeScreensaver) {
      this.settings.milkdrop = viz.milkdrop.name;
      this.save();
    }
  }

  private buildSkins() {
    const grid = $('#skin-grid');
    for (const skin of SKINS) {
      const [title, frame, task, stage, panel, transport] = skin.preview;
      const card = document.createElement('button');
      card.className = 'skin-card';
      card.dataset.cmd = `skin:${skin.id}`;
      card.dataset.skinId = skin.id;
      card.innerHTML = `
        <div class="skin-preview" style="background:${frame}">
          <div style="background:${title}"></div>
          <div><div style="background:${task};border-radius:3px"></div><div style="background:${stage};border-radius:2px"></div><div style="background:${panel};border-radius:3px"></div></div>
          <div style="background:${transport}"></div>
        </div>
        <b></b>`;
      card.querySelector('b')!.textContent = skin.name;
      grid.append(card);
    }
    this.markSkin();
  }

  private setSkin(id: SkinId) {
    if (!SKINS.some((s) => s.id === id)) return;
    document.documentElement.dataset.skin = id;
    if (popOutDoc) popOutDoc.documentElement.dataset.skin = id;
    this.settings.skin = id;
    this.markSkin();
    this.save();
  }

  private markSkin() {
    for (const card of $$('.skin-card')) card.classList.toggle('current', card.dataset.skinId === this.settings.skin);
  }

  // ---------- Views & layout ----------

  private setView(view: ViewId) {
    // The compact skin only has room for the visualization.
    if (view !== 'now-playing' && this.wm.skinMode) this.setSkinMode(false);
    if (view === 'library') this.fillMilkdropList();
    this.view = view;
    for (const el of $$('.view')) el.classList.toggle('active', el.dataset.view === view);
    for (const el of $$('.task-item[data-view]')) el.classList.toggle('active', el.dataset.view === view);
    $('#view-title').textContent = VIEW_TITLES[view];
    this.updateRenderState();
  }

  private updateRenderState() {
    this.viz?.setRenderEnabled(this.view === 'now-playing' && this.wm?.visible !== false);
  }

  private applyLayout() {
    const win = $('#win');
    win.classList.toggle('hide-playlist', !this.settings.showPlaylist);
    win.classList.toggle('hide-taskbar', !this.settings.showTaskbar);
    this.checkMenuItem('playlist', this.settings.showPlaylist);
    this.checkMenuItem('taskbar', this.settings.showTaskbar);
    this.stage.classList.toggle('pin-track', this.settings.fullscreenTrack);
    this.viz?.setClassic(this.settings.classicMode);
    this.checkMenuItem('classic', this.settings.classicMode);
    this.viz?.setSectionFx(this.settings.sectionFx);
    this.checkMenuItem('sections', this.settings.sectionFx);
    this.checkMenuItem('fs-track', this.settings.fullscreenTrack);
    $<HTMLInputElement>('#fs-track').checked = this.settings.fullscreenTrack;
    this.save();
  }

  /** WMP's two modes: the full window (Ctrl+1) or the compact skin (Ctrl+2). */
  private setSkinMode(on: boolean) {
    if (!on && this.popOut.isOpen) this.popOut.close();
    if (on) {
      if (document.fullscreenElement) void document.exitFullscreen();
      if (!this.beforeScreensaver) this.stage.classList.remove('pseudo-fullscreen');
      this.setView('now-playing');
    }
    this.wm.setSkinMode(on);
    this.settings.skinMode = on;
    for (const item of $$('[data-mode]')) item.setAttribute('aria-checked', String((item.dataset.mode === 'skin') === on));
    this.save();
  }

  /** Skin mode in a Picture-in-Picture window that stays on top of other apps (Chrome and Edge). */
  private async togglePopOut() {
    if (this.popOut.isOpen) return this.popOut.close();
    if (!PopOut.supported()) {
      this.notify.showModal('Pop Out Player', '<p>The pop-out player needs Chrome or Edge on a desktop computer. Skin mode (Ctrl+2) works everywhere.</p>');
      return;
    }
    this.setSkinMode(true);
    try {
      await this.popOut.open();
    } catch (err) {
      console.warn('Could not open the pop-out player', err);
      this.notify.showModal('Pop Out Player', '<p>The browser did not open the pop-out window. Click the pop-out button again.</p>');
    }
  }

  private onPopOutOpen(pip: Window) {
    popOutDoc = pip.document;
    this.menus.close();
    this.listenTo(pip.document);
    this.viz?.setFrameWindow(pip);
    for (const el of $$('[data-cmd="pop-out"]')) el.setAttribute('aria-pressed', 'true');
  }

  private onPopOutClose() {
    popOutDoc = null;
    this.stage.classList.remove('pseudo-fullscreen');
    this.viz?.setFrameWindow(window);
    for (const el of $$('[data-cmd="pop-out"]')) el.setAttribute('aria-pressed', 'false');
  }

  private checkMenuItem(key: string, on: boolean) {
    for (const item of $$(`[data-check="${key}"]`)) {
      item.classList.add('check');
      item.setAttribute('aria-checked', String(on));
    }
  }

  // ---------- Meters ----------

  private onFrame(frame: AudioFrame) {
    this.drawTempo(frame);
    this.drawSection(frame);
    if (this.settings.showPlaylist && this.view !== 'skins') this.drawMiniSpectrum(frame);
    if (this.view === 'sources') this.drawSourceMeter(frame);
  }

  private shownBpm = -1;

  private drawTempo(frame: AudioFrame) {
    const t = frame.tempo;
    const bpm = t.locked ? Math.round(t.bpm) : 0;
    if (bpm !== this.shownBpm) {
      this.shownBpm = bpm;
      $('#lcd-bpm').hidden = bpm === 0;
      $('#lcd-bpm-value').textContent = String(bpm);
    }
    if (bpm) {
      const glow = Math.pow(1 - t.beatPhase, 3);
      const dot = $('#lcd-beat');
      dot.style.opacity = String(0.25 + 0.75 * glow);
      dot.classList.toggle('bar', t.barPhase < 0.25);
    }
  }

  private shownSection = '';
  private dropShownUntil = 0;

  /** BUILD / DROP tag in the display, so it's easy to judge how well the detection works. */
  private drawSection(frame: AudioFrame) {
    const s = frame.section;
    const now = performance.now();
    if (s.drop) this.dropShownUntil = now + 2500;
    let text = '';
    if (this.settings.sectionFx) {
      if (now < this.dropShownUntil) text = 'DROP';
      else if (s.breakdown) text = 'BUILD';
    }
    const tag = $('#lcd-section');
    if (text !== this.shownSection) {
      this.shownSection = text;
      tag.hidden = !text;
      tag.textContent = text;
      tag.classList.toggle('drop', text === 'DROP');
      tag.title = text === 'DROP' ? 'Drop detected' : 'Breakdown: building towards a drop';
    }
    if (text === 'BUILD') tag.style.opacity = String(0.45 + 0.55 * s.build);
    else tag.style.opacity = '';
  }

  private drawMiniSpectrum(frame: AudioFrame) {
    const canvas = $<HTMLCanvasElement>('#mini-spectrum');
    if (!canvas.offsetParent) return;
    const ctx = canvas.getContext('2d')!;
    const { width: w, height: h } = canvas;
    ctx.clearRect(0, 0, w, h);
    const cols = 28;
    const gap = 2;
    const colW = (w - gap * (cols - 1)) / cols;
    const seg = 3;
    const segs = Math.floor(h / (seg + 1));
    const per = BANDS / cols;
    for (let c = 0; c < cols; c++) {
      let v = 0;
      let peak = 0;
      for (let i = Math.floor(c * per); i < Math.floor((c + 1) * per); i++) {
        v = Math.max(v, frame.spectrum[i]);
        peak = Math.max(peak, frame.peaks[i]);
      }
      const lit = Math.round(v * segs);
      const x = c * (colW + gap);
      for (let s = 0; s < segs; s++) {
        const t = s / segs;
        const on = s < lit;
        ctx.fillStyle = t > 0.8 ? (on ? '#ff5a3c' : '#3a1410') : t > 0.55 ? (on ? '#ffd23c' : '#3a3210') : on ? '#45e66a' : '#123a1c';
        ctx.fillRect(x, h - (s + 1) * (seg + 1), colW, seg);
      }
      const ps = Math.min(segs - 1, Math.round(peak * segs));
      if (ps > 0) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(x, h - (ps + 1) * (seg + 1), colW, seg);
      }
    }
  }

  private drawSourceMeter(frame: AudioFrame) {
    const canvas = $<HTMLCanvasElement>('#source-meter');
    const ctx = canvas.getContext('2d')!;
    const { width: w, height: h } = canvas;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    const segs = 40;
    const sw = w / segs;
    const lit = Math.round(Math.min(1, frame.level * frame.presence * 1.2) * segs);
    for (let i = 0; i < segs; i++) {
      const t = i / segs;
      const on = i < lit;
      ctx.fillStyle = t > 0.85 ? (on ? '#ff5a3c' : '#3a1410') : t > 0.65 ? (on ? '#ffd23c' : '#3a3210') : on ? '#45e66a' : '#123a1c';
      ctx.fillRect(i * sw + 1, 2, sw - 2, h - 4);
    }
  }

  // ---------- Keyboard, drag & drop, fullscreen ----------

  /** Clicks and keys, in the page and in the pop-out player. */
  private listenTo(doc: Document) {
    doc.addEventListener('click', this.onCommandClick);
    doc.addEventListener('keydown', this.onKey);
    doc.addEventListener('keydown', this.onEscape);
  }

  private bindKeyboard() {
    document.addEventListener('keydown', this.onKey);
  }

  private readonly onKey = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('input, select, textarea, dialog')) return;
    if ((e.key === ' ' || e.key === 'Enter') && target.closest('button')) return;
    if (e.metaKey || e.ctrlKey) {
      if (e.key.toLowerCase() === 'o') {
        e.preventDefault();
        this.openFiles();
      } else if (e.ctrlKey && (e.key === '1' || e.key === '2')) {
        // Ctrl only: Cmd+digit switches browser tabs on a Mac.
        e.preventDefault();
        this.setSkinMode(e.key === '2');
      } else if (e.ctrlKey && e.key === '3') {
        e.preventDefault();
        void this.togglePopOut();
      }
      return;
    }
    if (e.altKey) return;
    const viz = this.viz;
    switch (e.key) {
      case ' ':
      case 'k':
        e.preventDefault();
        this.playPause();
        break;
      case 's':
        this.engine.stop();
        break;
      case 'ArrowRight':
      case 'n':
        viz?.step(1);
        break;
      case 'ArrowLeft':
      case 'p':
        viz?.step(-1);
        break;
      case 'r':
        viz?.setAuto(!viz.auto);
        break;
      case 'f':
        this.toggleFullscreen();
        break;
      case 'm':
        this.engine.muted = !this.engine.muted;
        break;
      case 'i':
        this.run('toggle-fs-track');
        break;
      case 'c':
        this.run('toggle-classic');
        break;
      case 'd':
        this.run('toggle-sections');
        break;
      case 'v':
        this.toggleRecording();
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.engine.volume += 0.05;
        break;
      case 'ArrowDown':
        e.preventDefault();
        this.engine.volume -= 0.05;
        break;
      default: {
        const n = Number(e.key);
        if (n >= 1 && n <= PLAYLIST.length) this.choosePreset(PLAYLIST[n - 1].id);
      }
    }
  };

  private bindDragAndDrop() {
    let depth = 0;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false;
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      depth++;
      this.setView('now-playing');
      this.stage.classList.add('dragging');
    });
    window.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) this.stage.classList.remove('dragging');
    });
    window.addEventListener('dragover', (e) => {
      if (hasFiles(e)) e.preventDefault();
    });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      this.stage.classList.remove('dragging');
      this.playFiles([...(e.dataTransfer?.files ?? [])]);
    });
  }

  private toggleFullscreen() {
    const stage = this.stage;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    if (stage.classList.contains('pseudo-fullscreen')) {
      stage.classList.remove('pseudo-fullscreen');
      return;
    }
    this.setView('now-playing');
    // A Picture-in-Picture window can't go full screen; the visualization fills it instead.
    if (this.popOut.isOpen) {
      stage.classList.add('pseudo-fullscreen');
      this.wakeControls();
      return;
    }
    const fallback = () => {
      if (!document.fullscreenElement) stage.classList.add('pseudo-fullscreen');
    };
    if (stage.requestFullscreen) {
      stage.requestFullscreen().catch(fallback);
      // Some embedded browsers leave the request pending forever; fill the window instead.
      window.setTimeout(fallback, 700);
    } else {
      fallback();
    }
    this.wakeControls();
  }

  private bindFullscreen() {
    this.stage.addEventListener('pointermove', () => this.wakeControls());
    this.stage.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).closest('button, .start-screen')) return;
      this.toggleFullscreen();
    });
    document.addEventListener('keydown', this.onEscape);
    document.addEventListener('fullscreenchange', () => {
      if (document.fullscreenElement) this.stage.classList.remove('pseudo-fullscreen');
      this.wakeControls();
    });
  }

  private readonly onEscape = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.stage.classList.contains('pseudo-fullscreen')) this.stage.classList.remove('pseudo-fullscreen');
  };

  private wakeControls() {
    this.stage.classList.remove('idle');
    window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => {
      if (document.fullscreenElement || this.stage.classList.contains('pseudo-fullscreen')) this.stage.classList.add('idle');
    }, 2500);
  }

  private bindInstall() {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.installPrompt = e as InstallPromptEvent;
      $('#install-item').hidden = false;
    });
    window.addEventListener('appinstalled', () => {
      this.installPrompt = null;
      $('#install-item').hidden = true;
    });
  }

  // ---------- Spotify ----------

  /** The Spotify track, but only when it describes what the visualizer hears (live inputs). */
  private spotifyTrack() {
    const t = this.spotify.track;
    const kind = this.engine.kind;
    if (!t || !t.isPlaying || kind === 'file' || kind === 'demo') return null;
    return t;
  }

  private spotifyLine() {
    const t = this.spotifyTrack();
    return t ? (t.artists ? `${t.artists} \u2013 ${t.title}` : t.title) : '';
  }

  private bindSpotify() {
    const sp = this.spotify;
    const idInput = $<HTMLInputElement>('#spotify-client-id');
    const tint = $<HTMLInputElement>('#spotify-tint');
    const onLocalhost = location.hostname === 'localhost';

    $('#spotify-redirect').textContent = redirectUri();
    idInput.value = sp.clientId;
    tint.checked = this.settings.albumTint;
    if (onLocalhost) {
      const loopback = `${location.protocol}//127.0.0.1${location.port ? `:${location.port}` : ''}${location.pathname}`;
      $('#spotify-redirect-hint').innerHTML =
        `Spotify does not accept "localhost" redirect addresses. Open <a href="${loopback}">${loopback}</a> instead and connect from there.`;
    }

    idInput.addEventListener('change', () => {
      sp.clientId = idInput.value;
      this.renderSpotify();
    });
    $('#spotify-copy').addEventListener('click', () => {
      void navigator.clipboard?.writeText(redirectUri());
      this.notify.showBalloon($('#spotify-copy'), 'Copied', 'Paste it under "Redirect URIs" in your Spotify app settings.', 4);
    });
    $('#spotify-connect').addEventListener('click', () => {
      sp.clientId = idInput.value;
      if (onLocalhost) {
        $<HTMLDetailsElement>('#spotify-setup').open = true;
        this.notify.showBalloon($('#spotify-connect'), 'Use 127.0.0.1', 'Spotify rejects "localhost". Open the 127.0.0.1 address shown below and connect there.');
        return;
      }
      if (!sp.clientId) {
        $<HTMLDetailsElement>('#spotify-setup').open = true;
        idInput.focus();
        this.notify.showBalloon(idInput, 'Client ID needed', 'Follow the one-time setup below, then paste your Client ID here.');
        return;
      }
      void sp.connect();
    });
    $('#spotify-disconnect').addEventListener('click', () => sp.disconnect());
    $<HTMLInputElement>('#fs-track').addEventListener('change', (e) => {
      this.settings.fullscreenTrack = (e.target as HTMLInputElement).checked;
      this.applyLayout();
    });
    tint.addEventListener('change', () => {
      this.settings.albumTint = tint.checked;
      this.save();
      this.applyTint();
    });

    sp.addEventListener('status', () => this.renderSpotify());
    sp.addEventListener('track', (e) => this.onSpotifyTrack((e as CustomEvent<{ changed: boolean }>).detail.changed));
    this.renderSpotify();
    void sp.init();
  }

  private renderSpotify() {
    const sp = this.spotify;
    const status = $('#spotify-status');
    const labels = { disconnected: 'Not connected', connecting: 'Connecting...', connected: 'Connected', error: sp.error };
    status.textContent = labels[sp.status];
    status.className = sp.status;
    $('#spotify-connect').hidden = sp.connected;
    $('#spotify-disconnect').hidden = !sp.connected;
    $('#spotify-menu-item').textContent = sp.connected ? 'Spotify Settings...' : 'Connect to Spotify...';
    if (!sp.clientId && !sp.connected) $<HTMLDetailsElement>('#spotify-setup').open = true;
    if (sp.status === 'error' && sp.error && sp.error !== this.lastSpotifyError) {
      this.notify.showBalloon($('#top-info'), 'Spotify', sp.error, 8);
    }
    this.lastSpotifyError = sp.status === 'error' ? sp.error : '';
  }

  private onSpotifyTrack(changed: boolean) {
    const t = this.spotify.track;
    const card = $('#now-card');
    card.hidden = !t;
    if (t) {
      $<HTMLImageElement>('#now-art').src = t.imageUrl || './icon.svg';
      $('#now-title').textContent = t.title;
      $('#now-artist').textContent = t.artists || t.album;
      card.title = [t.title, t.artists, t.album].filter(Boolean).join('\n');
    }
    if (!changed) return;

    this.onEngineChange();
    const live = this.spotifyTrack();
    if (live) {
      this.lastToastLabel = this.engine.label;
      this.showTrackToast(live.title, live.artists, live.imageUrl);
    } else if (this.engine.kind) {
      // Song ended or paused: keep the pinned full-screen overlay truthful without flashing it.
      this.showTrackToast(this.engine.label, SOURCE_NAMES[this.engine.kind], '', false);
    }
    this.albumRgb = null;
    this.applyTint();
    if (t?.imageUrl) {
      const url = t.imageUrl;
      void albumColor(url).then((rgb) => {
        if (this.spotify.track?.imageUrl !== url) return;
        this.albumRgb = rgb;
        this.applyTint();
      });
    }
  }

  private applyTint() {
    const on = this.settings.albumTint && this.spotifyTrack() !== null && this.albumRgb !== null;
    this.viz?.setTint(on ? this.albumRgb : null);
  }

  // ---------- Screen saver ----------

  private canStartScreensaver() {
    return (
      this.viz !== null &&
      this.engine.state === 'playing' &&
      !this.clips.recording &&
      !this.wm.closed &&
      !this.popOut.isOpen &&
      !document.fullscreenElement &&
      !this.stage.classList.contains('pseudo-fullscreen')
    );
  }

  /**
   * Alchemy over the whole window. Browsers only allow real full screen right after a click, so this
   * fills the page instead (which is the whole screen when the browser itself is in full screen).
   */
  private startScreensaver() {
    const viz = this.viz;
    if (!viz) return;
    this.beforeScreensaver = { preset: viz.presetId, auto: viz.auto, view: this.view, minimized: this.wm.minimized };
    this.menus.close();
    this.notify.hideBalloon();
    this.notify.closeModal();
    if (this.wm.minimized) this.wm.open();
    this.setView('now-playing');
    viz.setAuto(true);
    this.stage.classList.add('pseudo-fullscreen', 'screensaver');
  }

  private stopScreensaver(preview: boolean) {
    const before = this.beforeScreensaver;
    this.beforeScreensaver = null;
    this.stage.classList.remove('pseudo-fullscreen', 'screensaver', 'idle');
    if (!before) return;
    if (!before.auto) this.viz?.setPreset(before.preset);
    this.setView(before.view);
    if (before.minimized) this.wm.minimize();
    if (preview) this.showScreensaverSettings();
  }

  private showScreensaverSettings() {
    const body = document.createElement('div');
    body.className = 'saver-settings';
    body.innerHTML = `
      <div class="saver-monitor"><div class="saver-screen"><span></span></div><div class="saver-stand"></div></div>
      <fieldset class="group-box">
        <legend>Screen saver</legend>
        <label class="saver-row"><input type="checkbox" id="saver-on" /> Start Alchemy in full screen when I'm away</label>
        <div class="saver-row">
          <label for="saver-minutes">Wait:</label>
          <select id="saver-minutes" class="xp-select"></select>
          <span>minutes</span>
          <button class="xp-btn" data-cmd="screensaver-preview">Preview</button>
        </div>
      </fieldset>
      <p class="hint">Starts only while music is playing. Move the mouse or press a key to get back to where you were.
        Browsers allow real full screen only after a click, so it fills this browser window; switch the browser to
        full screen (F11, or Ctrl+Cmd+F on a Mac) or install the app to cover the whole screen.</p>`;

    const on = $<HTMLInputElement>('#saver-on', body);
    const minutes = $<HTMLSelectElement>('#saver-minutes', body);
    const screen = $('.saver-screen', body);
    for (const m of SCREENSAVER_MINUTES) minutes.append(new Option(String(m), String(m)));
    const sync = () => {
      on.checked = this.settings.screensaver;
      minutes.value = String(this.settings.screensaverMinutes);
      minutes.disabled = !this.settings.screensaver;
      screen.classList.toggle('off', !this.settings.screensaver);
    };
    on.addEventListener('change', () => {
      this.settings.screensaver = on.checked;
      this.save();
      sync();
    });
    minutes.addEventListener('change', () => {
      this.settings.screensaverMinutes = Number(minutes.value);
      this.save();
    });
    sync();
    this.notify.showModal('Screen Saver', body);
  }

  // ---------- Clip recording ----------

  private toggleRecording() {
    if (this.clips.recording) this.clips.stop();
    else this.startRecording();
  }

  private startRecording() {
    if (!this.viz || !ClipRecorder.supported() || this.clips.recording) return;
    if (this.engine.state !== 'playing') {
      this.notify.showBalloon($('#btn-play'), 'Nothing to record', 'Start some music first, then record a clip.', 5);
      return;
    }
    this.setView('now-playing');
    const audio = this.settings.clipAudio ? this.engine.recordingStream() : null;
    try {
      this.clips.start(
        this.settings.clipFormat,
        this.settings.clipSeconds,
        audio,
        this.settings.clipCaption ? () => this.clipCaption() : null,
      );
    } catch (err) {
      console.error('Could not start recording', err);
      this.notify.showBalloon($('#vis-name'), 'Could not record', 'This browser refused to record the visualization.', 6);
      return;
    }
    this.showRecording(true);
    this.tick();
  }

  private showRecording(on: boolean) {
    $('#rec-badge').hidden = !on;
    this.stage.classList.toggle('recording', on);
    for (const btn of $$('.rec-btn')) {
      btn.setAttribute('aria-pressed', String(on));
      btn.title = on ? 'Stop recording (V)' : 'Record a clip (V)';
    }
  }

  /** The song shown in the clip: Spotify's track for live inputs, the file name for files. */
  private clipCaption(): ClipCaption | null {
    const track = this.spotifyTrack();
    if (track) return { title: track.title, subtitle: track.artists };
    const e = this.engine;
    if (e.kind === 'file' || e.kind === 'demo') return { title: e.label, subtitle: '' };
    return null;
  }

  private onClipDone(clip: Clip) {
    this.showRecording(false);
    if (clip.blob.size === 0) {
      this.notify.showBalloon($('#vis-name'), 'Nothing recorded', 'The clip came out empty. Try again with the visualization on screen.', 6);
      return;
    }
    const url = URL.createObjectURL(clip.blob);
    const format = CLIP_FORMATS[this.settings.clipFormat];
    const caption = this.clipCaption()?.title ?? '';
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
    const name = `XP Media Visualizer ${stamp}${caption ? ` - ${caption}` : ''}`.replace(/[\\/:*?"<>|]+/g, ' ').trim();

    const body = document.createElement('div');
    body.className = 'clip-ready';
    body.innerHTML = `
      <video class="clip-preview" controls playsinline></video>
      <p class="clip-info"></p>
      <div class="clip-actions"><a class="xp-btn">Save Clip</a></div>
      <p class="hint">Format and length are under Tools &gt; Record Clip... Full screen gives the sharpest picture.</p>`;
    const video = $<HTMLVideoElement>('video', body);
    video.src = url;
    video.style.aspectRatio = `${format.width} / ${format.height}`;
    const save = $<HTMLAnchorElement>('a', body);
    save.href = url;
    save.download = `${name}.${clip.extension}`;
    const mb = (clip.blob.size / 1_048_576).toFixed(1);
    $('.clip-info', body).textContent =
      `${Math.round(clip.seconds)} seconds, ${format.name} (${format.width} \u00d7 ${format.height}), ${clip.extension.toUpperCase()}, ${mb} MB`;

    this.notify.showModal('Clip Ready', body);
    // Free the video once the dialog is closed (or replaced by another one).
    const modal = $<HTMLDialogElement>('#modal');
    const release = () => {
      if (body.isConnected && modal.open) return;
      video.pause();
      URL.revokeObjectURL(url);
      modal.removeEventListener('close', release);
    };
    modal.addEventListener('close', release);
  }

  private showRecordSettings() {
    const body = document.createElement('div');
    body.className = 'record-settings';
    const formats = (Object.keys(CLIP_FORMATS) as ClipFormat[])
      .map((id) => {
        const f = CLIP_FORMATS[id];
        return `<label class="clip-format"><input type="radio" name="clip-format" value="${id}" />
          <span class="clip-shape" style="aspect-ratio: ${f.width} / ${f.height}"></span>
          <span><b>${f.name}</b><small>${f.width} \u00d7 ${f.height}</small></span></label>`;
      })
      .join('');
    body.innerHTML = `
      <fieldset class="group-box">
        <legend>Format</legend>
        <div class="clip-formats">${formats}</div>
      </fieldset>
      <fieldset class="group-box">
        <legend>Options</legend>
        <div class="saver-row"><label for="clip-seconds">Length: up to</label><select id="clip-seconds" class="xp-select"></select><span>seconds</span></div>
        <label class="saver-row"><input type="checkbox" id="clip-caption" /> Show the song title in the clip</label>
        <label class="saver-row"><input type="checkbox" id="clip-audio" /> Include the sound</label>
      </fieldset>
      <p class="hint">The clip is made from the visualization on screen, cropped to the format, so full screen gives the
        sharpest picture. The sound is what the visualizer hears: with the microphone that's the room. Press V or click
        REC to stop early.</p>
      <div class="clip-actions"><button class="xp-btn" data-cmd="record-start">Start Recording</button></div>`;

    for (const radio of $$<HTMLInputElement>('input[name="clip-format"]', body)) {
      radio.checked = radio.value === this.settings.clipFormat;
      radio.addEventListener('change', () => {
        this.settings.clipFormat = radio.value as ClipFormat;
        this.save();
      });
    }
    const seconds = $<HTMLSelectElement>('#clip-seconds', body);
    for (const n of CLIP_SECONDS) seconds.append(new Option(String(n), String(n)));
    seconds.value = String(this.settings.clipSeconds);
    seconds.addEventListener('change', () => {
      this.settings.clipSeconds = Number(seconds.value);
      this.save();
    });
    const caption = $<HTMLInputElement>('#clip-caption', body);
    caption.checked = this.settings.clipCaption;
    caption.addEventListener('change', () => {
      this.settings.clipCaption = caption.checked;
      this.save();
    });
    const audio = $<HTMLInputElement>('#clip-audio', body);
    audio.checked = this.settings.clipAudio;
    audio.addEventListener('change', () => {
      this.settings.clipAudio = audio.checked;
      this.save();
    });
    $<HTMLButtonElement>('[data-cmd="record-start"]', body).disabled = !this.viz || !ClipRecorder.supported();
    this.notify.showModal('Record Clip', body);
  }

  // ---------- Dialogs ----------

  private showAbout() {
    this.notify.showModal(
      'About XP Media Visualizer',
      `<div class="about-head"><img src="./icon.svg" width="48" height="48" alt=""><div><b>XP Media Visualizer</b>Version 1.0</div></div>
       <p>A love letter to the Windows Media Player visualizations of the early 2000s (Alchemy, Ambience, Bars and Waves, Battery), rebuilt as real-time 3D scenes with three.js and WebGL.</p>
       <p>Audio is analysed locally in your browser. Nothing is recorded or uploaded.</p>
       <p style="color:#555">Fan project, not affiliated with or endorsed by Microsoft. Windows and Windows Media are trademarks of Microsoft Corporation.</p>`,
    );
  }

  private showShortcuts() {
    const rows: [string, string][] = [
      ['Space or K', 'Play / pause'],
      ['S', 'Stop'],
      ['Left / Right', 'Previous / next visualization'],
      ['1 to 9', 'Pick a visualization from the playlist'],
      ['R', 'Shuffle visualizations (Alchemy)'],
      ['F or double-click', 'Full screen'],
      ['M', 'Mute'],
      ['I', 'Show the song title in full screen'],
      ['C', 'Classic Mode (2003 look)'],
      ['D', 'React to drops and new sections'],
      ['V', 'Record a clip / stop recording'],
      ['Ctrl+1 / Ctrl+2', 'Full mode / skin mode'],
      ['Ctrl+3', 'Pop out the player (stays on top of other apps)'],
      ['Up / Down', 'Volume (files and demo)'],
      ['Ctrl+O', 'Open audio files'],
    ];
    const table = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
    this.notify.showModal('Keyboard Shortcuts', `<table>${table}</table>`);
  }

  private showSpotifyHelp() {
    this.notify.showModal(
      'Using with Spotify',
      `<ol>
        <li><b>Easiest:</b> play Spotify on your speakers and choose <i>Microphone</i>. Turn it up a bit; if bars stay low, raise Sensitivity in Radio Tuner.</li>
        <li><b>Best quality (Chrome or Edge):</b> open open.spotify.com in another tab, start a song, then choose <i>Browser tab audio</i>, pick that tab and switch on "Share tab audio". You keep hearing it normally.</li>
        <li><b>Spotify desktop app, no mic:</b> install a loopback driver such as BlackHole, send Spotify's output to it (a Multi-Output Device keeps your speakers working), then select BlackHole as the input device in Radio Tuner.</li>
      </ol>`,
    );
  }

  private showWebGLError() {
    const view = $('.view[data-view="now-playing"]');
    const msg = document.createElement('div');
    msg.className = 'start-screen';
    msg.innerHTML = `<div class="xp-dialog start-dialog"><div class="title-bar small"><div class="title-bar-text">Visualizations unavailable</div></div><div class="dialog-body"><p>This browser could not start WebGL 2, which the 3D visualizations need. Try an up-to-date Chrome, Edge, Firefox or Safari with hardware acceleration enabled.</p></div></div>`;
    view.append(msg);
  }

  private updateClock() {
    $('#clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  private save() {
    saveSettings(this.settings);
  }
}
