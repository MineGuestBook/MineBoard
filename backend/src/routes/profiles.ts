import { Hono } from 'hono';
import { ObjectId } from 'bson';
import type { Db } from 'mongodb';
import { Env, getDatabase, isTestDatabaseActive, onDatabaseReset } from '../db';
import { Profile, ProfileThemeConfig, User, Comment } from '../types';
import {
  getClientIdentity,
  hashPassword,
  isSafeAvatarUrl,
  isSafeColor,
  isSafeFontFamily,
  isValidEmail,
  normalizeUsername,
  sanitizeText,
  validatePassword,
  validateUsername,
} from '../utils/security';
import {
  authorizeProfileOwner,
  cacheSessionContext,
  createSessionForUser,
  extractSessionToken,
  invalidateSessionCache,
} from '../utils/session';
import { logAuditEvent } from '../utils/audit';

export const profilesRouter = new Hono<{ Bindings: Env }>();

const COLOR_THEME_KEYS = ['background_color', 'card_background', 'text_color', 'accent_color'] as const;

export const DEFAULT_THEME: ProfileThemeConfig = {
  background_color: '#121212',
  card_background: '#1e1e1e',
  text_color: '#e0e0e0',
  accent_color: '#00ffcc',
  font_family: 'monospace',
};

export const MAX_DISPLAY_NAME_LENGTH = 80;
export const MAX_BIO_LENGTH = 500;

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_CONTENT_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/**
 * Mantém apenas chaves de tema permitidas com valores seguros (RF8, RNF5):
 * cores hexadecimais e fontes de uma lista fechada, impedindo injeção de CSS.
 */
export function sanitizeThemeConfig(raw: unknown): ProfileThemeConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }

  const input = raw as Record<string, unknown>;
  const sanitized: ProfileThemeConfig = {};
  for (const key of COLOR_THEME_KEYS) {
    if (isSafeColor(input[key])) {
      sanitized[key] = (input[key] as string).trim();
    }
  }
  if (isSafeFontFamily(input.font_family)) {
    sanitized.font_family = (input.font_family as string).trim();
  }
  return sanitized;
}

export function serializeProfile(profile: Profile) {
  return {
    id: profile._id?.toString(),
    user_id: profile.user_id?.toString(),
    username: profile.username,
    display_name: profile.display_name,
    bio: profile.bio ?? null,
    avatar_url: profile.avatar_url ?? null,
    theme_config: profile.theme_config ?? null,
    created_at: profile.created_at instanceof Date ? profile.created_at.toISOString() : profile.created_at,
    updated_at: profile.updated_at instanceof Date ? profile.updated_at.toISOString() : profile.updated_at,
  };
}

export function serializeComment(comment: Comment, currentFingerprint?: string) {
  return {
    id: comment._id?.toString(),
    profile_id: comment.profile_id?.toString(),
    author_name: comment.author_name || 'Anônimo',
    author_email: comment.author_email ?? null,
    content: comment.content,
    likes_count: comment.likes_count ?? 0,
    liked_by_me: currentFingerprint ? (comment.liked_by || []).includes(currentFingerprint) : false,
    created_at: comment.created_at instanceof Date ? comment.created_at.toISOString() : comment.created_at,
  };
}

const PUBLIC_CACHE_TTL_MS = 5 * 60_000;
const EDGE_CACHE_TTL_SECONDS = 300;
const EDGE_CACHE_ORIGIN = 'https://cache.guestbook.internal';
const profileListCache = new Map<string, { expiresAt: number; profiles: Profile[] }>();
const profileDetailCache = new Map<string, { expiresAt: number; profile: Profile; comments: Comment[] }>();

function getEdgeCache(): Cache | null {
  if (isTestDatabaseActive()) return null;
  if (typeof caches !== 'undefined' && 'default' in caches) {
    return (caches as unknown as { default: Cache }).default;
  }
  return null;
}

function reviveProfile(raw: Profile): Profile {
  return {
    ...raw,
    _id: raw._id ? new ObjectId(String(raw._id)) : undefined,
    user_id: new ObjectId(String(raw.user_id)),
    created_at: new Date(raw.created_at),
    updated_at: new Date(raw.updated_at),
  };
}

