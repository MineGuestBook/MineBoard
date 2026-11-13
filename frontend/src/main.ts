import {
  api,
  ApiError,
  AuthUser,
  CommentItem,
  CONFIGURED_ROOT_DOMAIN,
  getCachedProfileEntry,
  getStoredAuthSnapshot,
  getStoredToken,
  Profile,
  removeCachedProfileEntry,
  setCachedProfileEntry,
  setStoredAuthSnapshot,
  setStoredToken,
  ThemeConfig,
} from './api';

type ViewMode =
  | { type: 'home' }
  | { type: 'auth' }
  | { type: 'dashboard' }
  | { type: 'reset'; token: string }
  | { type: 'profile'; username: string; fromSubdomain?: boolean };

interface CommentDraft {
  author_name: string;
  author_email: string;
  content: string;
}

interface AppState {
  view: ViewMode;
  currentUser: AuthUser | null;
  myProfile: Profile | null;
  profiles: Profile[];
  searchQuery: string;
  activeProfile: Profile | null;
  activeComments: CommentItem[];
  commentDraft: CommentDraft | null;
  flashMessage: { text: string; isError?: boolean } | null;
}

const initialSnapshot = getStoredAuthSnapshot();

const state: AppState = {
  view: { type: 'home' },
  currentUser: initialSnapshot?.user ?? null,
  myProfile: initialSnapshot?.profile ?? null,
  profiles: [],
  searchQuery: '',
  activeProfile: null,
  activeComments: [],
  commentDraft: null,
  flashMessage: null,
};

let flashTimer: ReturnType<typeof setTimeout> | null = null;

// Rastreia comentários recém-criados de forma otimista cujo ID real do MongoDB ainda está a caminho,
// permitindo enfileirar likes/exclusões clicados no mesmo segundo sem falhar.
const pendingCommentActions = new Map<
  string,
  { desiredLiked?: boolean; deleted?: boolean }
>();

const FONT_OPTIONS = [
  'Courier New',
  'monospace',
  'Times New Roman',
  'Verdana',
  'Georgia',
  'Tahoma',
  'serif',
  'sans-serif',
];

