import { Hono } from 'hono';
import { ObjectId } from 'bson';
import { Env, getDatabase } from '../db';
import { Comment, Profile } from '../types';
import { serializeComment } from './profiles';
import {
  getClientIdentity,
  normalizeUsername,
  sanitizeText,
} from '../utils/security';

export const profileCommentsRouter = new Hono<{ Bindings: Env }>();
export const commentsRouter = new Hono<{ Bindings: Env }>();

/**
 * GET /api/profiles/:username/comments
 * Lista comentários de um perfil de forma paginada e cronológica reversa (RF9, RNF3).
 */
profileCommentsRouter.get('/:username/comments', async (c) => {
  try {
    const username = normalizeUsername(c.req.param('username'));
    const limit = Math.min(Math.max(1, Number(c.req.query('limit')) || 20), 100);
    const page = Math.max(1, Number(c.req.query('page')) || 1);
    const skip = (page - 1) * limit;

    const { db } = await getDatabase(c.env);
    const profile = await db.collection<Profile>('profiles').findOne({ username });

    if (!profile || !profile._id) {
      return c.json({ error: 'Perfil não encontrado.' }, 404);
    }

    const { originFingerprint } = await getClientIdentity(c.req.raw);

    const comments = await db
      .collection<Comment>('comments')
      .find({ profile_id: profile._id })
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    return c.json({
      profile_username: profile.username,
      comments: comments.map((item) => serializeComment(item, originFingerprint)),
      pagination: { page, limit, count: comments.length },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

/**
 * POST /api/profiles/:username/comments
 * Publica um novo comentário em um perfil sem exigir autenticação (RF10, RF11, RN6, RN7, RNF1, RNF4).
 */
profileCommentsRouter.post('/:username/comments', async (c) => {
  try {
    const username = normalizeUsername(c.req.param('username'));
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'Payload JSON inválido.' }, 400);
    }

    const rawContent = typeof body.content === 'string' ? body.content : '';
    const sanitizedContent = sanitizeText(rawContent);
    if (!sanitizedContent) {
      return c.json({ error: 'O conteúdo do comentário (content) não pode ser vazio.' }, 400);
    }
    if (sanitizedContent.length > 2000) {
      return c.json({ error: 'O comentário excede o limite máximo de 2000 caracteres.' }, 400);
    }

    // Nome e email livres e opcionais (RN7) — se em branco, assume "Anônimo" (RF11)
    const rawAuthorName = typeof body.author_name === 'string' ? sanitizeText(body.author_name) : '';
    const authorName = rawAuthorName || 'Anônimo';

    const rawAuthorEmail =
      typeof body.author_email === 'string' && body.author_email.trim()
        ? sanitizeText(body.author_email.trim().toLowerCase())
        : undefined;

    const { db } = await getDatabase(c.env);
    const profile = await db.collection<Profile>('profiles').findOne({ username });
    if (!profile || !profile._id) {
      return c.json({ error: 'Perfil de destino não encontrado.' }, 404);
    }

    const { ipHash, originFingerprint } = await getClientIdentity(c.req.raw);

    // Rate Limiting por IP nos últimos 60 segundos (RNF1)
    const maxCommentsPerMinute = Number(c.env.RATE_LIMIT_MAX_PER_MINUTE) || 10;
    const oneMinuteAgo = new Date(Date.now() - 60_000);
    const recentCommentsByIp = await db.collection<Comment>('comments').countDocuments({
      ip_hash: ipHash,
      created_at: { $gte: oneMinuteAgo },
    });

    if (recentCommentsByIp >= maxCommentsPerMinute) {
      return c.json(
        {
          error: 'Limite de comentários por minuto atingido. Aguarde alguns instantes antes de enviar novamente (RNF1).',
        },
        429
      );
    }

    const newComment: Comment = {
      _id: new ObjectId(),
      profile_id: profile._id,
      author_name: authorName,
      author_email: rawAuthorEmail,
      content: sanitizedContent,
      ip_hash: ipHash,
      likes_count: 0,
      liked_by: [],
      created_at: new Date(),
    };

    await db.collection<Comment>('comments').insertOne(newComment);

    return c.json(
      {
        message: 'Comentário publicado com sucesso.',
        comment: serializeComment(newComment, originFingerprint),
      },
      201
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

/**
 * POST /api/comments/:id/like
 * Registra um like atômico no comentário usando $addToSet e $inc (RF13, RN9, RNF2).
 */
commentsRouter.post('/:id/like', async (c) => {
  try {
    const rawId = c.req.param('id');
    if (!ObjectId.isValid(rawId)) {
      return c.json({ error: 'ID de comentário inválido.' }, 400);
    }

    const commentId = new ObjectId(rawId);
    const { originFingerprint } = await getClientIdentity(c.req.raw);
    const { db } = await getDatabase(c.env);

    const updateResult = await db.collection<Comment>('comments').updateOne(
      { _id: commentId, liked_by: { $ne: originFingerprint } },
      {
        $addToSet: { liked_by: originFingerprint },
        $inc: { likes_count: 1 },
      }
    );

    if (updateResult.matchedCount === 0) {
      const existing = await db.collection<Comment>('comments').findOne({ _id: commentId });
      if (!existing) {
        return c.json({ error: 'Comentário não encontrado.' }, 404);
      }

      return c.json(
        {
          error: 'Esta origem já curtiu este comentário (RN9).',
          already_liked: true,
          likes_count: existing.likes_count,
        },
        409
      );
    }

    const updated = await db.collection<Comment>('comments').findOne({ _id: commentId });

    return c.json({
      message: 'Curtida registrada com sucesso.',
      likes_count: updated?.likes_count ?? 1,
      liked_by_me: true,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

/**
 * DELETE /api/comments/:id/like
 * Remove o like da origem atual de forma atômica ($pull e $inc: -1).
 */
commentsRouter.delete('/:id/like', async (c) => {
  try {
    const rawId = c.req.param('id');
    if (!ObjectId.isValid(rawId)) {
      return c.json({ error: 'ID de comentário inválido.' }, 400);
    }

    const commentId = new ObjectId(rawId);
    const { originFingerprint } = await getClientIdentity(c.req.raw);
    const { db } = await getDatabase(c.env);

    const updateResult = await db.collection<Comment>('comments').updateOne(
      { _id: commentId, liked_by: originFingerprint },
      {
        $pull: { liked_by: originFingerprint },
        $inc: { likes_count: -1 },
      }
    );

    if (updateResult.matchedCount === 0) {
      const existing = await db.collection<Comment>('comments').findOne({ _id: commentId });
      if (!existing) {
        return c.json({ error: 'Comentário não encontrado.' }, 404);
      }
      return c.json({ error: 'Esta origem ainda não curtiu este comentário.' }, 400);
    }

    const updated = await db.collection<Comment>('comments').findOne({ _id: commentId });

    return c.json({
      message: 'Curtida removida com sucesso.',
      likes_count: updated?.likes_count ?? 0,
      liked_by_me: false,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

/**
 * DELETE /api/comments/:id
 * Exclui um comentário e todos os seus likes associados (RF12, RN8, RN10).
 */
commentsRouter.delete('/:id', async (c) => {
  try {
    const rawId = c.req.param('id');
    if (!ObjectId.isValid(rawId)) {
      return c.json({ error: 'ID de comentário inválido.' }, 400);
    }

    const commentId = new ObjectId(rawId);
    const { db } = await getDatabase(c.env);

    const deleteResult = await db.collection<Comment>('comments').deleteOne({ _id: commentId });
    if (deleteResult.deletedCount === 0) {
      return c.json({ error: 'Comentário não encontrado.' }, 404);
    }

    return c.json({
      message: 'Comentário e curtidas associadas removidos com sucesso (RF12, RN10).',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});