function reviveComment(raw: Comment): Comment {
  return {
    ...raw,
    _id: raw._id ? new ObjectId(String(raw._id)) : undefined,
    profile_id: new ObjectId(String(raw.profile_id)),
    created_at: new Date(raw.created_at),
  };
}

/**
 * Invalida o cache em memória do isolate e o Cloudflare Edge Cache (`caches.default`)
 * sempre que qualquer perfil, comentário ou curtida é alterado.
 */
export async function invalidatePublicCache(username?: string): Promise<void> {
  profileListCache.clear();
  profileDetailCache.clear();

  const edgeCache = getEdgeCache();
  if (!edgeCache) return;

  const tasks: Promise<boolean>[] = [
    edgeCache.delete(`${EDGE_CACHE_ORIGIN}/profiles-list`),
  ];
  if (username) {
    tasks.push(edgeCache.delete(`${EDGE_CACHE_ORIGIN}/profile/${normalizeUsername(username)}`));
  }
  await Promise.allSettled(tasks);
}

onDatabaseReset(() => {
  profileListCache.clear();
  profileDetailCache.clear();
});

/**
 * Busca um perfil pelo username e carrega seus comentários mais recentes (RF9, RNF3).
 * Reutilizado tanto pela rota `/api/profiles/:username` quanto pela resolução via subdomínio (`Host`).
 */
export async function findProfileWithComments(
  db: Db,
  rawUsername: string,
  limit = 20
): Promise<{ profile: Profile; comments: Comment[] } | null> {
  const username = normalizeUsername(rawUsername);
  const safeLimit = Math.min(Math.max(1, limit), 100);
  const cached = profileDetailCache.get(username);
  if (cached && cached.expiresAt > Date.now() && cached.comments.length >= safeLimit) {
    return { profile: cached.profile, comments: cached.comments.slice(0, safeLimit) };
  }

  const profile = await db.collection<Profile>('profiles').findOne({ username });

  if (!profile || !profile._id) {
    return null;
  }

  const fetchLimit = Math.max(safeLimit, 50);
  const comments = await db
    .collection<Comment>('comments')
    .find({ profile_id: profile._id })
    .sort({ created_at: -1 })
    .limit(fetchLimit)
    .toArray();

  profileDetailCache.set(username, {
    expiresAt: Date.now() + PUBLIC_CACHE_TTL_MS,
    profile,
    comments,
  });

  const edgeCache = getEdgeCache();
  if (edgeCache) {
    const cacheUrl = `${EDGE_CACHE_ORIGIN}/profile/${username}`;
    await edgeCache
      .put(
        cacheUrl,
        new Response(JSON.stringify({ profile, comments }), {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': `public, max-age=${EDGE_CACHE_TTL_SECONDS}`,
          },
        })
      )
      .catch(() => undefined);
  }

  return { profile, comments: comments.slice(0, safeLimit) };
}

/**
 * Consulta o cache (memória + Cloudflare Edge Cache) antes de abrir conexão com o MongoDB Atlas,
 * evitando o handshake TLS/SCRAM em leituras repetidas.
 */
export async function getCachedProfileWithComments(
  env: Env,
  rawUsername: string,
  limit = 20
): Promise<{ profile: Profile; comments: Comment[] } | null> {
  const username = normalizeUsername(rawUsername);
  const safeLimit = Math.min(Math.max(1, limit), 100);
  const cached = profileDetailCache.get(username);
  if (cached && cached.expiresAt > Date.now()) {
    return { profile: cached.profile, comments: cached.comments.slice(0, safeLimit) };
  }

  const edgeCache = getEdgeCache();
  if (edgeCache) {
    const hit = await edgeCache.match(`${EDGE_CACHE_ORIGIN}/profile/${username}`).catch(() => undefined);
    if (hit) {
      const parsed = (await hit.json()) as { profile: Profile; comments: Comment[] };
      const revivedProfile = reviveProfile(parsed.profile);
      const revivedComments = parsed.comments.map(reviveComment);
      profileDetailCache.set(username, {
        expiresAt: Date.now() + PUBLIC_CACHE_TTL_MS,
        profile: revivedProfile,
        comments: revivedComments,
      });
      return { profile: revivedProfile, comments: revivedComments.slice(0, safeLimit) };
    }
  }

  const { db } = await getDatabase(env);
  return findProfileWithComments(db, username, safeLimit);
}

