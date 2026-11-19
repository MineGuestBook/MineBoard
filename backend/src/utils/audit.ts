import type { Db } from 'mongodb';
import type { ObjectId } from 'bson';
import type { AuditLog } from '../types';

export type AuditAction =
  | 'account.created'
  | 'account.deleted'
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.logout'
  | 'auth.oauth_login'
  | 'auth.password_changed'
  | 'auth.password_reset_requested'
  | 'auth.password_reset_completed'
  | 'auth.unauthorized'
  | 'profile.updated'
  | 'profile.avatar_uploaded'
  | 'comment.created'
  | 'comment.deleted'
  | 'comment.rate_limited'
  | 'email.sent'
  | 'email.simulated'
  | 'email.failed';

export interface AuditDetails {
  user_id?: ObjectId | null;
  profile_id?: ObjectId | null;
  ip_hash?: string | null;
  [key: string]: unknown;
}

/**
 * Registra operações críticas (requisito geral: log de operações para análise posterior).
 * - Sempre emite uma linha JSON estruturada no console (capturada por Workers Logs / observability).
 * - Quando um `db` é informado, persiste também na coleção `audit_logs` (TTL de 90 dias).
 * Nunca lança erro: falhas de log não podem quebrar o fluxo principal.
 */
export async function logAuditEvent(db: Db | null, action: AuditAction, details: AuditDetails = {}): Promise<void> {
  const { user_id = null, profile_id = null, ip_hash = null, ...rest } = details;
  const createdAt = new Date();

  try {
    console.log(
      JSON.stringify({
        type: 'audit',
        action,
        user_id: user_id?.toString() ?? null,
        profile_id: profile_id?.toString() ?? null,
        ip_hash,
        ...rest,
        created_at: createdAt.toISOString(),
      })
    );
  } catch {
    // ignora falha de serialização
  }

  if (!db) return;

  try {
    const entry: AuditLog = {
      action,
      user_id,
      profile_id,
      ip_hash,
      details: rest,
      created_at: createdAt,
    };
    await db.collection<AuditLog>('audit_logs').insertOne(entry);
  } catch {
    // ignora falha de persistência do log
  }
}
