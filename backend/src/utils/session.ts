import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Db } from 'mongodb';
import type { ObjectId } from 'bson';
import type { Env } from '../db';
import type { Profile, Session, User } from '../types';
import { generateSecureToken, hashSha256 } from './security';

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

type AppContext = Context<{ Bindings: Env }>;

export function getSessionCookieName(env: Env): string {
  return env.SESSION_COOKIE_NAME || 'guestbook_session';
}

/**
 * Define o atributo `Domain` do cookie para que a sessão valha no domínio raiz e em todos os
 * subdomínios de usuário (RN16). Em localhost o atributo é omitido.
 */
function resolveCookieDomain(c: AppContext): string | undefined {
  const hostname = new URL(c.req.url).hostname.toLowerCase();
  const root = (c.env.ROOT_DOMAIN || 'nicolaspitz.dev').toLowerCase();
  if (hostname === root || hostname.endsWith(`.${root}`)) {
    return `.${root}`;
  }
  return undefined;
}

function isSecureRequest(c: AppContext): boolean {
  return new URL(c.req.url).protocol === 'https:';
}

/**
 * Cria uma sessão para o usuário, grava o hash do token no MongoDB e define o cookie
 * `HttpOnly; SameSite=Lax; Domain=.<root>` (RN16). Retorna o token em claro.
 */
export async function createSessionForUser(c: AppContext, db: Db, userId: ObjectId): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSecureToken(32);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

  await db.collection<Session>('sessions').insertOne({
    _id: await hashSha256(token),
    user_id: userId,
    expires_at: expiresAt,
    created_at: now,
  });

  setCookie(c, getSessionCookieName(c.env), token, {
    httpOnly: true,
    secure: isSecureRequest(c),
    sameSite: 'Lax',
    path: '/',
    domain: resolveCookieDomain(c),
    expires: expiresAt,
  });

  return { token, expiresAt };
}

export function clearSessionCookie(c: AppContext): void {
  deleteCookie(c, getSessionCookieName(c.env), {
    path: '/',
    domain: resolveCookieDomain(c),
    secure: isSecureRequest(c),
  });
}

/**
 * Extrai o token de sessão do cookie ou do header `Authorization: Bearer <token>`.
 */
export function extractSessionToken(c: AppContext): string | null {
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) return token;
  }
  return getCookie(c, getSessionCookieName(c.env)) || null;
}

export interface AuthenticatedContext {
  user: User;
  profile: Profile | null;
  session: Session;
}

/**
 * Resolve o usuário autenticado a partir do token enviado.
 * Retorna `null` se não houver token, se a sessão não existir ou estiver expirada.
 */
export async function resolveAuthenticatedUser(c: AppContext, db: Db): Promise<AuthenticatedContext | null> {
  const token = extractSessionToken(c);
  if (!token) return null;

  const session = await db.collection<Session>('sessions').findOne({ _id: await hashSha256(token) });
  if (!session) return null;

  if (new Date(session.expires_at).getTime() <= Date.now()) {
    await db.collection<Session>('sessions').deleteOne({ _id: session._id });
    return null;
  }

  const [user, profile] = await Promise.all([
    db.collection<User>('users').findOne({ _id: session.user_id }),
    db.collection<Profile>('profiles').findOne({ user_id: session.user_id }),
  ]);
  if (!user || !user._id) return null;

  return { user, profile, session };
}

export type OwnershipResult =
  | { ok: true; auth: AuthenticatedContext | null }
  | { ok: false; status: 401 | 403; error: string };

/**
 * Verifica se a requisição pertence ao dono do perfil (RN8, UC02, UC03, UC09).
 *
 * - Com token: a sessão precisa ser válida (401) e pertencer ao dono do perfil (403).
 * - Sem token: bloqueia (401) contas protegidas por senha ou OAuth. Contas legadas/demonstração
 *   sem credenciais (`auth_provider: 'local'` e `password_hash: null`) permanecem acessíveis para
 *   compatibilidade com o seed e os scripts de demonstração.
 */
export async function authorizeProfileOwner(c: AppContext, db: Db, profile: Profile): Promise<OwnershipResult> {
  const token = extractSessionToken(c);

  if (token) {
    const auth = await resolveAuthenticatedUser(c, db);
    if (!auth) {
      return { ok: false, status: 401, error: 'Sessão inválida ou expirada. Faça login novamente.' };
    }
    if (!auth.user._id || !auth.user._id.equals(profile.user_id)) {
      return { ok: false, status: 403, error: 'Apenas o dono do perfil pode realizar esta operação (RN8).' };
    }
    return { ok: true, auth };
  }

  const owner = await db.collection<User>('users').findOne({ _id: profile.user_id });
  const isProtected = !!owner && (!!owner.password_hash || owner.auth_provider !== 'local');
  if (isProtected) {
    return { ok: false, status: 401, error: 'Autenticação necessária para esta operação.' };
  }

  return { ok: true, auth: null };
}
