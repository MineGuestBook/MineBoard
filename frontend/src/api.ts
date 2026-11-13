export interface ThemeConfig {
  background_color?: string;
  card_background?: string;
  text_color?: string;
  accent_color?: string;
  font_family?: string;
}

export interface Profile {
  id: string;
  user_id: string;
  username: string;
  display_name: string;
  bio: string | null;
  avatar_url: string | null;
  theme_config: ThemeConfig | null;
  created_at: string;
  updated_at: string;
}

export interface CommentItem {
  id: string;
  profile_id: string;
  author_name: string;
  author_email: string | null;
  content: string;
  likes_count: number;
  liked_by_me: boolean;
  created_at: string;
}

export interface AuthUser {
  id: string;
  email: string;
  auth_provider: 'local' | 'google' | 'apple';
  has_password: boolean;
  created_at: string;
}

const SESSION_STORAGE_KEY = 'guestbook_session_token';
const FINGERPRINT_STORAGE_KEY = 'guestbook_origin_fingerprint';
const AUTH_SNAPSHOT_STORAGE_KEY = 'guestbook_auth_snapshot_v1';
const PROFILE_CACHE_STORAGE_KEY = 'guestbook_profiles_cache_v1';

const envMeta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env || {};
export const CONFIGURED_ROOT_DOMAIN = (envMeta.VITE_ROOT_DOMAIN || 'nicolaspitz.dev').toLowerCase();

export interface AuthSnapshot {
  user: AuthUser;
  profile: Profile | null;
}

export interface CachedProfileEntry {
  profile: Profile;
  comments: CommentItem[];
  updatedAt: number;
}

