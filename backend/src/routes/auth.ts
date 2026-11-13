import { Hono } from 'hono';
import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Db } from 'mongodb';
import { Env, getDatabase } from '../db';
import type { PasswordResetToken, Profile, Session, User } from '../types';
import {
  generateSecureToken,
  getClientIdentity,
  hashPassword,
  hashSha256,
  isValidEmail,
  needsPasswordRehash,
  sanitizeText,
  validatePassword,
  validateUsername,
  verifyPassword,
} from '../utils/security';
import {
  clearSessionCookie,
  createSessionForUser,
  extractSessionToken,
  invalidateSessionCache,
  resolveAuthenticatedUser,
  resolveAuthenticatedUserCached,
} from '../utils/session';
import { logAuditEvent } from '../utils/audit';
import { getAppUrl, sendPasswordResetEmail } from '../utils/email';
import { createAccountWithProfile, serializeProfile } from './profiles';

export const authRouter = new Hono<{ Bindings: Env }>();

type AppContext = Context<{ Bindings: Env }>;

export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1 hora (RN4)
const OAUTH_STATE_COOKIE = 'guestbook_oauth_state';

function serializeUser(user: User) {
  return {
    id: user._id?.toString(),
    email: user.email,
    auth_provider: user.auth_provider,
    has_password: !!user.password_hash,
    created_at: user.created_at instanceof Date ? user.created_at.toISOString() : user.created_at,
  };
}

