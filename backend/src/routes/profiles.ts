import { Hono } from 'hono';
import { ObjectId } from 'bson';
import type { Db } from 'mongodb';
import { Env, getDatabase } from '../db';
import { Profile, ProfileThemeConfig, User, Comment } from '../types';
import {
  hashSha256,
  normalizeUsername,
  sanitizeText,
  validateUsername,
} from '../utils/security';

export const profilesRouter = new Hono<{ Bindings: Env }>();

const ALLOWED_THEME_KEYS = new Set([
  'background_color',
  'card_background',
  'text_color',
  'accent_color',
  'font_family',
]);

function sanitizeThemeConfig(raw: unknown): ProfileThemeConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }

  const sanitized: ProfileThemeConfig = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (ALLOWED_THEME_KEYS.has(key) && typeof value === 'string') {
      sanitized[key] = sanitizeText(value).slice(0, 64);
    }
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
  const profile = await db.collection<Profile>('profiles').findOne({ username });

  if (!profile || !profile._id) {
    return null;
  }

  const safeLimit = Math.min(Math.max(1, limit), 100);
  const comments = await db
    .collection<Comment>('comments')
    .find({ profile_id: profile._id })
    .sort({ created_at: -1 })
    .limit(safeLimit)
    .toArray();

  return { profile, comments };
}

/**
 * GET /api/profiles
 * Busca e listagem paginada de perfis públicos (RF7).
 */
profilesRouter.get('/', async (c) => {
  try {
    const { db } = await getDatabase(c.env);
    const query = c.req.query('q')?.trim() || '';
    const limit = Math.min(Math.max(1, Number(c.req.query('limit')) || 20), 50);
    const page = Math.max(1, Number(c.req.query('page')) || 1);
    const skip = (page - 1) * limit;

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
 * Cria uma conta de usuário (users) e seu respectivo perfil 1:1 (profiles) (RF1, RF2, RN1, RN2, RN15).
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

    if (!rawEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
      return c.json({ error: 'Email inválido ou ausente.' }, 400);
    }

    const usernameValidation = validateUsername(rawUsername);
    if (!usernameValidation.valid) {
      return c.json({ error: usernameValidation.error }, 400);
    }

    const username = usernameValidation.username;
    const displayName = sanitizeText(rawDisplayName || username);
    if (!displayName) {
      return c.json({ error: 'O nome de exibição (display_name) é obrigatório.' }, 400);
    }

    const { db } = await getDatabase(c.env);

    // Verifica unicidade de email e username (RN2)
    const existingUser = await db.collection<User>('users').findOne({ email: rawEmail });
    if (existingUser) {
      return c.json({ error: 'Já existe uma conta cadastrada com este email.' }, 409);
    }

    const existingProfile = await db.collection<Profile>('profiles').findOne({ username });
    if (existingProfile) {
      return c.json({ error: 'Este nome de usuário já está em uso (RN2).' }, 409);
    }

    const now = new Date();
    const userId = new ObjectId();
    const profileId = new ObjectId();
    const passwordHash = rawPassword ? await hashSha256(rawPassword) : null;

    const newUser: User = {
      _id: userId,
      email: rawEmail,
      password_hash: passwordHash,
      auth_provider: body.auth_provider === 'google' || body.auth_provider === 'apple' ? body.auth_provider : 'local',
      auth_provider_id: typeof body.auth_provider_id === 'string' ? body.auth_provider_id : null,
      created_at: now,
      updated_at: now,
    };

    const newProfile: Profile = {
      _id: profileId,
      user_id: userId,
      username,
      display_name: displayName,
      bio: typeof body.bio === 'string' ? sanitizeText(body.bio) : undefined,
      avatar_url: typeof body.avatar_url === 'string' ? body.avatar_url.trim() : undefined,
      theme_config: sanitizeThemeConfig(body.theme_config) ?? {
        background_color: '#121212',
        card_background: '#1e1e1e',
        text_color: '#e0e0e0',
        accent_color: '#00ffcc',
        font_family: 'monospace',
      },
      created_at: now,
      updated_at: now,
    };

    await db.collection<User>('users').insertOne(newUser);
    await db.collection<Profile>('profiles').insertOne(newProfile);

    return c.json(
      {
        message: 'Conta e perfil criados com sucesso.',
        profile: serializeProfile(newProfile),
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
    const { db } = await getDatabase(c.env);

    const result = await findProfileWithComments(db, rawUsername, limit);
    if (!result) {
      return c.json({ error: 'Perfil não encontrado.' }, 404);
    }

    return c.json({
      profile: serializeProfile(result.profile),
      comments: result.comments.map((comment) => serializeComment(comment)),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

/**
 * PATCH /api/profiles/:username
 * Atualiza dados públicos e estilização (theme_config) do perfil (RF3, RF8, RNF5).
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

    const updates: Partial<Profile> = {
      updated_at: new Date(),
    };

    if (typeof body.display_name === 'string') {
      const sanitizedName = sanitizeText(body.display_name);
      if (!sanitizedName) {
        return c.json({ error: 'display_name não pode ser vazio.' }, 400);
      }
      updates.display_name = sanitizedName;
    }

    if (typeof body.bio === 'string') {
      updates.bio = sanitizeText(body.bio);
    }

    if (typeof body.avatar_url === 'string') {
      updates.avatar_url = body.avatar_url.trim();
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
    const updated = await db.collection<Profile>('profiles').findOne({ _id: existing._id });

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
 * DELETE /api/profiles/:username
 * Exclui a conta, o perfil, as sessões e todos os comentários associados em cascata (RF4, RN3, RN10).
 */
profilesRouter.delete('/:username', async (c) => {
  try {
    const username = normalizeUsername(c.req.param('username'));
    const { db } = await getDatabase(c.env);

    const profile = await db.collection<Profile>('profiles').findOne({ username });
    if (!profile || !profile._id) {
      return c.json({ error: 'Perfil não encontrado.' }, 404);
    }

    const commentsDeleteResult = await db
      .collection('comments')
      .deleteMany({ profile_id: profile._id });
    await db.collection('sessions').deleteMany({ user_id: profile.user_id });
    await db.collection('password_reset_tokens').deleteMany({ user_id: profile.user_id });
    await db.collection('profiles').deleteOne({ _id: profile._id });
    await db.collection('users').deleteOne({ _id: profile.user_id });

    return c.json({
      message: 'Conta, perfil e comentários excluídos permanentemente (RN3).',
      deleted_comments_count: commentsDeleteResult.deletedCount,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});
