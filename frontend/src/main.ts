import {
  api,
  AuthUser,
  CommentItem,
  Profile,
  setStoredToken,
  ThemeConfig,
} from './api';

type ViewMode =
  | { type: 'home' }
  | { type: 'auth' }
  | { type: 'dashboard' }
  | { type: 'reset'; token: string }
  | { type: 'profile'; username: string; fromSubdomain?: boolean };

interface AppState {
  view: ViewMode;
  currentUser: AuthUser | null;
  myProfile: Profile | null;
  profiles: Profile[];
  searchQuery: string;
  activeProfile: Profile | null;
  activeComments: CommentItem[];
  flashMessage: { text: string; isError?: boolean } | null;
}

const state: AppState = {
  view: { type: 'home' },
  currentUser: null,
  myProfile: null,
  profiles: [],
  searchQuery: '',
  activeProfile: null,
  activeComments: [],
  flashMessage: null,
};

const FONT_OPTIONS = [
  'monospace',
  'Courier New',
  'Comic Sans MS',
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

function setFlash(text: string, isError = false): void {
  state.flashMessage = { text, isError };
  render();
}

function navigate(path: string): void {
  window.history.pushState({}, '', path);
  void handleRoute();
}

async function refreshSession(): Promise<void> {
  try {
    const me = await api.getMe();
    state.currentUser = me.user;
    state.myProfile = me.profile;
  } catch {
    state.currentUser = null;
    state.myProfile = null;
  }
}

async function loadProfileView(username: string, fromSubdomain = false): Promise<void> {
  try {
    const data = await api.getProfile(username);
    state.activeProfile = data.profile;
    state.activeComments = data.comments;
    state.view = { type: 'profile', username: data.profile.username, fromSubdomain };
    render();
  } catch (err) {
    setFlash(err instanceof Error ? err.message : 'Perfil não encontrado.', true);
    state.view = { type: 'home' };
    render();
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

  // Verifica se está acessando via subdomínio (<username>.nicolaspitz.dev)
  const hostname = window.location.hostname.toLowerCase();
  const isBaseDomain =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === 'nicolaspitz.dev' ||
    hostname === 'www.nicolaspitz.dev' ||
    hostname === 'dev.nicolaspitz.dev' ||
    hostname === 'preview-prod.nicolaspitz.dev' ||
    hostname.endsWith('.pages.dev') ||
    hostname.endsWith('.workers.dev');

  if (path === '/' && !isBaseDomain) {
    try {
      const hostInfo = await api.getHostProfile();
      if (hostInfo.mode === 'subdomain' && hostInfo.profile) {
        state.activeProfile = hostInfo.profile;
        state.activeComments = hostInfo.comments || [];
        state.view = { type: 'profile', username: hostInfo.profile.username, fromSubdomain: true };
        render();
        return;
      }
    } catch {
      // fallback para portal raiz
    }
  }

  const list = await api.listProfiles(state.searchQuery).catch(() => ({ profiles: [] }));
  state.profiles = list.profiles;
  state.view = { type: 'home' };
  render();
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

function renderTopbar(): string {
  const userActions = state.currentUser && state.myProfile
    ? `
      <button class="btn" data-nav="/u/${escapeAttr(state.myProfile.username)}">📖 Meu GuestBook (@${escapeAttr(state.myProfile.username)})</button>
      <button class="btn" data-nav="/dashboard">⚙️ Painel & Tema</button>
      <button class="btn btn-danger" id="btn-logout">Sair</button>
    `
    : `<button class="btn" data-nav="/login">🔑 Entrar / Criar Conta</button>`;

  return `
    <header class="topbar">
      <div class="brand" data-nav="/">💾 GuestBook Retrô</div>
      <nav class="nav-actions">
        <button class="btn" data-nav="/">🔍 Explorar Perfis</button>
        ${userActions}
      </nav>
    </header>
  `;
}

function renderHomeView(): string {
  const cards = state.profiles.length
    ? state.profiles
        .map(
          (p) => `
        <div class="profile-card">
          ${
            p.avatar_url
              ? `<img class="avatar" src="${escapeAttr(p.avatar_url)}" alt="${p.display_name}" />`
              : `<div class="avatar" style="display:flex;align-items:center;justify-content:center;font-size:1.6rem">👾</div>`
          }
          <div style="flex:1">
            <div><strong>${p.display_name}</strong> <span style="opacity:.75">@${escapeAttr(p.username)}</span></div>
            <div style="font-size:.88rem;opacity:.85;margin:4px 0">${p.bio || 'Sem biografia.'}</div>
            <button class="btn" data-nav="/u/${escapeAttr(p.username)}">Visitar & Assinar Mural →</button>
          </div>
        </div>
      `
        )
        .join('')
    : `<p>Nenhum perfil encontrado. Crie o primeiro!</p>`;

  return `
    <section class="panel">
      <h2>🌐 Bem-vindo ao GuestBook Web Retrô</h2>
      <p>Crie seu livro de visitas pessoal estilizado nos moldes da web clássica! Visitantes podem assinar e curtir recados livremente sem precisar de conta.</p>
      <form id="form-search" style="display:flex;gap:8px;margin-top:12px">
        <input type="text" id="input-search" value="${escapeAttr(state.searchQuery)}" placeholder="Buscar por @username ou nome (RF7)..." style="flex:1;padding:8px;background:#000;color:#fff;border:1px solid var(--accent-color);font-family:inherit" />
        <button type="submit" class="btn">Buscar</button>
      </form>
    </section>
    <section class="panel">
      <h3>📚 Livros de Visitas Públicos</h3>
      <div class="grid-2">${cards}</div>
    </section>
  `;
}

function renderAuthView(): string {
  return `
    <div class="grid-2">
      <section class="panel">
        <h2>✨ Criar Conta + GuestBook (UC01)</h2>
        <form id="form-register">
          <div class="field">
            <label>Username (subdomínio: username.nicolaspitz.dev)</label>
            <input type="text" name="username" required pattern="^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])?$" placeholder="ex: joaosilva" />
          </div>
          <div class="field">
            <label>Nome de Exibição</label>
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
            <textarea name="bio" rows="2" placeholder="Bem-vindo ao meu cantinho retrô!"></textarea>
          </div>
          <button type="submit" class="btn">Criar Conta e Abrir GuestBook</button>
        </form>
      </section>

      <div>
        <section class="panel">
          <h2>🔑 Entrar na Conta</h2>
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
              <a class="btn" href="/api/auth/google">🌐 Entrar com Google (OAuth)</a>
            </div>
          </form>
        </section>

        <section class="panel">
          <h3>📩 Esqueci Minha Senha (UC05)</h3>
          <form id="form-forgot">
            <div class="field">
              <label>E-mail cadastrado</label>
              <input type="email" name="email" required placeholder="voce@exemplo.com" />
            </div>
            <button type="submit" class="btn">Enviar Link de Recuperação</button>
          </form>
        </section>
      </div>
    </div>
  `;
}

function renderResetPasswordView(token: string): string {
  return `
    <section class="panel">
      <h2>🔑 Redefinir Senha (UC05)</h2>
      <form id="form-reset-password">
        <div class="field">
          <label>Token de Recuperação</label>
          <input type="text" name="token" value="${escapeAttr(token)}" required />
        </div>
        <div class="field">
          <label>Nova Senha (mín. 8 caracteres)</label>
          <input type="password" name="new_password" required minlength="8" />
        </div>
        <button type="submit" class="btn">Salvar Nova Senha</button>
      </form>
    </section>
  `;
}

function renderDashboardView(): string {
  const p = state.myProfile;
  if (!p) {
    return `<section class="panel"><p>Carregando perfil...</p></section>`;
  }
  const t = p.theme_config || {};
  const origin = window.location.origin;
  const scriptSnippet = `<script src="${origin}/api/widget/${p.username}/embed.js" data-limit="10" async></script>`;
  const iframeSnippet = `<iframe src="${origin}/api/widget/${p.username}/frame" width="100%" height="420" style="border:0" loading="lazy"></iframe>`;

  return `
    <div class="grid-2">
      <section class="panel">
        <h2>🎨 Editar Perfil & Estilização (UC02, RF3, RF8)</h2>
        <form id="form-edit-profile">
          <div class="field">
            <label>Nome de Exibição</label>
            <input type="text" name="display_name" value="${escapeAttr(p.display_name)}" required />
          </div>
          <div class="field">
            <label>Biografia / Mensagem de Boas-vindas</label>
            <textarea name="bio" rows="3">${p.bio || ''}</textarea>
          </div>
          <div class="grid-2">
            <div class="field">
              <label>Cor de Fundo</label>
              <input type="color" name="background_color" value="${escapeAttr(t.background_color || '#121212')}" />
            </div>
            <div class="field">
              <label>Cor dos Cartões</label>
              <input type="color" name="card_background" value="${escapeAttr(t.card_background || '#1e1e1e')}" />
            </div>
            <div class="field">
              <label>Cor do Texto</label>
              <input type="color" name="text_color" value="${escapeAttr(t.text_color || '#e0e0e0')}" />
            </div>
            <div class="field">
              <label>Cor de Destaque (Borda/Links)</label>
              <input type="color" name="accent_color" value="${escapeAttr(t.accent_color || '#00ffcc')}" />
            </div>
          </div>
          <div class="field">
            <label>Fonte Retrô</label>
            <select name="font_family">
              ${FONT_OPTIONS.map(
                (f) => `<option value="${f}" ${t.font_family === f ? 'selected' : ''}>${f}</option>`
              ).join('')}
            </select>
          </div>
          <button type="submit" class="btn">Salvar Alterações</button>
        </form>

        <hr style="border-color:var(--accent-color);margin:18px 0" />
        <h3>🖼️ Foto de Perfil no Cloudflare R2 (RF3)</h3>
        <form id="form-avatar">
          <div class="field">
            <input type="file" name="avatar" accept="image/png,image/jpeg,image/webp,image/gif" required />
          </div>
          <button type="submit" class="btn">Enviar Avatar</button>
        </form>
      </section>

      <div>
        <section class="panel">
          <h2>🧩 Widget Embutível para Sites Externos (UC10, RF14)</h2>
          <p>Copie um dos códigos abaixo para exibir seu GuestBook em seu blog ou site pessoal:</p>
          <label><strong>Opção 1 — Script Web Component (Shadow DOM):</strong></label>
          <div class="code-box" id="snippet-script">${escapeAttr(scriptSnippet)}</div>
          <button type="button" class="btn" id="btn-copy-script" style="margin:8px 0 14px">📋 Copiar Script</button>

          <label style="display:block"><strong>Opção 2 — Iframe HTML:</strong></label>
          <div class="code-box" id="snippet-iframe">${escapeAttr(iframeSnippet)}</div>
          <button type="button" class="btn" id="btn-copy-iframe" style="margin-top:8px">📋 Copiar Iframe</button>
        </section>

        <section class="panel">
          <h3>🔒 Alterar Senha (UC04, RF5)</h3>
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
          <h3>⚠️ Zona de Perigo (UC03, RF4, RN3)</h3>
          <p>A exclusão remove permanentemente sua conta, seu perfil e todos os comentários recebidos.</p>
          <button type="button" class="btn btn-danger" id="btn-delete-account">Excluir Minha Conta Permanentemente</button>
        </section>
      </div>
    </div>
  `;
}

function renderProfileView(): string {
  const p = state.activeProfile;
  if (!p) return `<section class="panel"><p>Perfil não encontrado.</p></section>`;

  const isOwner = state.myProfile && state.myProfile.username === p.username;
  const commentsHtml = state.activeComments.length
    ? state.activeComments
        .map(
          (c) => `
        <li class="comment-item">
          <div class="comment-meta">
            <span>
              <strong>${c.author_name}</strong>
              ${c.author_email ? `<span style="opacity:.7">(${c.author_email})</span>` : ''}
              · ${new Date(c.created_at).toLocaleString('pt-BR')}
            </span>
            <span style="display:flex;gap:8px;align-items:center">
              <button class="btn btn-like" data-id="${escapeAttr(c.id)}" data-liked="${c.liked_by_me ? '1' : '0'}" style="padding:3px 10px;font-size:.8rem">
                ${c.liked_by_me ? '♥ Curtido' : '♡ Curtir'} (${c.likes_count})
              </button>
              ${
                isOwner
                  ? `<button class="btn btn-danger btn-del-comment" data-id="${escapeAttr(c.id)}" style="padding:3px 10px;font-size:.8rem">🗑️ Excluir</button>`
                  : ''
              }
            </span>
          </div>
          <div class="comment-content">${c.content}</div>
        </li>
      `
        )
        .join('')
    : `<p>Nenhum recado ainda. Seja o primeiro a assinar este GuestBook!</p>`;

  return `
    <div class="guestbook-themed" style="${buildThemeStyle(p.theme_config)}">
      <section class="panel">
        <div class="profile-card" style="border:none;background:transparent;padding:0">
          ${
            p.avatar_url
              ? `<img class="avatar" src="${escapeAttr(p.avatar_url)}" alt="${p.display_name}" />`
              : `<div class="avatar" style="display:flex;align-items:center;justify-content:center;font-size:2rem">👾</div>`
          }
          <div>
            <h2 style="margin:0">${p.display_name} <span style="font-size:.95rem;opacity:.75">@${escapeAttr(p.username)}</span></h2>
            <p style="margin:6px 0 0">${p.bio || 'Bem-vindo ao meu livro de visitas!'}</p>
          </div>
        </div>
      </section>

      <section class="panel">
        <h3>✍️ Assinar Livro de Visitas (RF10, RF11 — Não exige login)</h3>
        <form id="form-comment">
          <div class="grid-2">
            <div class="field">
              <label>Seu Nome (opcional — em branco = "Anônimo")</label>
              <input type="text" name="author_name" placeholder="Anônimo" maxlength="60" />
            </div>
            <div class="field">
              <label>Seu E-mail de contato (opcional)</label>
              <input type="email" name="author_email" placeholder="contato@exemplo.com" />
            </div>
          </div>
          <div class="field">
            <label>Sua Mensagem *</label>
            <textarea name="content" rows="3" required maxlength="2000" placeholder="Deixe seu recado no mural..."></textarea>
          </div>
          <button type="submit" class="btn">Publicar Recado</button>
        </form>
      </section>

      <section class="panel">
        <h3>💬 Recados Publicados (${state.activeComments.length})</h3>
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
      state.flashMessage = null;
      const target = el.getAttribute('data-nav') || '/';
      navigate(target);
    });
  });

  document.getElementById('btn-logout')?.addEventListener('click', async () => {
    await api.logout().catch(() => undefined);
    setStoredToken(null);
    state.currentUser = null;
    state.myProfile = null;
    setFlash('Sessão encerrada com sucesso.');
    navigate('/');
  });

  document.getElementById('form-search')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('input-search') as HTMLInputElement | null;
    state.searchQuery = input?.value || '';
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
      await refreshSession();
      setFlash('Conta e GuestBook criados com sucesso!');
      navigate(`/u/${res.profile.username}`);
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
      setFlash('Login realizado com sucesso!');
      navigate('/dashboard');
    } catch (err) {
      setFlash(err instanceof Error ? err.message : 'Falha no login.', true);
    }
  });

  document.getElementById('form-forgot')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget as HTMLFormElement);
    try {
      const res = await api.forgotPassword(String(fd.get('email') || ''));
      setFlash(res.message);
    } catch (err) {
      setFlash(err instanceof Error ? err.message : 'Erro na solicitação.', true);
    }
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

  document.getElementById('form-edit-profile')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.myProfile) return;
    const fd = new FormData(e.currentTarget as HTMLFormElement);
    try {
      const res = await api.updateProfile(state.myProfile.username, {
        display_name: String(fd.get('display_name') || ''),
        bio: String(fd.get('bio') || ''),
        theme_config: {
          background_color: String(fd.get('background_color') || '#121212'),
          card_background: String(fd.get('card_background') || '#1e1e1e'),
          text_color: String(fd.get('text_color') || '#e0e0e0'),
          accent_color: String(fd.get('accent_color') || '#00ffcc'),
          font_family: String(fd.get('font_family') || 'monospace'),
        },
      });
      state.myProfile = res.profile;
      setFlash('Perfil e tema retrô atualizados!');
    } catch (err) {
      setFlash(err instanceof Error ? err.message : 'Erro ao atualizar perfil.', true);
    }
  });

  document.getElementById('form-avatar')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.myProfile) return;
    const form = e.currentTarget as HTMLFormElement;
    const fileInput = form.querySelector('input[type="file"]') as HTMLInputElement | null;
    const file = fileInput?.files?.[0];
    if (!file) return;
    try {
      const res = await api.uploadAvatar(state.myProfile.username, file);
      state.myProfile.avatar_url = res.avatar_url;
      setFlash('Foto de perfil atualizada no Cloudflare R2!');
    } catch (err) {
      setFlash(err instanceof Error ? err.message : 'Erro no upload do avatar.', true);
    }
  });

  document.getElementById('btn-copy-script')?.addEventListener('click', () => {
    const text = document.getElementById('snippet-script')?.textContent || '';
    void navigator.clipboard?.writeText(text);
    setFlash('Código <script> do widget copiado para a área de transferência!');
  });

  document.getElementById('btn-copy-iframe')?.addEventListener('click', () => {
    const text = document.getElementById('snippet-iframe')?.textContent || '';
    void navigator.clipboard?.writeText(text);
    setFlash('Código <iframe> do widget copiado para a área de transferência!');
  });

  document.getElementById('form-change-password')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget as HTMLFormElement);
    try {
      const res = await api.changePassword(
        String(fd.get('current_password') || ''),
        String(fd.get('new_password') || '')
      );
      setFlash(res.message);
    } catch (err) {
      setFlash(err instanceof Error ? err.message : 'Erro ao alterar senha.', true);
    }
  });

  document.getElementById('btn-delete-account')?.addEventListener('click', async () => {
    if (!state.myProfile) return;
    if (!window.confirm('Tem certeza? Sua conta, perfil e comentários serão excluídos permanentemente (RN3).')) {
      return;
    }
    try {
      await api.deleteAccount(state.myProfile.username);
      setStoredToken(null);
      state.currentUser = null;
      state.myProfile = null;
      setFlash('Sua conta e todos os dados associados foram excluídos permanentemente.');
      navigate('/');
    } catch (err) {
      setFlash(err instanceof Error ? err.message : 'Erro ao excluir conta.', true);
    }
  });

  document.getElementById('form-comment')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.activeProfile) return;
    const form = e.currentTarget as HTMLFormElement;
    const fd = new FormData(form);
    try {
      const res = await api.postComment(state.activeProfile.username, {
        author_name: String(fd.get('author_name') || ''),
        author_email: String(fd.get('author_email') || ''),
        content: String(fd.get('content') || ''),
      });
      state.activeComments = [res.comment, ...state.activeComments];
      form.reset();
      setFlash('Recado publicado no mural!');
    } catch (err) {
      setFlash(err instanceof Error ? err.message : 'Erro ao publicar recado.', true);
    }
  });

  document.querySelectorAll<HTMLButtonElement>('.btn-like').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id') || '';
      const liked = btn.getAttribute('data-liked') === '1';
      try {
        const res = await api.toggleLike(id, liked);
        state.activeComments = state.activeComments.map((c) =>
          c.id === id ? { ...c, likes_count: res.likes_count, liked_by_me: res.liked_by_me } : c
        );
        render();
      } catch (err) {
        setFlash(err instanceof Error ? err.message : 'Erro ao curtir comentário.', true);
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>('.btn-del-comment').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id') || '';
      try {
        await api.deleteComment(id);
        state.activeComments = state.activeComments.filter((c) => c.id !== id);
        setFlash('Comentário excluído com sucesso (RF12, RN10).');
      } catch (err) {
        setFlash(err instanceof Error ? err.message : 'Erro ao excluir comentário.', true);
      }
    });
  });
}

window.addEventListener('popstate', () => {
  void handleRoute();
});

render();

void (async () => {
  await Promise.all([
    refreshSession().then(() => render()),
    handleRoute(),
  ]);
})();