/**
 * Cria conta (`users`) + perfil 1:1 (`profiles`) — usado pelo cadastro local e pelo OAuth (RN1).
 */
export async function createAccountWithProfile(
  db: Db,
  data: {
    email: string;
    username: string;
    displayName: string;
    passwordHash: string | null;
    authProvider: User['auth_provider'];
    authProviderId: string | null;
    bio?: string;
    avatarUrl?: string;
    themeConfig?: ProfileThemeConfig;
  }
): Promise<{ user: User; profile: Profile }> {
  const now = new Date();
  const userId = new ObjectId();
  const profileId = new ObjectId();

  const user: User = {
    _id: userId,
    email: data.email,
    password_hash: data.passwordHash,
    auth_provider: data.authProvider,
    auth_provider_id: data.authProviderId,
    created_at: now,
    updated_at: now,
  };

  const profile: Profile = {
    _id: profileId,
    user_id: userId,
    username: data.username,
    display_name: data.displayName,
    bio: data.bio,
    avatar_url: data.avatarUrl,
    theme_config: { ...DEFAULT_THEME, ...(data.themeConfig || {}) },
    created_at: now,
    updated_at: now,
  };

  await db.collection<User>('users').insertOne(user);
  try {
    await db.collection<Profile>('profiles').insertOne(profile);
  } catch (err) {
    // Mantém a regra 1:1 (RN1): desfaz a conta caso o perfil não possa ser criado
    await db.collection<User>('users').deleteOne({ _id: userId });
    throw err;
  }

  await invalidatePublicCache(profile.username);
  return { user, profile };
}

/**
 * GET /api/profiles
 * Busca e listagem paginada de perfis públicos (RF7).
 */