async function readJson(c: AppContext): Promise<Record<string, unknown> | null> {
  const body = await c.req.json().catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

/**
 * POST /api/auth/login
 * Autenticação local por email e senha; cria sessão válida no domínio raiz e subdomínios (RN16).
 */
authRouter.post('/login', async (c) => {
  try {
    const body = await readJson(c);
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!email || !password) {
      return c.json({ error: 'Informe email e senha.' }, 400);
    }

    const { db } = await getDatabase(c.env);
    const { ipHash } = await getClientIdentity(c.req.raw);
    const user = await db.collection<User>('users').findOne({ email });

    // Mensagem genérica para não revelar quais emails estão cadastrados
    if (!user || !user._id || !(await verifyPassword(password, user.password_hash))) {
      await logAuditEvent(db, 'auth.login_failed', { user_id: user?._id ?? null, ip_hash: ipHash });
      return c.json({ error: 'Email ou senha incorretos.' }, 401);
    }

    // Migra hashes legados (SHA-256 sem salt) para PBKDF2 de forma transparente
    if (needsPasswordRehash(user.password_hash)) {
      await db
        .collection<User>('users')
        .updateOne({ _id: user._id }, { $set: { password_hash: await hashPassword(password), updated_at: new Date() } });
    }

    const profile = await db.collection<Profile>('profiles').findOne({ user_id: user._id });
    const session = await createSessionForUser(c, db, user._id, { user, profile });
    await logAuditEvent(db, 'auth.login', { user_id: user._id, profile_id: profile?._id ?? null, ip_hash: ipHash });

    return c.json({
      message: 'Login realizado com sucesso.',
      user: serializeUser(user),
      profile: profile ? serializeProfile(profile) : null,
      session_token: session.token,
      session_expires_at: session.expiresAt.toISOString(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

/**
 * POST /api/auth/logout
 * Remove a sessão atual do MongoDB e limpa o cookie.
 */
authRouter.post('/logout', async (c) => {
  try {
    const rawToken = extractSessionToken(c);
    if (rawToken) {
      const tokenHash = await hashSha256(rawToken);
      await invalidateSessionCache(tokenHash);
      const { db } = await getDatabase(c.env);
      const auth = await resolveAuthenticatedUser(c, db);
      if (auth) {
        await db.collection<Session>('sessions').deleteOne({ _id: auth.session._id });
        await invalidateSessionCache(auth.session._id);
        await logAuditEvent(db, 'auth.logout', { user_id: auth.user._id });
      }
    }
    clearSessionCookie(c);
    return c.json({ message: 'Sessão encerrada.' });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

/**
 * GET /api/auth/me
 * Retorna o usuário autenticado e seu perfil (com hit em memória / Edge Cache sem abrir socket no MongoDB).
 */
authRouter.get('/me', async (c) => {
  try {
    if (!extractSessionToken(c)) {
      return c.json({ authenticated: false, error: 'Não autenticado.' }, 401);
    }
    const auth = await resolveAuthenticatedUserCached(c);
    if (!auth) {
      return c.json({ authenticated: false, error: 'Não autenticado.' }, 401);
    }
    return c.json({
      authenticated: true,
      user: serializeUser(auth.user),
      profile: auth.profile ? serializeProfile(auth.profile) : null,
      session_expires_at: new Date(auth.session.expires_at).toISOString(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

/**
 * POST /api/auth/change-password
 * Usuário autenticado informa a senha atual e a nova senha (RF5, UC04).
 * A nova senha pode ser igual à anterior (RN5). Contas sem senha (OAuth/demo) podem definir uma.
 */
authRouter.post('/change-password', async (c) => {
  try {
    const { db } = await getDatabase(c.env);
    const auth = await resolveAuthenticatedUser(c, db);
    if (!auth || !auth.user._id) {
      return c.json({ error: 'Autenticação necessária.' }, 401);
    }

    const body = await readJson(c);
    const currentPassword = typeof body?.current_password === 'string' ? body.current_password : '';
    const newPassword = body?.new_password;

    const passwordError = validatePassword(newPassword);
    if (passwordError) {
      return c.json({ error: passwordError }, 400);
    }

    if (auth.user.password_hash && !(await verifyPassword(currentPassword, auth.user.password_hash))) {
      return c.json({ error: 'Senha atual incorreta.' }, 403);
    }

    await db
      .collection<User>('users')
      .updateOne(
        { _id: auth.user._id },
        { $set: { password_hash: await hashPassword(newPassword as string), updated_at: new Date() } }
      );

    // Encerra as demais sessões do usuário, mantendo a atual
    await db.collection<Session>('sessions').deleteMany({ user_id: auth.user._id, _id: { $ne: auth.session._id } });
    await invalidateSessionCache();
    await logAuditEvent(db, 'auth.password_changed', { user_id: auth.user._id });

    return c.json({ message: 'Senha alterada com sucesso.' });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

/**
 * POST /api/auth/forgot-password
 * Gera um token de uso único com validade de 1 hora e envia o link por email (RF6, RN4, UC05).
 * A resposta é sempre a mesma, exista ou não a conta, para evitar enumeração de emails.
 */
authRouter.post('/forgot-password', async (c) => {
  try {
    const body = await readJson(c);
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!isValidEmail(email)) {
      return c.json({ error: 'Informe um email válido.' }, 400);
    }

    const genericResponse = {
      message: 'Se existir uma conta com este email, enviaremos um link de redefinição em instantes.',
    };

    const { db } = await getDatabase(c.env);
    const { ipHash } = await getClientIdentity(c.req.raw);
    const user = await db.collection<User>('users').findOne({ email });
    if (!user || !user._id) {
      await logAuditEvent(db, 'auth.password_reset_requested', { ip_hash: ipHash, account_found: false });
      return c.json(genericResponse);
    }

    // Invalida pedidos anteriores ainda não utilizados
    await db.collection<PasswordResetToken>('password_reset_tokens').deleteMany({ user_id: user._id, used_at: null });

    const token = generateSecureToken(32);
    const now = new Date();
    await db.collection<PasswordResetToken>('password_reset_tokens').insertOne({
      user_id: user._id,
      token_hash: await hashSha256(token),
      expires_at: new Date(now.getTime() + PASSWORD_RESET_TTL_MS),
      used_at: null,
      created_at: now,
    });

    const emailResult = await sendPasswordResetEmail(c.env, user.email, token);
    await logAuditEvent(db, 'auth.password_reset_requested', {
      user_id: user._id,
      ip_hash: ipHash,
      account_found: true,
      email_sent: emailResult.sent,
      email_simulated: emailResult.simulated,
    });

    return c.json(genericResponse);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

/**
 * POST /api/auth/reset-password
 * Redefine a senha com um token válido, não expirado e não utilizado (RN4).
 * Não compara com a senha anterior (RN5). Encerra todas as sessões existentes.
 */
authRouter.post('/reset-password', async (c) => {
  try {
    const body = await readJson(c);
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    const newPassword = body?.new_password;
    if (!token) {
      return c.json({ error: 'Token de redefinição ausente.' }, 400);
    }

    const passwordError = validatePassword(newPassword);
    if (passwordError) {
      return c.json({ error: passwordError }, 400);
    }

    const { db } = await getDatabase(c.env);
    const resetToken = await db
      .collection<PasswordResetToken>('password_reset_tokens')
      .findOne({ token_hash: await hashSha256(token) });

    const isExpired = !resetToken || new Date(resetToken.expires_at).getTime() <= Date.now();
    if (!resetToken || resetToken.used_at || isExpired) {
      return c.json({ error: 'Link de redefinição inválido, expirado ou já utilizado. Solicite um novo.' }, 400);
    }

    // Marca como utilizado antes de trocar a senha (uso único — RN4)
    const marked = await db
      .collection<PasswordResetToken>('password_reset_tokens')
      .updateOne({ _id: resetToken._id, used_at: null }, { $set: { used_at: new Date() } });
    if (marked.matchedCount === 0) {
      return c.json({ error: 'Link de redefinição já utilizado. Solicite um novo.' }, 400);
    }

    await db
      .collection<User>('users')
      .updateOne(
        { _id: resetToken.user_id },
        { $set: { password_hash: await hashPassword(newPassword as string), updated_at: new Date() } }
      );
    await db.collection<Session>('sessions').deleteMany({ user_id: resetToken.user_id });
    await invalidateSessionCache();
    await logAuditEvent(db, 'auth.password_reset_completed', { user_id: resetToken.user_id });

    return c.json({ message: 'Senha redefinida com sucesso. Faça login com a nova senha.' });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

// ---------------------------------------------------------------------------
// OAuth 2.0 — Google (requisito geral: autenticação via provedor externo)
// ---------------------------------------------------------------------------

function getOAuthRedirectUri(c: AppContext): string {
  return `${new URL(c.req.url).origin}/api/auth/google/callback`;
}

/**
 * Deriva um username válido e disponível a partir do email (RN2, RN15).
 */
export async function deriveAvailableUsername(db: Db, email: string): Promise<string> {
  let base = email
    .split('@')[0]
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24);
  if (base.length < 3) base = `user-${base}`.replace(/-$/, '');

  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${generateSecureToken(2)}`;
    const validation = validateUsername(candidate);
    if (!validation.valid) continue;
    const taken = await db.collection<Profile>('profiles').findOne({ username: validation.username });
    if (!taken) return validation.username;
  }
  return `user-${generateSecureToken(4)}`;
}

/**
 * GET /api/auth/google
 * Redireciona o navegador para a tela de consentimento do Google.
 */
authRouter.get('/google', (c) => {
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
    return c.json({ error: 'Login com Google não configurado neste ambiente.' }, 503);
  }

  const state = generateSecureToken(16);
  setCookie(c, OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/api/auth',
    maxAge: 600,
  });

  const params = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: getOAuthRedirectUri(c),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`, 302);
});

/**
 * GET /api/auth/google/callback
 * Troca o `code` por tokens, obtém o perfil do Google, cria/vincula a conta e inicia a sessão.
 */
authRouter.get('/google/callback', async (c) => {
  const appUrl = getAppUrl(c.env);
  const fail = (reason: string) => c.redirect(`${appUrl}/login?error=${encodeURIComponent(reason)}`, 302);

  try {
    if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
      return fail('oauth_not_configured');
    }

    const code = c.req.query('code');
    const state = c.req.query('state');
    const expectedState = getCookie(c, OAUTH_STATE_COOKIE);
    deleteCookie(c, OAUTH_STATE_COOKIE, { path: '/api/auth' });
    if (!code || !state || !expectedState || state !== expectedState) {
      return fail('invalid_state');
    }

    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: c.env.GOOGLE_CLIENT_ID,
        client_secret: c.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: getOAuthRedirectUri(c),
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenResponse.ok) {
      return fail('token_exchange_failed');
    }
    const tokens = (await tokenResponse.json()) as { access_token?: string };
    if (!tokens.access_token) {
      return fail('token_exchange_failed');
    }

    const userInfoResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!userInfoResponse.ok) {
      return fail('userinfo_failed');
    }
    const info = (await userInfoResponse.json()) as {
      sub?: string;
      email?: string;
      email_verified?: boolean;
      name?: string;
      picture?: string;
    };
    if (!info.sub || !info.email || !info.email_verified) {
      return fail('email_not_verified');
    }

    const email = info.email.toLowerCase();
    const { db } = await getDatabase(c.env);
    const users = db.collection<User>('users');

    let user: User | null = await users.findOne({ auth_provider: 'google', auth_provider_id: info.sub });
    let created = false;

    if (!user) {
      // Vincula a uma conta local existente apenas quando o Google confirma o email
      const byEmail = await users.findOne({ email });
      if (byEmail && byEmail._id) {
        await users.updateOne(
          { _id: byEmail._id },
          { $set: { auth_provider: 'google', auth_provider_id: info.sub, updated_at: new Date() } }
        );
        user = { ...byEmail, auth_provider: 'google', auth_provider_id: info.sub };
      }
    }

    if (!user) {
      const username = await deriveAvailableUsername(db, email);
      const result = await createAccountWithProfile(db, {
        email,
        username,
        displayName: sanitizeText(info.name || username).slice(0, 80),
        passwordHash: null,
        authProvider: 'google',
        authProviderId: info.sub,
        avatarUrl: info.picture && info.picture.startsWith('https://') ? info.picture : undefined,
      });
      user = result.user;
      created = true;
      await logAuditEvent(db, 'account.created', {
        user_id: user._id,
        profile_id: result.profile._id,
        username,
        provider: 'google',
      });
    }

    await createSessionForUser(c, db, user._id!, { user });
    const { ipHash } = await getClientIdentity(c.req.raw);
    await logAuditEvent(db, 'auth.oauth_login', { user_id: user._id, ip_hash: ipHash, provider: 'google', created });

    return c.redirect(`${appUrl}/dashboard${created ? '?welcome=1' : ''}`, 302);
  } catch {
    return fail('oauth_error');
  }
});