export function getStoredAuthSnapshot(): AuthSnapshot | null {
  try {
    const raw = localStorage.getItem(AUTH_SNAPSHOT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthSnapshot;
    if (!parsed || !parsed.user || !parsed.user.id) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function setStoredAuthSnapshot(snapshot: AuthSnapshot | null): void {
  try {
    if (snapshot) {
      localStorage.setItem(AUTH_SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshot));
      if (snapshot.profile) {
        const existing = getCachedProfileEntry(snapshot.profile.username);
        setCachedProfileEntry(snapshot.profile.username, {
          profile: snapshot.profile,
          comments: existing?.comments || [],
        });
      }
    } else {
      localStorage.removeItem(AUTH_SNAPSHOT_STORAGE_KEY);
    }
  } catch {
    // ignore storage errors
  }
}

function readProfileCacheMap(): Record<string, CachedProfileEntry> {
  try {
    const raw = localStorage.getItem(PROFILE_CACHE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, CachedProfileEntry>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeProfileCacheMap(map: Record<string, CachedProfileEntry>): void {
  try {
    const entries = Object.entries(map)
      .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))
      .slice(0, 15);
    localStorage.setItem(PROFILE_CACHE_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // ignore storage errors
  }
}

export function getCachedProfileEntry(username: string): CachedProfileEntry | null {
  const key = username.trim().toLowerCase();
  const map = readProfileCacheMap();
  return map[key] || null;
}

export function setCachedProfileEntry(
  username: string,
  data: { profile: Profile; comments: CommentItem[] }
): void {
  const key = username.trim().toLowerCase();
  const map = readProfileCacheMap();
  map[key] = {
    profile: data.profile,
    comments: data.comments.slice(0, 50),
    updatedAt: Date.now(),
  };
  writeProfileCacheMap(map);
}

export function removeCachedProfileEntry(username: string): void {
  const key = username.trim().toLowerCase();
  const map = readProfileCacheMap();
  if (key in map) {
    delete map[key];
    writeProfileCacheMap(map);
  }
}

export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredToken(token: string | null): void {
  try {
    if (token) {
      localStorage.setItem(SESSION_STORAGE_KEY, token);
    } else {
      localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  } catch {
    // ignore storage errors
  }
}

export function getClientFingerprint(): string {
  try {
    let fp = localStorage.getItem(FINGERPRINT_STORAGE_KEY);
    if (!fp) {
      fp = `fp-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
      localStorage.setItem(FINGERPRINT_STORAGE_KEY, fp);
    }
    return fp;
  } catch {
    return 'fp-anonymous';
  }
}

function resolveApiBase(): string {
  if (typeof window === 'undefined') return '';
  if (envMeta.VITE_API_BASE_URL) {
    return envMeta.VITE_API_BASE_URL.replace(/\/+$/, '');
  }
  const host = window.location.hostname.toLowerCase();
  if (host.endsWith('.pages.dev')) {
    return host.includes('-prod')
      ? `https://preview-prod.${CONFIGURED_ROOT_DOMAIN}`
      : `https://dev.${CONFIGURED_ROOT_DOMAIN}`;
  }
  return '';
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers || {});
  const token = getStoredToken();
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  headers.set('X-Origin-Fingerprint', getClientFingerprint());

  const method = (init.method || 'GET').toUpperCase();
  const isSmallMutation =
    method !== 'GET' &&
    method !== 'HEAD' &&
    !(typeof FormData !== 'undefined' && init.body instanceof FormData);

  const url = path.startsWith('http') ? path : `${resolveApiBase()}${path}`;
  const res = await fetch(url, {
    ...init,
    headers,
    credentials: 'include',
    keepalive: init.keepalive ?? isSmallMutation,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError((data as { error?: string }).error || `Erro HTTP ${res.status}`, res.status);
  }
  return data as T;
}

export const api = {
  getHostProfile() {
    return apiFetch<{
      mode: 'root' | 'subdomain';
      profile?: Profile;
      comments?: CommentItem[];
      error?: string;
    }>('/api/host-profile');
  },

  listProfiles(query = '', page = 1) {
    const params = new URLSearchParams({ page: String(page), limit: '20' });
    if (query.trim()) params.set('q', query.trim());
    return apiFetch<{ profiles: Profile[] }>(`/api/profiles?${params.toString()}`);
  },

  getProfile(username: string) {
    return apiFetch<{ profile: Profile; comments: CommentItem[] }>(
      `/api/profiles/${encodeURIComponent(username)}`
    );
  },

  register(payload: {
    email: string;
    username: string;
    display_name: string;
    password: string;
    bio?: string;
  }) {
    return apiFetch<{
      message: string;
      profile: Profile;
      session_token?: string;
    }>('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },

  login(email: string, password: string) {
    return apiFetch<{
      message: string;
      user: AuthUser;
      profile: Profile | null;
      session_token: string;
    }>('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  },

  logout() {
    return apiFetch<{ message: string }>('/api/auth/logout', { method: 'POST' });
  },

  getMe() {
    return apiFetch<{ authenticated: boolean; user: AuthUser; profile: Profile | null }>(
      '/api/auth/me'
    );
  },

  updateProfile(
    username: string,
    payload: {
      display_name?: string;
      bio?: string;
      avatar_url?: string;
      theme_config?: ThemeConfig;
    }
  ) {
    return apiFetch<{ message: string; profile: Profile }>(
      `/api/profiles/${encodeURIComponent(username)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );
  },

  uploadAvatar(username: string, file: File) {
    const form = new FormData();
    form.append('avatar', file);
    return apiFetch<{ message: string; avatar_url: string }>(
      `/api/profiles/${encodeURIComponent(username)}/avatar`,
      {
        method: 'POST',
        body: form,
      }
    );
  },

  deleteAccount(username: string) {
    return apiFetch<{ message: string; deleted_comments_count: number }>(
      `/api/profiles/${encodeURIComponent(username)}`,
      { method: 'DELETE' }
    );
  },

  changePassword(currentPassword: string, newPassword: string) {
    return apiFetch<{ message: string }>('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    });
  },

  forgotPassword(email: string) {
    return apiFetch<{ message: string }>('/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
  },

  resetPassword(token: string, newPassword: string) {
    return apiFetch<{ message: string }>('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, new_password: newPassword }),
    });
  },

  postComment(
    username: string,
    payload: { author_name?: string; author_email?: string; content: string }
  ) {
    return apiFetch<{ message: string; comment: CommentItem }>(
      `/api/profiles/${encodeURIComponent(username)}/comments`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );
  },

  toggleLike(commentId: string, currentlyLiked: boolean) {
    return apiFetch<{ likes_count: number; liked_by_me: boolean }>(
      `/api/comments/${encodeURIComponent(commentId)}/like`,
      { method: currentlyLiked ? 'DELETE' : 'POST' }
    );
  },

  deleteComment(commentId: string) {
    return apiFetch<{ message: string }>(`/api/comments/${encodeURIComponent(commentId)}`, {
      method: 'DELETE',
    });
  },
};