function escapeAttr(val: string | null | undefined): string {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function setFlash(text: string, isError = false, autoHideMs = 5000): void {
  if (flashTimer) {
    clearTimeout(flashTimer);
    flashTimer = null;
  }
  state.flashMessage = { text, isError };
  render();
  if (autoHideMs > 0) {
    flashTimer = setTimeout(() => {
      state.flashMessage = null;
      flashTimer = null;
      render();
    }, autoHideMs);
  }
}

function navigate(path: string): void {
  window.history.pushState({}, '', path);
  void handleRoute();
}

function syncCurrentProfileCache(): void {
  if (state.activeProfile) {
    setCachedProfileEntry(state.activeProfile.username, {
      profile: state.activeProfile,
      comments: state.activeComments,
    });
  }
}

function findInstantProfile(username: string): { profile: Profile; comments: CommentItem[] } | null {
  const normalized = username.trim().toLowerCase();
  const cached = getCachedProfileEntry(normalized);
  if (cached) {
    if (state.myProfile && state.myProfile.username.toLowerCase() === normalized) {
      return { profile: state.myProfile, comments: cached.comments };
    }
    return { profile: cached.profile, comments: cached.comments };
  }
  if (state.myProfile && state.myProfile.username.toLowerCase() === normalized) {
    return { profile: state.myProfile, comments: [] };
  }
  const fromSearch = state.profiles.find((p) => p.username.toLowerCase() === normalized);
  if (fromSearch) {
    return { profile: fromSearch, comments: [] };
  }
  return null;
}

async function refreshSession(): Promise<void> {
  const isBaseHost =
    window.location.hostname === 'localhost' ||
    window.location.hostname.endsWith('.pages.dev') ||
    window.location.hostname.endsWith('.workers.dev');
  // Se estiver em domínio sem cookie cross-subdomain e não houver token salvo no localStorage,
  // evita uma chamada HTTP desnecessária ao /api/auth/me
  if (isBaseHost && !getStoredToken() && !document.cookie) {
    state.currentUser = null;
    state.myProfile = null;
    setStoredAuthSnapshot(null);
    return;
  }
  try {
    const me = await api.getMe();
    const changed =
      JSON.stringify(state.currentUser) !== JSON.stringify(me.user) ||
      JSON.stringify(state.myProfile) !== JSON.stringify(me.profile);
    state.currentUser = me.user;
    state.myProfile = me.profile;
    setStoredAuthSnapshot({ user: me.user, profile: me.profile });
    if (changed) render();
  } catch (err) {
    // Só limpa o snapshot otimista se o servidor explicitamente rejeitar a sessão (401);
    // em caso de falha de rede passageira, preserva o estado local.
    if (err instanceof ApiError && err.status === 401) {
      const wasLogged = !!state.currentUser;
      setStoredToken(null);
      setStoredAuthSnapshot(null);
      state.currentUser = null;
      state.myProfile = null;
      if (state.view.type === 'dashboard') {
        state.view = { type: 'auth' };
        setFlash('Sua sessão expirou. Faça login novamente.', true);
      } else if (wasLogged) {
        render();
      }
    }
  }
}

async function loadProfileView(username: string, fromSubdomain = false): Promise<void> {
  const normalized = username.trim().toLowerCase();
  const instant = findInstantProfile(normalized);

  // Renderização instantânea (0ms) se o perfil já for conhecido localmente (Stale-While-Revalidate)
  if (instant) {
    state.activeProfile = instant.profile;
    state.activeComments = instant.comments;
    state.view = { type: 'profile', username: instant.profile.username, fromSubdomain };
    render();
  }

  try {
    const data = await api.getProfile(username);
    // Preserva eventuais comentários otimistas que ainda estejam aguardando resposta do POST
    const pendingOptimistic = state.activeComments.filter((c) => pendingCommentActions.has(c.id));
    const mergedComments = [
      ...pendingOptimistic,
      ...data.comments.filter((c) => !pendingOptimistic.some((opt) => opt.id === c.id)),
    ];

    setCachedProfileEntry(data.profile.username, {
      profile: data.profile,
      comments: mergedComments,
    });

    if (
      !instant ||
      (state.view.type === 'profile' && state.view.username.toLowerCase() === normalized)
    ) {
      state.activeProfile = data.profile;
      state.activeComments = mergedComments;
      state.view = { type: 'profile', username: data.profile.username, fromSubdomain };
      render();
    }
  } catch (err) {
    if (!instant || (err instanceof ApiError && err.status === 404)) {
      removeCachedProfileEntry(normalized);
      state.view = { type: 'home' };
      setFlash(err instanceof Error ? err.message : 'Perfil não encontrado.', true);
    }
  }
}

async function handleRoute(): Promise<void> {
  const url = new URL(window.location.href);
  const path = url.pathname;

  if (path === '/reset-password') {
    const token = url.searchParams.get('token') || '';
    state.view = { type: 'reset', token };
    render();
    return;
  }

  if (path.startsWith('/u/')) {
    const username = decodeURIComponent(path.slice(3).split('/')[0] || '');
    if (username) {
      await loadProfileView(username, false);
      return;
    }
  }

  if (path === '/dashboard') {
    if (!state.currentUser) {
      state.view = { type: 'auth' };
    } else {
      state.view = { type: 'dashboard' };
    }
    render();
    return;
  }

  if (path === '/login') {
    state.view = { type: 'auth' };
    render();
    return;
  }

  const hostname = window.location.hostname.toLowerCase();
  const isBaseDomain =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === CONFIGURED_ROOT_DOMAIN ||
    hostname === `www.${CONFIGURED_ROOT_DOMAIN}` ||
    hostname === `dev.${CONFIGURED_ROOT_DOMAIN}` ||
    hostname === `preview-prod.${CONFIGURED_ROOT_DOMAIN}` ||
    hostname.endsWith('.pages.dev') ||
    hostname.endsWith('.workers.dev');

  if (path === '/' && !isBaseDomain) {
    const subCandidate = hostname.split('.')[0] || '';
    const instantSub = subCandidate ? findInstantProfile(subCandidate) : null;
    if (instantSub) {
      state.activeProfile = instantSub.profile;
      state.activeComments = instantSub.comments;
      state.view = { type: 'profile', username: instantSub.profile.username, fromSubdomain: true };
      render();
    }
    try {
      const hostInfo = await api.getHostProfile();
      if (hostInfo.mode === 'subdomain' && hostInfo.profile) {
        state.activeProfile = hostInfo.profile;
        state.activeComments = hostInfo.comments || [];
        syncCurrentProfileCache();
        state.view = { type: 'profile', username: hostInfo.profile.username, fromSubdomain: true };
        render();
        return;
      }
    } catch {
      if (instantSub) return;
      // fallback para portal raiz
    }
  }

  state.view = { type: 'home' };
  render();

  if (state.searchQuery.trim()) {
    const list = await api.listProfiles(state.searchQuery).catch(() => ({ profiles: [] }));
    state.profiles = list.profiles;
    render();
  } else {
    state.profiles = [];
  }
}

function buildThemeStyle(theme?: ThemeConfig | null): string {
  const t = theme || {};
  const vars: string[] = [];
  if (t.background_color) vars.push(`--profile-bg:${escapeAttr(t.background_color)}`);
  if (t.card_background) vars.push(`--profile-card:${escapeAttr(t.card_background)}`);
  if (t.text_color) vars.push(`--profile-text:${escapeAttr(t.text_color)}`);
  if (t.accent_color) vars.push(`--profile-accent:${escapeAttr(t.accent_color)}`);
  if (t.font_family) vars.push(`--profile-font:${escapeAttr(t.font_family)}`);
  return vars.join(';');
}

function renderAvatar(p: Profile): string {
  if (p.avatar_url) {
    return `<img class="avatar" src="${escapeAttr(p.avatar_url)}" alt="${escapeAttr(p.display_name)}" />`;
  }
  const initial = (p.username || '?').slice(0, 2).toUpperCase();
  return `<div class="avatar">[${escapeAttr(initial)}]</div>`;
}

function renderTopbar(): string {
  const userActions =
    state.currentUser && state.myProfile
      ? `
      <button class="btn" data-nav="/u/${escapeAttr(state.myProfile.username)}">Meu Mural (@${escapeAttr(state.myProfile.username)})</button>
      <button class="btn" data-nav="/dashboard">Configurações</button>
      <button class="btn btn-danger" id="btn-logout">Sair</button>
    `
      : `<button class="btn" data-nav="/login">Entrar / Cadastrar</button>`;

  return `
    <header class="topbar">
      <div class="brand" data-nav="/">[ MINEBOARD ]</div>
      <nav class="nav-actions">
        <button class="btn" data-nav="/">Início</button>
        ${userActions}
      </nav>
    </header>
  `;
}

function renderHomeView(): string {
  const hasSearch = state.searchQuery.trim().length > 0;
  const searchResultsHtml = hasSearch
    ? `
    <div class="grid-2" style="margin-top:14px">
      ${
        state.profiles.length
          ? state.profiles
              .map(
                (p) => `
              <div class="profile-card">
                ${renderAvatar(p)}
                <div style="flex:1">
                  <div><strong>${escapeAttr(p.display_name)}</strong> <span style="color:var(--muted-color)">@${escapeAttr(p.username)}</span></div>
                  <div style="font-size:0.82rem;color:var(--muted-color);margin:4px 0 8px">${escapeAttr(p.bio || 'Sem descrição.')}</div>
                  <button class="btn" data-nav="/u/${escapeAttr(p.username)}">Abrir mural -&gt;</button>
                </div>
              </div>
            `
              )
              .join('')
          : `<p>Nenhum perfil encontrado.</p>`
      }
    </div>
  `
    : '';

  return `
    <section class="panel">
      <h2>MineBoard — Diretório de Murais</h2>
      <p>Mural de recados retrô e minimalista. Visitantes podem assinar sem cadastro.</p>
      <form id="form-search" style="display:flex;gap:8px">
        <input type="text" id="input-search" value="${escapeAttr(state.searchQuery)}" placeholder="Buscar por @username ou nome..." style="flex:1;padding:6px 8px;background:#0d0d0d;color:var(--text-color);border:1px solid var(--border-color);font-family:inherit" />
        <button type="submit" class="btn">Buscar</button>
      </form>
      ${searchResultsHtml}
    </section>
  `;
}

function renderAuthView(): string {
  return `
    <div class="grid-2">
      <section class="panel">
        <h2>Criar Conta</h2>
        <form id="form-register">
          <div class="field">
            <label>Username (subdomínio)</label>
            <input type="text" name="username" required pattern="^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])?$" placeholder="joaosilva" />
          </div>
          <div class="field">
            <label>Nome</label>
            <input type="text" name="display_name" required placeholder="João Silva" />
          </div>
          <div class="field">
            <label>E-mail</label>
            <input type="email" name="email" required placeholder="voce@exemplo.com" />
          </div>
          <div class="field">
            <label>Senha (mín. 8 caracteres)</label>
            <input type="password" name="password" required minlength="8" />
          </div>
          <div class="field">
            <label>Bio (opcional)</label>
            <textarea name="bio" rows="2" placeholder="Deixe uma mensagem no meu mural."></textarea>
          </div>
          <button type="submit" class="btn">Cadastrar</button>
        </form>
      </section>

      <div>
        <section class="panel">
          <h2>Entrar</h2>
          <form id="form-login">
            <div class="field">
              <label>E-mail</label>
              <input type="email" name="email" required />
            </div>
            <div class="field">
              <label>Senha</label>
              <input type="password" name="password" required />
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button type="submit" class="btn">Entrar</button>
              <a class="btn" href="/api/auth/google">Login via Google</a>
            </div>
          </form>
        </section>

        <section class="panel">
          <h3>Recuperar Senha</h3>
          <form id="form-forgot">
            <div class="field">
              <label>E-mail cadastrado</label>
              <input type="email" name="email" required placeholder="voce@exemplo.com" />
            </div>
            <button type="submit" class="btn">Enviar Link</button>
          </form>
        </section>
      </div>
    </div>
  `;
}

function renderResetPasswordView(token: string): string {
  return `
    <section class="panel">
      <h2>Redefinir Senha</h2>
      <form id="form-reset-password">
        <div class="field">
          <label>Token</label>
          <input type="text" name="token" value="${escapeAttr(token)}" required />
        </div>
        <div class="field">
          <label>Nova Senha (mín. 8 caracteres)</label>
          <input type="password" name="new_password" required minlength="8" />
        </div>
        <button type="submit" class="btn">Salvar Senha</button>
      </form>
    </section>
  `;
}

function renderDashboardView(): string {
  const p = state.myProfile;
  if (!p) {
    return `<section class="panel"><p>Carregando...</p></section>`;
  }
  const t = p.theme_config || {};
  const origin = window.location.origin;
  const scriptSnippet = `<script src="${origin}/api/widget/${p.username}/embed.js" data-limit="10" async></script>`;
  const iframeSnippet = `<iframe src="${origin}/api/widget/${p.username}/frame" width="100%" height="420" style="border:0" loading="lazy"></iframe>`;

  return `
    <div class="grid-2">
      <section class="panel">
        <h2>Perfil e Tema</h2>
        <form id="form-edit-profile">
          <div class="field">
            <label>Nome</label>
            <input type="text" name="display_name" value="${escapeAttr(p.display_name)}" required />
          </div>
          <div class="field">
            <label>Biografia</label>
            <textarea name="bio" rows="3">${escapeAttr(p.bio || '')}</textarea>
          </div>
          <div class="grid-2">
            <div class="field">
              <label>Fundo</label>
              <input type="color" name="background_color" value="${escapeAttr(t.background_color || '#111111')}" />
            </div>
            <div class="field">
              <label>Painel</label>
              <input type="color" name="card_background" value="${escapeAttr(t.card_background || '#181818')}" />
            </div>
            <div class="field">
              <label>Texto</label>
              <input type="color" name="text_color" value="${escapeAttr(t.text_color || '#d4d4d4')}" />
            </div>
            <div class="field">
              <label>Borda / Destaque</label>
              <input type="color" name="accent_color" value="${escapeAttr(t.accent_color || '#cccccc')}" />
            </div>
          </div>
          <div class="field">
            <label>Fonte</label>
            <select name="font_family">
              ${FONT_OPTIONS.map(
                (f) => `<option value="${f}" ${t.font_family === f ? 'selected' : ''}>${f}</option>`
              ).join('')}
            </select>
          </div>
          <button type="submit" class="btn">Salvar</button>
        </form>

        <hr style="border:0;border-top:1px solid var(--border-color);margin:16px 0" />
        <h3>Avatar</h3>
        <form id="form-avatar">
          <div class="field">
            <input type="file" name="avatar" accept="image/png,image/jpeg,image/webp,image/gif" required />
          </div>
          <button type="submit" class="btn">Enviar Imagem</button>
        </form>
      </section>

      <div>
        <section class="panel">
          <h2>Widget Externo</h2>
          <p>Código para embutir o mural em outro site:</p>
          <div class="field">
            <label>Script (Web Component):</label>
            <div class="code-box" id="snippet-script">${escapeAttr(scriptSnippet)}</div>
            <div><button type="button" class="btn" id="btn-copy-script">Copiar Script</button></div>
          </div>
          <div class="field" style="margin-top:10px">
            <label>Iframe:</label>
            <div class="code-box" id="snippet-iframe">${escapeAttr(iframeSnippet)}</div>
            <div><button type="button" class="btn" id="btn-copy-iframe">Copiar Iframe</button></div>
          </div>
        </section>

        <section class="panel">
          <h3>Alterar Senha</h3>
          <form id="form-change-password">
            <div class="field">
              <label>Senha Atual</label>
              <input type="password" name="current_password" />
            </div>
            <div class="field">
              <label>Nova Senha (mín. 8 caracteres)</label>
              <input type="password" name="new_password" required minlength="8" />
            </div>
            <button type="submit" class="btn">Atualizar Senha</button>
          </form>
        </section>

        <section class="panel">
          <h3>Encerrar Conta</h3>
          <p>Remove sua conta, perfil e todos os recados.</p>
          <button type="button" class="btn btn-danger" id="btn-delete-account">Excluir Conta</button>
        </section>
      </div>
    </div>
  `;
}

function renderProfileView(): string {
  const p = state.activeProfile;
  if (!p) return `<section class="panel"><p>Perfil não encontrado.</p></section>`;

  const draft = state.commentDraft;
  const isOwner = state.myProfile && state.myProfile.username === p.username;
  const commentsHtml = state.activeComments.length
    ? state.activeComments
        .map(
          (c) => `
        <li class="comment-item">
          <div class="comment-meta">
            <span>
              <strong>${escapeAttr(c.author_name)}</strong>
              ${c.author_email ? `<span>&lt;${escapeAttr(c.author_email)}&gt;</span>` : ''}
              - ${new Date(c.created_at).toLocaleString('pt-BR')}
            </span>
            <span style="display:flex;gap:6px;align-items:center">
              <button class="btn btn-like" data-id="${escapeAttr(c.id)}" data-liked="${c.liked_by_me ? '1' : '0'}" style="padding:2px 8px;font-size:0.75rem">
                [${c.liked_by_me ? 'Curtido' : 'Curtir'}: ${c.likes_count}]
              </button>
              ${
                isOwner
                  ? `<button class="btn btn-danger btn-del-comment" data-id="${escapeAttr(c.id)}" style="padding:2px 8px;font-size:0.75rem">[Excluir]</button>`
                  : ''
              }
            </span>
          </div>
          <div class="comment-content">${escapeAttr(c.content)}</div>
        </li>
      `
        )
        .join('')
    : `<p>Nenhum recado publicado ainda.</p>`;

  return `
    <div class="guestbook-themed" style="${buildThemeStyle(p.theme_config)}">
      <section class="panel">
        <div class="profile-card" style="border:none;background:transparent;padding:0">
          ${renderAvatar(p)}
          <div>
            <h2 style="margin:0;border:0;padding:0">${escapeAttr(p.display_name)} <span style="font-size:0.85rem;color:var(--muted-color);text-transform:none">@${escapeAttr(p.username)}</span></h2>
            <p style="margin:6px 0 0">${escapeAttr(p.bio || 'Bem-vindo ao meu MineBoard.')}</p>
          </div>
        </div>
      </section>

      <section class="panel">
        <h3>Assinar Mural</h3>
        <form id="form-comment">
          <div class="grid-2">
            <div class="field">
              <label>Nome (opcional - padrão: Anônimo)</label>
              <input type="text" name="author_name" value="${escapeAttr(draft?.author_name || '')}" placeholder="Anônimo" maxlength="60" />
            </div>
            <div class="field">
              <label>E-mail (opcional)</label>
              <input type="email" name="author_email" value="${escapeAttr(draft?.author_email || '')}" placeholder="contato@exemplo.com" />
            </div>
          </div>
          <div class="field">
            <label>Mensagem *</label>
            <textarea name="content" rows="3" required maxlength="2000" placeholder="Escreva seu recado...">${escapeAttr(draft?.content || '')}</textarea>
          </div>
          <button type="submit" class="btn">Publicar</button>
        </form>
      </section>

      <section class="panel">
        <h3>Recados (${state.activeComments.length})</h3>
        <ul class="comment-list">${commentsHtml}</ul>
      </section>
    </div>
  `;
}

function render(): void {
  const root = document.getElementById('app');
  if (!root) return;

  const flashHtml = state.flashMessage
    ? `<div class="alert ${state.flashMessage.isError ? 'alert-error' : ''}">${escapeAttr(state.flashMessage.text)}</div>`
    : '';

  let bodyHtml = '';
  switch (state.view.type) {
    case 'home':
      bodyHtml = renderHomeView();
      break;
    case 'auth':
      bodyHtml = renderAuthView();
      break;
    case 'dashboard':
      bodyHtml = renderDashboardView();
      break;
    case 'reset':
      bodyHtml = renderResetPasswordView(state.view.token);
      break;
    case 'profile':
      bodyHtml = renderProfileView();
      break;
  }

  root.innerHTML = `
    <div class="layout">
      ${renderTopbar()}
      ${flashHtml}
      ${bodyHtml}
    </div>
  `;

  bindEvents();
}

function bindEvents(): void {
  document.querySelectorAll<HTMLElement>('[data-nav]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const target = el.getAttribute('data-nav') || '/';
      navigate(target);
    });
  });

  document.getElementById('btn-logout')?.addEventListener('click', () => {
    // Atualização otimista imediata (0ms) no logout; a invalidação no servidor segue em background
    setStoredToken(null);
    setStoredAuthSnapshot(null);
    state.currentUser = null;
    state.myProfile = null;
    setFlash('Sessão encerrada.');
    navigate('/');
    void api.logout().catch(() => undefined);
  });

  document.getElementById('form-search')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('input-search') as HTMLInputElement | null;
    state.searchQuery = (input?.value || '').trim();
    if (!state.searchQuery) {
      state.profiles = [];
      render();
      return;
    }
    const res = await api.listProfiles(state.searchQuery);
    state.profiles = res.profiles;
    render();
  });

  document.getElementById('form-register')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const fd = new FormData(form);
    try {
      const res = await api.register({
        username: String(fd.get('username') || ''),
        display_name: String(fd.get('display_name') || ''),
        email: String(fd.get('email') || ''),
        password: String(fd.get('password') || ''),
        bio: String(fd.get('bio') || ''),
      });
      if (res.session_token) setStoredToken(res.session_token);
      state.myProfile = res.profile;
      state.activeProfile = res.profile;
      state.activeComments = [];
      setCachedProfileEntry(res.profile.username, { profile: res.profile, comments: [] });
      setFlash('Conta criada com sucesso.');
      navigate(`/u/${res.profile.username}`);
      void refreshSession();
    } catch (err) {
      setFlash(err instanceof Error ? err.message : 'Erro ao criar conta.', true);
    }
  });

  document.getElementById('form-login')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget as HTMLFormElement);
    try {
      const res = await api.login(String(fd.get('email') || ''), String(fd.get('password') || ''));
      setStoredToken(res.session_token);
      state.currentUser = res.user;
      state.myProfile = res.profile;
      setStoredAuthSnapshot({ user: res.user, profile: res.profile });
      setFlash('Login realizado.');
      navigate('/dashboard');
    } catch (err) {
      setFlash(err instanceof Error ? err.message : 'Falha no login.', true);
    }
  });

  document.getElementById('form-forgot')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const fd = new FormData(form);
    const email = String(fd.get('email') || '').trim();
    if (!email) return;

    // Resposta otimista imediata; caso o envio falhe ou o email seja inválido no backend, notifica
    form.reset();
    setFlash('Se existir uma conta com este email, enviaremos um link de redefinição em instantes.');
    void api.forgotPassword(email).catch((err) => {
      setFlash(err instanceof Error ? err.message : 'Erro na solicitação de recuperação.', true);
    });
  });

  document.getElementById('form-reset-password')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget as HTMLFormElement);
    try {
      const res = await api.resetPassword(
        String(fd.get('token') || ''),
        String(fd.get('new_password') || '')
      );
      setFlash(res.message);
      navigate('/login');
    } catch (err) {
      setFlash(err instanceof Error ? err.message : 'Erro ao redefinir senha.', true);
    }
  });

  document.getElementById('form-edit-profile')?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!state.myProfile) return;
    const fd = new FormData(e.currentTarget as HTMLFormElement);
    const previousProfile: Profile = JSON.parse(JSON.stringify(state.myProfile)) as Profile;
    const username = previousProfile.username;

    const payload = {
      display_name: String(fd.get('display_name') || '').trim() || previousProfile.display_name,
      bio: String(fd.get('bio') || ''),
      theme_config: {
        background_color: String(fd.get('background_color') || '#111111'),
        card_background: String(fd.get('card_background') || '#181818'),
        text_color: String(fd.get('text_color') || '#d4d4d4'),
        accent_color: String(fd.get('accent_color') || '#cccccc'),
        font_family: String(fd.get('font_family') || 'Courier New'),
      },
    };

    // Atualização otimista imediata (0ms) no perfil local e no cache
    const optimisticProfile: Profile = {
      ...previousProfile,
      display_name: payload.display_name,
      bio: payload.bio,
      theme_config: payload.theme_config,
      updated_at: new Date().toISOString(),
    };

    state.myProfile = optimisticProfile;
    if (state.activeProfile && state.activeProfile.username === username) {
      state.activeProfile = optimisticProfile;
    }
    if (state.currentUser) {
      setStoredAuthSnapshot({ user: state.currentUser, profile: optimisticProfile });
    }
    setFlash('Perfil atualizado.');

    void api
      .updateProfile(username, payload)
      .then((res) => {
        state.myProfile = res.profile;
        if (state.activeProfile && state.activeProfile.username === username) {
          state.activeProfile = res.profile;
        }
        if (state.currentUser) {
          setStoredAuthSnapshot({ user: state.currentUser, profile: res.profile });
        }
      })
      .catch((err) => {
        // Rollback em background caso o servidor rejeite a alteração
        state.myProfile = previousProfile;
        if (state.activeProfile && state.activeProfile.username === username) {
          state.activeProfile = previousProfile;
        }
        if (state.currentUser) {
          setStoredAuthSnapshot({ user: state.currentUser, profile: previousProfile });
        }
        setFlash(err instanceof Error ? err.message : 'Erro ao atualizar perfil. Alterações revertidas.', true);
      });
  });

  document.getElementById('form-avatar')?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!state.myProfile) return;
    const form = e.currentTarget as HTMLFormElement;
    const fileInput = form.querySelector('input[type="file"]') as HTMLInputElement | null;
    const file = fileInput?.files?.[0];
    if (!file) return;

    const previousAvatar = state.myProfile.avatar_url;
    const username = state.myProfile.username;
    const previewUrl = URL.createObjectURL(file);

    // Exibe a nova imagem imediatamente (0ms) via ObjectURL enquanto envia para o R2 em background
    state.myProfile = { ...state.myProfile, avatar_url: previewUrl };
    if (state.activeProfile && state.activeProfile.username === username) {
      state.activeProfile = { ...state.activeProfile, avatar_url: previewUrl };
    }
    form.reset();
    setFlash('Avatar atualizado.');

    void api
      .uploadAvatar(username, file)
      .then((res) => {
        URL.revokeObjectURL(previewUrl);
        if (state.myProfile && state.myProfile.username === username) {
          state.myProfile = { ...state.myProfile, avatar_url: res.avatar_url };
          if (state.currentUser) {
            setStoredAuthSnapshot({ user: state.currentUser, profile: state.myProfile });
          }
        }
        if (state.activeProfile && state.activeProfile.username === username) {
          state.activeProfile = { ...state.activeProfile, avatar_url: res.avatar_url };
          syncCurrentProfileCache();
        }
      })
      .catch((err) => {
        URL.revokeObjectURL(previewUrl);
        if (state.myProfile && state.myProfile.username === username) {
          state.myProfile = { ...state.myProfile, avatar_url: previousAvatar };
          if (state.currentUser) {
            setStoredAuthSnapshot({ user: state.currentUser, profile: state.myProfile });
          }
        }
        if (state.activeProfile && state.activeProfile.username === username) {
          state.activeProfile = { ...state.activeProfile, avatar_url: previousAvatar };
          syncCurrentProfileCache();
        }
        setFlash(err instanceof Error ? err.message : 'Erro no upload do avatar. Revertido.', true);
      });
  });

  document.getElementById('btn-copy-script')?.addEventListener('click', () => {
    const text = document.getElementById('snippet-script')?.textContent || '';
    void navigator.clipboard?.writeText(text);
    setFlash('Código script copiado.');
  });

  document.getElementById('btn-copy-iframe')?.addEventListener('click', () => {
    const text = document.getElementById('snippet-iframe')?.textContent || '';
    void navigator.clipboard?.writeText(text);
    setFlash('Código iframe copiado.');
  });

  document.getElementById('form-change-password')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const fd = new FormData(form);
    try {
      const res = await api.changePassword(
        String(fd.get('current_password') || ''),
        String(fd.get('new_password') || '')
      );
      form.reset();
      setFlash(res.message);
    } catch (err) {
      setFlash(err instanceof Error ? err.message : 'Erro ao alterar senha.', true);
    }
  });

  document.getElementById('btn-delete-account')?.addEventListener('click', async () => {
    if (!state.myProfile) return;
    if (!window.confirm('Tem certeza? Sua conta, perfil e comentários serão excluídos permanentemente.')) {
      return;
    }
    const username = state.myProfile.username;
    try {
      await api.deleteAccount(username);
      removeCachedProfileEntry(username);
      setStoredToken(null);
      setStoredAuthSnapshot(null);
      state.currentUser = null;
      state.myProfile = null;
      setFlash('Conta excluída.');
      navigate('/');
    } catch (err) {
      setFlash(err instanceof Error ? err.message : 'Erro ao excluir conta.', true);
    }
  });

  document.getElementById('form-comment')?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!state.activeProfile) return;
    const form = e.currentTarget as HTMLFormElement;
    const fd = new FormData(form);

    const rawAuthor = String(fd.get('author_name') || '').trim();
    const rawEmail = String(fd.get('author_email') || '').trim();
    const rawContent = String(fd.get('content') || '').trim();
    if (!rawContent) return;

    const targetUsername = state.activeProfile.username;
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const optimisticComment: CommentItem = {
      id: tempId,
      profile_id: state.activeProfile.id,
      author_name: rawAuthor || 'Anônimo',
      author_email: rawEmail || null,
      content: rawContent,
      likes_count: 0,
      liked_by_me: false,
      created_at: new Date().toISOString(),
    };

    pendingCommentActions.set(tempId, {});
    state.commentDraft = null;
    state.activeComments = [optimisticComment, ...state.activeComments];
    syncCurrentProfileCache();
    form.reset();
    setFlash('Recado publicado.');

    void api
      .postComment(targetUsername, {
        author_name: rawAuthor,
        author_email: rawEmail,
        content: rawContent,
      })
      .then(async (res) => {
        const queued = pendingCommentActions.get(tempId);
        pendingCommentActions.delete(tempId);

        let finalComment = res.comment;
        // Se o usuário já clicou em Excluir antes da resposta do POST chegar
        if (queued?.deleted) {
          await api.deleteComment(finalComment.id).catch(() => undefined);
          return;
        }
        // Se o usuário já clicou em Curtir antes da resposta do POST chegar
        if (queued?.desiredLiked !== undefined && queued.desiredLiked !== finalComment.liked_by_me) {
          try {
            const likeRes = await api.toggleLike(finalComment.id, !queued.desiredLiked);
            finalComment = {
              ...finalComment,
              likes_count: likeRes.likes_count,
              liked_by_me: likeRes.liked_by_me,
            };
          } catch {
            // mantém estado base se o like subsequente falhar
          }
        }

        state.activeComments = state.activeComments.map((c) => (c.id === tempId ? finalComment : c));
        syncCurrentProfileCache();
        if (state.view.type === 'profile' && state.view.username === targetUsername) {
          render();
        }
      })
      .catch((err) => {
        pendingCommentActions.delete(tempId);
        state.activeComments = state.activeComments.filter((c) => c.id !== tempId);
        // Devolve o texto digitado para o formulário para o usuário não perder a mensagem
        state.commentDraft = {
          author_name: rawAuthor,
          author_email: rawEmail,
          content: rawContent,
        };
        syncCurrentProfileCache();
        setFlash(err instanceof Error ? err.message : 'Erro ao publicar recado.', true);
      });
  });

  document.querySelectorAll<HTMLButtonElement>('.btn-like').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id') || '';
      const currentlyLiked = btn.getAttribute('data-liked') === '1';
      const nextLiked = !currentlyLiked;
      const delta = nextLiked ? 1 : -1;

      // Atualização otimista imediata (0ms)
      state.activeComments = state.activeComments.map((c) =>
        c.id === id
          ? { ...c, likes_count: Math.max(0, c.likes_count + delta), liked_by_me: nextLiked }
          : c
      );
      syncCurrentProfileCache();
      render();

      // Se o comentário ainda estiver aguardando o ID definitivo do POST, enfileira o like
      if (pendingCommentActions.has(id)) {
        const entry = pendingCommentActions.get(id)!;
        entry.desiredLiked = nextLiked;
        return;
      }

      void api
        .toggleLike(id, currentlyLiked)
        .then((res) => {
          state.activeComments = state.activeComments.map((c) =>
            c.id === id ? { ...c, likes_count: res.likes_count, liked_by_me: res.liked_by_me } : c
          );
          syncCurrentProfileCache();
          render();
        })
        .catch((err) => {
          // Rollback da curtida em caso de erro
          state.activeComments = state.activeComments.map((c) =>
            c.id === id
              ? { ...c, likes_count: Math.max(0, c.likes_count - delta), liked_by_me: currentlyLiked }
              : c
          );
          syncCurrentProfileCache();
          setFlash(err instanceof Error ? err.message : 'Erro ao curtir comentário.', true);
        });
    });
  });

  document.querySelectorAll<HTMLButtonElement>('.btn-del-comment').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id') || '';
      const previousComments = [...state.activeComments];

      // Remoção otimista imediata (0ms)
      state.activeComments = state.activeComments.filter((c) => c.id !== id);
      syncCurrentProfileCache();
      setFlash('Comentário excluído.');

      // Se o comentário ainda estava aguardando o ID real do POST, marca para exclusão imediata ao chegar
      if (pendingCommentActions.has(id)) {
        const entry = pendingCommentActions.get(id)!;
        entry.deleted = true;
        return;
      }

      void api.deleteComment(id).catch((err) => {
        // Rollback caso a exclusão falhe no backend
        state.activeComments = previousComments;
        syncCurrentProfileCache();
        setFlash(err instanceof Error ? err.message : 'Erro ao excluir comentário. Restaurado.', true);
      });
    });
  });
}

window.addEventListener('popstate', () => {
  void handleRoute();
});

render();

void (async () => {
  await Promise.all([refreshSession(), handleRoute()]);
})();
