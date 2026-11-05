import { Hono } from 'hono';
import type { Context } from 'hono';
import { ObjectId } from 'bson';
import type { Db } from 'mongodb';
import { Env, getDatabase } from '../db';
import { Comment, Profile, User } from '../types';
import { serializeComment } from './profiles';
import {
  getClientIdentity,
  isValidEmail,
  normalizeUsername,
  sanitizeText,
} from '../utils/security';
import { authorizeProfileOwner } from '../utils/session';
import { logAuditEvent } from '../utils/audit';
import { EmailResult, sendNewCommentNotification } from '../utils/email';

export const profileCommentsRouter = new Hono<{ Bindings: Env }>();
export const commentsRouter = new Hono<{ Bindings: Env }>();

export const MAX_AUTHOR_NAME_LENGTH = 60;

/**
 * Notifica o dono do perfil sobre um novo comentário (RF15, UC11).
 * RN13: só envia se a conta existir e tiver email válido cadastrado.
 * A busca do dono é feita durante a requisição; o envio HTTP ao Resend é o único passo assíncrono.
 */
export async function notifyProfileOwner(
  db: Db,
  env: Env,
  profile: Profile,
  comment: Comment
): Promise<{ eligible: boolean; send?: () => Promise<EmailResult> }> {
  const owner = await db.collection<User>('users').findOne({ _id: profile.user_id });
  if (!owner || !isValidEmail(owner.email)) {
    return { eligible: false };
  }

  return {
    eligible: true,
    send: () => sendNewCommentNotification(env, owner.email, profile.username, comment.author_name, comment.content),
  };
}

/** Executa uma tarefa após a resposta via `waitUntil` quando disponível. */
function runInBackground(c: Context<{ Bindings: Env }>, task: Promise<unknown>): void {
  const guarded = task.catch(() => undefined);
  try {
    c.executionCtx.waitUntil(guarded);
  } catch {
    // Sem ExecutionContext (ex.: chamadas diretas em testes): a promise segue sem bloquear a resposta
  }
}

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
    const rawAuthorName =
      typeof body.author_name === 'string' ? sanitizeText(body.author_name).slice(0, MAX_AUTHOR_NAME_LENGTH) : '';
    const authorName = rawAuthorName || 'Anônimo';

    const trimmedEmail =
      typeof body.author_email === 'string' ? body.author_email.trim().toLowerCase() : '';
    if (trimmedEmail && !isValidEmail(trimmedEmail)) {
      return c.json({ error: 'author_email inválido. Informe um email válido ou deixe em branco.' }, 400);
    }
    const rawAuthorEmail = trimmedEmail ? sanitizeText(trimmedEmail) : undefined;

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
      await logAuditEvent(db, 'comment.rate_limited', { profile_id: profile._id, ip_hash: ipHash });
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
    await logAuditEvent(db, 'comment.created', {
      profile_id: profile._id,
      comment_id: newComment._id?.toString(),
      ip_hash: ipHash,
      anonymous: authorName === 'Anônimo',
    });

    // Notificação por email ao dono do perfil (RF15, RN13, UC11)
    const notification = await notifyProfileOwner(db, c.env, profile, newComment);
    if (notification.eligible && notification.send) {
      runInBackground(c, notification.send());
    }

    return c.json(
      {
        message: 'Comentário publicado com sucesso.',
        comment: serializeComment(newComment, originFingerprint),
        owner_notified: notification.eligible,
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
 * Somente o dono do perfil onde o comentário foi publicado pode excluí-lo (RN8).
 */
commentsRouter.delete('/:id', async (c) => {
  try {
    const rawId = c.req.param('id');
    if (!ObjectId.isValid(rawId)) {
      return c.json({ error: 'ID de comentário inválido.' }, 400);
    }

    const commentId = new ObjectId(rawId);
    const { db } = await getDatabase(c.env);

    const comment = await db.collection<Comment>('comments').findOne({ _id: commentId });
    if (!comment) {
      return c.json({ error: 'Comentário não encontrado.' }, 404);
    }

    const profile = await db.collection<Profile>('profiles').findOne({ _id: comment.profile_id });
    if (profile) {
      const authz = await authorizeProfileOwner(c, db, profile);
      if (!authz.ok) {
        await logAuditEvent(db, 'auth.unauthorized', { profile_id: profile._id, operation: 'comment.delete' });
        return c.json({ error: authz.error }, authz.status);
      }
    }

    // Likes ficam embutidos no documento (liked_by/likes_count) e são removidos junto (RN10)
    const deleteResult = await db.collection<Comment>('comments').deleteOne({ _id: commentId });
    if (deleteResult.deletedCount === 0) {
      return c.json({ error: 'Comentário não encontrado.' }, 404);
    }

    await logAuditEvent(db, 'comment.deleted', {
      user_id: profile?.user_id ?? null,
      profile_id: comment.profile_id,
      comment_id: rawId,
    });

    return c.json({
      message: 'Comentário e curtidas associadas removidos com sucesso (RF12, RN10).',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});