profilesRouter.get('/', async (c) => {
  try {
    const query = c.req.query('q')?.trim().slice(0, 64) || '';
    const limit = Math.min(Math.max(1, Number(c.req.query('limit')) || 20), 50);
    const page = Math.max(1, Number(c.req.query('page')) || 1);
    const skip = (page - 1) * limit;
    const cacheKey = `${query.toLowerCase()}:${page}:${limit}`;

    const cached = profileListCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return c.json({
        profiles: cached.profiles.map(serializeProfile),
        pagination: { page, limit, count: cached.profiles.length },
      });
    }

    const edgeCache = !query && page === 1 ? getEdgeCache() : null;
    if (edgeCache) {
      const hit = await edgeCache.match(`${EDGE_CACHE_ORIGIN}/profiles-list`).catch(() => undefined);
      if (hit) {
        const rawList = (await hit.json()) as Profile[];
        const revived = rawList.map(reviveProfile).slice(0, limit);
        profileListCache.set(cacheKey, {
          expiresAt: Date.now() + PUBLIC_CACHE_TTL_MS,
          profiles: revived,
        });
        return c.json({
          profiles: revived.map(serializeProfile),
          pagination: { page, limit, count: revived.length },
        });
      }
    }

    const { db } = await getDatabase(c.env);

    const filter: Record<string, unknown> = {};
    if (query) {
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { username: { $regex: escaped, $options: 'i' } },
        { display_name: { $regex: escaped, $options: 'i' } },
      ];
    }

    const profiles = await db
      .collection<Profile>('profiles')
      .find(filter)
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    profileListCache.set(cacheKey, {
      expiresAt: Date.now() + PUBLIC_CACHE_TTL_MS,
      profiles,
    });

    if (edgeCache) {
      await edgeCache
        .put(
          `${EDGE_CACHE_ORIGIN}/profiles-list`,
          new Response(JSON.stringify(profiles), {
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': `public, max-age=${EDGE_CACHE_TTL_SECONDS}`,
            },
          })
        )
        .catch(() => undefined);
    }

    return c.json({
      profiles: profiles.map(serializeProfile),
      pagination: { page, limit, count: profiles.length },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

/**
 * POST /api/profiles
 * Cria uma conta de usuário (users) e seu respectivo perfil 1:1 (profiles) (RF1, RF2, RN1, RN2, RN15)
 * e autentica o usuário automaticamente (UC01, RN16).
 */
profilesRouter.post('/', async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'Payload JSON inválido.' }, 400);
    }

    const rawEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const rawUsername = typeof body.username === 'string' ? body.username : '';
    const rawDisplayName = typeof body.display_name === 'string' ? body.display_name : '';
    const rawPassword = typeof body.password === 'string' ? body.password : '';

    if (!rawEmail || !isValidEmail(rawEmail)) {
      return c.json({ error: 'Email inválido ou ausente.' }, 400);
    }

    const usernameValidation = validateUsername(rawUsername);
    if (!usernameValidation.valid) {
      return c.json({ error: usernameValidation.error }, 400);
    }

    // Em produção toda conta local precisa de senha; em dev/teste contas de demonstração sem senha são aceitas.
    const requirePassword = c.env.NODE_ENV === 'production';
    if (rawPassword || requirePassword) {
      const passwordError = validatePassword(rawPassword);
      if (passwordError) {
        return c.json({ error: passwordError }, 400);
      }
    }

    const username = usernameValidation.username;
    const displayName = sanitizeText(rawDisplayName || username).slice(0, MAX_DISPLAY_NAME_LENGTH);
    if (!displayName) {
      return c.json({ error: 'O nome de exibição (display_name) é obrigatório.' }, 400);
    }

    if (body.avatar_url !== undefined && body.avatar_url !== null && body.avatar_url !== '' && !isSafeAvatarUrl(body.avatar_url)) {
      return c.json({ error: 'avatar_url deve ser uma URL http(s) válida.' }, 400);
    }

    const { db } = await getDatabase(c.env);

    // Verifica unicidade de email e username em paralelo (RN2)
    const [existingUser, existingProfile] = await Promise.all([
      db.collection<User>('users').findOne({ email: rawEmail }),
      db.collection<Profile>('profiles').findOne({ username }),
    ]);
    if (existingUser) {
      return c.json({ error: 'Já existe uma conta cadastrada com este email.' }, 409);
    }
    if (existingProfile) {
      return c.json({ error: 'Este nome de usuário já está em uso (RN2).' }, 409);
    }

    const { user, profile } = await createAccountWithProfile(db, {
      email: rawEmail,
      username,
      displayName,
      passwordHash: rawPassword ? await hashPassword(rawPassword) : null,
      // O cadastro público é sempre local; contas OAuth são criadas apenas pelo fluxo /api/auth/google
      authProvider: 'local',
      authProviderId: null,
      bio: typeof body.bio === 'string' ? sanitizeText(body.bio).slice(0, MAX_BIO_LENGTH) : undefined,
      avatarUrl: typeof body.avatar_url === 'string' && body.avatar_url ? body.avatar_url.trim() : undefined,
      themeConfig: sanitizeThemeConfig(body.theme_config),
    });

    // Autentica automaticamente após o cadastro (UC01) e pré-popula o cache de sessão
    const session = await createSessionForUser(c, db, user._id!, { user, profile });
    const { ipHash } = await getClientIdentity(c.req.raw);
    await logAuditEvent(db, 'account.created', {
      user_id: user._id,
      profile_id: profile._id,
      ip_hash: ipHash,
      username,
      has_password: !!user.password_hash,
    });

    return c.json(
      {
        message: 'Conta e perfil criados com sucesso.',
        profile: serializeProfile(profile),
        session_token: session.token,
        session_expires_at: session.expiresAt.toISOString(),
      },
      201
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

/**
 * GET /api/profiles/:username
 * Retorna os dados públicos do perfil e seus comentários (RF9, RNF3).
 */
profilesRouter.get('/:username', async (c) => {
  try {
    const rawUsername = c.req.param('username');
    const limit = Number(c.req.query('limit')) || 20;

    const result = await getCachedProfileWithComments(c.env, rawUsername, limit);
    if (!result) {
      return c.json({ error: 'Perfil não encontrado.' }, 404);
    }

    const { originFingerprint } = await getClientIdentity(c.req.raw);

    return c.json({
      profile: serializeProfile(result.profile),
      comments: result.comments.map((comment) => serializeComment(comment, originFingerprint)),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

/**
 * PATCH /api/profiles/:username
 * Atualiza dados públicos e estilização (theme_config) do perfil (RF3, RF8, RNF5).
 * Exige que o solicitante seja o dono do perfil (UC02).
 */
profilesRouter.patch('/:username', async (c) => {
  try {
    const username = normalizeUsername(c.req.param('username'));
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'Payload JSON inválido.' }, 400);
    }

    const { db } = await getDatabase(c.env);
    const existing = await db.collection<Profile>('profiles').findOne({ username });
    if (!existing) {
      return c.json({ error: 'Perfil não encontrado.' }, 404);
    }

    const authz = await authorizeProfileOwner(c, db, existing);
    if (!authz.ok) {
      await logAuditEvent(db, 'auth.unauthorized', { profile_id: existing._id, operation: 'profile.update' });
      return c.json({ error: authz.error }, authz.status);
    }

    const updates: Partial<Profile> = {
      updated_at: new Date(),
    };

    if (typeof body.display_name === 'string') {
      const sanitizedName = sanitizeText(body.display_name).slice(0, MAX_DISPLAY_NAME_LENGTH);
      if (!sanitizedName) {
        return c.json({ error: 'display_name não pode ser vazio.' }, 400);
      }
      updates.display_name = sanitizedName;
    }

    if (typeof body.bio === 'string') {
      updates.bio = sanitizeText(body.bio).slice(0, MAX_BIO_LENGTH);
    }

    if (typeof body.avatar_url === 'string') {
      const trimmed = body.avatar_url.trim();
      if (trimmed && !isSafeAvatarUrl(trimmed)) {
        return c.json({ error: 'avatar_url deve ser uma URL http(s) válida.' }, 400);
      }
      updates.avatar_url = trimmed || undefined;
    }

    if (body.theme_config !== undefined) {
      const sanitizedTheme = sanitizeThemeConfig(body.theme_config);
      if (sanitizedTheme) {
        updates.theme_config = {
          ...(existing.theme_config || {}),
          ...sanitizedTheme,
        };
      }
    }

    await db.collection<Profile>('profiles').updateOne({ _id: existing._id }, { $set: updates });
    await invalidatePublicCache(existing.username);
    const updated = { ...existing, ...updates };
    if (authz.auth) {
      await cacheSessionContext(authz.auth.session._id, {
        ...authz.auth,
        profile: updated,
      });
    }

    await logAuditEvent(db, 'profile.updated', {
      user_id: existing.user_id,
      profile_id: existing._id,
      fields: Object.keys(updates).filter((k) => k !== 'updated_at'),
    });

    return c.json({
      message: 'Perfil atualizado com sucesso.',
      profile: serializeProfile(updated || { ...existing, ...updates }),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

/**
 * POST /api/profiles/:username/avatar
 * Upload da foto de perfil para o Cloudflare R2 (RF3). Aceita `multipart/form-data` (campo `avatar`)
 * ou o binário da imagem diretamente no corpo com `Content-Type: image/*`. Limite de 2 MB.
 */
profilesRouter.post('/:username/avatar', async (c) => {
  try {
    const bucket = c.env.AVATARS_BUCKET;
    if (!bucket) {
      return c.json({ error: 'Armazenamento de avatares (R2) não configurado neste ambiente.' }, 503);
    }

    const username = normalizeUsername(c.req.param('username'));
    const { db } = await getDatabase(c.env);
    const profile = await db.collection<Profile>('profiles').findOne({ username });
    if (!profile || !profile._id) {
      return c.json({ error: 'Perfil não encontrado.' }, 404);
    }

    const authz = await authorizeProfileOwner(c, db, profile);
    if (!authz.ok) {
      await logAuditEvent(db, 'auth.unauthorized', { profile_id: profile._id, operation: 'profile.avatar' });
      return c.json({ error: authz.error }, authz.status);
    }

    const requestType = (c.req.header('Content-Type') || '').toLowerCase();
    let contentType: string;
    let data: ArrayBuffer;

    if (requestType.startsWith('multipart/form-data')) {
      const form = await c.req.formData();
      const file = form.get('avatar');
      if (!file || typeof file === 'string') {
        return c.json({ error: 'Envie a imagem no campo "avatar".' }, 400);
      }
      contentType = file.type.toLowerCase();
      data = await file.arrayBuffer();
    } else {
      contentType = requestType.split(';')[0].trim();
      data = await c.req.arrayBuffer();
    }

    const extension = AVATAR_CONTENT_TYPES[contentType];
    if (!extension) {
      return c.json({ error: 'Formato inválido. Use PNG, JPEG, WEBP ou GIF.' }, 415);
    }
    if (data.byteLength === 0) {
      return c.json({ error: 'Arquivo de imagem vazio.' }, 400);
    }
    if (data.byteLength > AVATAR_MAX_BYTES) {
      return c.json({ error: 'A imagem excede o limite de 2 MB.' }, 413);
    }

    const key = `${profile._id.toString()}-${Date.now()}.${extension}`;
    await bucket.put(`avatars/${key}`, data, {
      httpMetadata: { contentType, cacheControl: 'public, max-age=31536000, immutable' },
    });

    const previousKey = extractAvatarKey(profile.avatar_url);
    if (previousKey) {
      await bucket.delete(`avatars/${previousKey}`).catch(() => undefined);
    }

    const avatarUrl = `${new URL(c.req.url).origin}/api/avatars/${key}`;
    const updatedAt = new Date();
    await db
      .collection<Profile>('profiles')
      .updateOne({ _id: profile._id }, { $set: { avatar_url: avatarUrl, updated_at: updatedAt } });
    await invalidatePublicCache(profile.username);
    if (authz.auth) {
      await cacheSessionContext(authz.auth.session._id, {
        ...authz.auth,
        profile: { ...profile, avatar_url: avatarUrl, updated_at: updatedAt },
      });
    }

    await logAuditEvent(db, 'profile.avatar_uploaded', {
      user_id: profile.user_id,
      profile_id: profile._id,
      bytes: data.byteLength,
      content_type: contentType,
    });

    return c.json({ message: 'Avatar atualizado com sucesso.', avatar_url: avatarUrl });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

/** Extrai a chave do objeto R2 a partir de uma URL `/api/avatars/<key>` gerada pelo sistema. */
export function extractAvatarKey(avatarUrl: string | undefined | null): string | null {
  if (!avatarUrl) return null;
  const match = avatarUrl.match(/\/api\/avatars\/([a-f0-9]{24}-\d+\.(?:png|jpg|webp|gif))$/);
  return match ? match[1] : null;
}

/**
 * DELETE /api/profiles/:username
 * Exclui a conta, o perfil, as sessões e todos os comentários associados em cascata (RF4, RN3, RN10).
 * Exige que o solicitante seja o dono do perfil (UC03).
 */
profilesRouter.delete('/:username', async (c) => {
  try {
    const username = normalizeUsername(c.req.param('username'));
    const { db } = await getDatabase(c.env);

    const profile = await db.collection<Profile>('profiles').findOne({ username });
    if (!profile || !profile._id) {
      return c.json({ error: 'Perfil não encontrado.' }, 404);
    }

    const authz = await authorizeProfileOwner(c, db, profile);
    if (!authz.ok) {
      await logAuditEvent(db, 'auth.unauthorized', { profile_id: profile._id, operation: 'account.delete' });
      return c.json({ error: authz.error }, authz.status);
    }

    const rawToken = extractSessionToken(c);
    const [commentsDeleteResult] = await Promise.all([
      db.collection('comments').deleteMany({ profile_id: profile._id }),
      db.collection('sessions').deleteMany({ user_id: profile.user_id }),
      db.collection('password_reset_tokens').deleteMany({ user_id: profile.user_id }),
      db.collection('profiles').deleteOne({ _id: profile._id }),
      db.collection('users').deleteOne({ _id: profile.user_id }),
    ]);
    await invalidatePublicCache(profile.username);
    await invalidateSessionCache(authz.auth?.session._id);
    if (rawToken && !authz.auth) {
      await invalidateSessionCache();
    }

    const avatarKey = extractAvatarKey(profile.avatar_url);
    if (avatarKey && c.env.AVATARS_BUCKET) {
      await c.env.AVATARS_BUCKET.delete(`avatars/${avatarKey}`).catch(() => undefined);
    }

    await logAuditEvent(db, 'account.deleted', {
      user_id: profile.user_id,
      profile_id: profile._id,
      username,
      deleted_comments_count: commentsDeleteResult.deletedCount,
    });

    return c.json({
      message: 'Conta, perfil e comentários excluídos permanentemente (RN3).',
      deleted_comments_count: commentsDeleteResult.deletedCount,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});
