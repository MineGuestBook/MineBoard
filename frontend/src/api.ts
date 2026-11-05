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

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers || {});
  const token = getStoredToken();
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  headers.set('X-Origin-Fingerprint', getClientFingerprint());

  const res = await fetch(path, {
    ...init,
    headers,
    credentials: 'include',
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `Erro HTTP ${res.status}`);
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
