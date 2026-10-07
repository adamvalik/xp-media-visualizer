/**
 * Read-only "Now Playing" from the Spotify Web API.
 *
 * Uses the Authorization Code flow with PKCE, so it runs entirely in the
 * browser with just a Client ID (no secret, no server). Only the
 * currently-playing scopes are requested.
 */

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_URL = 'https://api.spotify.com/v1/me/player/currently-playing';
const SCOPES = 'user-read-currently-playing user-read-playback-state';

const TOKEN_KEY = 'xp-media-visualizer.spotify.token';
const CLIENT_KEY = 'xp-media-visualizer.spotify.client';
const PENDING_KEY = 'xp-media-visualizer.spotify.pending';

const POLL_MS = 4000;

export interface SpotifyTrack {
  id: string;
  title: string;
  artists: string;
  album: string;
  imageUrl: string;
  durationMs: number;
  progressMs: number;
  isPlaying: boolean;
  /** performance.now() when progressMs was measured. */
  measuredAt: number;
}

export type SpotifyStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

interface StoredToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface PendingLogin {
  verifier: string;
  state: string;
  clientId: string;
}

const read = <T>(key: string): T | null => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') as T | null;
  } catch {
    return null;
  }
};

const write = (key: string, value: unknown) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Without storage the login simply won't survive a reload.
  }
};

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const randomString = (length: number) => base64url(crypto.getRandomValues(new Uint8Array(length))).slice(0, length);

/** The page itself is the redirect target: origin + path, without query or hash. */
export const redirectUri = () => `${location.origin}${location.pathname}`;

export class SpotifyClient extends EventTarget {
  status: SpotifyStatus = 'disconnected';
  error = '';
  track: SpotifyTrack | null = null;
  private token: StoredToken | null = read<StoredToken>(TOKEN_KEY);
  private timer = 0;
  private polling = false;

  get clientId(): string {
    return read<string>(CLIENT_KEY) || (import.meta.env.VITE_SPOTIFY_CLIENT_ID as string | undefined) || '';
  }

  set clientId(id: string) {
    write(CLIENT_KEY, id.trim() || null);
  }

  get connected() {
    return this.status === 'connected';
  }

  /** Estimated playback position right now, interpolated between polls. */
  get progressMs() {
    const t = this.track;
    if (!t) return 0;
    const elapsed = t.isPlaying ? performance.now() - t.measuredAt : 0;
    return Math.min(t.durationMs, t.progressMs + elapsed);
  }

  /** Call once on startup: finishes a login redirect if there is one, then starts polling. */
  async init() {
    const params = new URLSearchParams(location.search);
    const code = params.get('code');
    const state = params.get('state');
    const authError = params.get('error');
    if (code || authError) {
      history.replaceState(null, '', redirectUri() + location.hash);
      const pending = read<PendingLogin>(PENDING_KEY);
      write(PENDING_KEY, null);
      if (authError) return this.fail(authError === 'access_denied' ? 'Spotify access was declined.' : `Spotify login failed (${authError}).`);
      if (!pending || pending.state !== state) return this.fail('Spotify login expired. Please connect again.');
      this.setStatus('connecting');
      try {
        await this.requestToken({
          grant_type: 'authorization_code',
          code: code!,
          redirect_uri: redirectUri(),
          client_id: pending.clientId,
          code_verifier: pending.verifier,
        });
      } catch (err) {
        return this.fail((err as Error).message);
      }
    }
    if (this.token) {
      this.setStatus('connected');
      this.startPolling();
    }
  }

  /** Redirects to Spotify's consent page. */
  async connect() {
    const clientId = this.clientId;
    if (!clientId) return this.fail('Enter your Spotify Client ID first.');
    const verifier = randomString(64);
    const state = randomString(16);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    write(PENDING_KEY, { verifier, state, clientId } satisfies PendingLogin);
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      scope: SCOPES,
      redirect_uri: redirectUri(),
      code_challenge_method: 'S256',
      code_challenge: base64url(new Uint8Array(digest)),
      state,
    }).toString();
    location.assign(url.toString());
  }

  disconnect() {
    this.stopPolling();
    this.token = null;
    write(TOKEN_KEY, null);
    this.error = '';
    this.setTrack(null);
    this.setStatus('disconnected');
  }

  private startPolling() {
    if (this.polling) return;
    this.polling = true;
    document.addEventListener('visibilitychange', this.onVisibility);
    void this.poll();
  }

  private stopPolling() {
    this.polling = false;
    window.clearTimeout(this.timer);
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  private onVisibility = () => {
    if (document.visibilityState === 'visible' && this.polling) {
      window.clearTimeout(this.timer);
      void this.poll();
    }
  };

  private schedule(ms: number) {
    window.clearTimeout(this.timer);
    if (this.polling) this.timer = window.setTimeout(() => void this.poll(), ms);
  }

  private async poll() {
    if (!this.polling) return;
    if (document.visibilityState === 'hidden') return; // resumes on visibilitychange
    try {
      const res = await this.api(API_URL);
      if (res.status === 204) {
        this.setTrack(null);
        return this.schedule(POLL_MS * 2);
      }
      if (res.status === 429) {
        const retry = Number(res.headers.get('Retry-After') ?? 10);
        return this.schedule(Math.max(5, retry) * 1000);
      }
      if (!res.ok) throw new Error(`Spotify returned ${res.status}.`);
      this.setTrack(parseTrack(await res.json()));
      if (this.status !== 'connected') this.setStatus('connected');
      // Poll right after the current song should end so the new title shows promptly.
      const t = this.track;
      const remaining = t?.isPlaying ? t.durationMs - t.progressMs + 600 : Infinity;
      this.schedule(Math.min(POLL_MS, Math.max(800, remaining)));
    } catch (err) {
      if (!this.token) return;
      this.error = (err as Error).message;
      this.schedule(POLL_MS * 3);
    }
  }

  private async api(url: string, retried = false): Promise<Response> {
    if (!this.token) throw new Error('Not connected to Spotify.');
    if (Date.now() > this.token.expiresAt - 60_000) await this.refresh();
    const res = await fetch(url, { headers: { Authorization: `Bearer ${this.token!.accessToken}` } });
    if (res.status === 401 && !retried) {
      await this.refresh();
      return this.api(url, true);
    }
    return res;
  }

  private async refresh() {
    if (!this.token) return;
    try {
      await this.requestToken({
        grant_type: 'refresh_token',
        refresh_token: this.token.refreshToken,
        client_id: this.clientId,
      });
    } catch (err) {
      this.disconnect();
      this.fail(`Spotify session ended: ${(err as Error).message} Please connect again.`);
      throw err;
    }
  }

  private async requestToken(body: Record<string, string>) {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(String(json.error_description ?? json.error ?? `Token request failed (${res.status}).`));
    this.token = {
      accessToken: String(json.access_token),
      // Spotify may rotate the refresh token; keep the old one if it doesn't.
      refreshToken: String(json.refresh_token ?? this.token?.refreshToken ?? ''),
      expiresAt: Date.now() + Number(json.expires_in ?? 3600) * 1000,
    };
    write(TOKEN_KEY, this.token);
  }

  private setTrack(track: SpotifyTrack | null) {
    const changed = track?.id !== this.track?.id || track?.isPlaying !== this.track?.isPlaying;
    this.track = track;
    this.dispatchEvent(new CustomEvent('track', { detail: { changed } }));
  }

  private setStatus(status: SpotifyStatus) {
    this.status = status;
    if (status !== 'error') this.error = '';
    this.dispatchEvent(new Event('status'));
  }

  private fail(message: string) {
    this.error = message;
    this.status = 'error';
    this.dispatchEvent(new Event('status'));
  }
}

interface ApiImage {
  url: string;
  width: number | null;
}

function parseTrack(json: Record<string, any>): SpotifyTrack | null {
  const item = json?.item;
  if (!item) return null;
  // Podcasts episodes have a show instead of artists/album.
  const artists = Array.isArray(item.artists) ? item.artists.map((a: { name: string }) => a.name).join(', ') : item.show?.name ?? '';
  const images: ApiImage[] = item.album?.images ?? item.images ?? [];
  const image = [...images].sort((a, b) => (a.width ?? 0) - (b.width ?? 0)).find((i) => (i.width ?? 0) >= 200) ?? images[0];
  return {
    id: String(item.id ?? item.uri ?? item.name),
    title: String(item.name ?? 'Unknown title'),
    artists,
    album: String(item.album?.name ?? item.show?.name ?? ''),
    imageUrl: image?.url ?? '',
    durationMs: Number(item.duration_ms ?? 0),
    progressMs: Number(json.progress_ms ?? 0),
    isPlaying: Boolean(json.is_playing),
    measuredAt: performance.now(),
  };
}
