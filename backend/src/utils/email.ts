import type { Env } from '../db';
import { logAuditEvent } from './audit';

/**
 * Cliente mínimo da API do Resend (https://resend.com/docs/api-reference/emails/send-email).
 * Sem dependências externas: apenas `fetch`, compatível com Cloudflare Workers.
 */

export interface EmailResult {
  sent: boolean;
  simulated: boolean;
  id?: string;
  error?: string;
}

interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Converte entidades HTML (conteúdo já sanitizado no banco) de volta para texto puro. */
function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

export function getAppUrl(env: Env): string {
  if (env.APP_URL) return env.APP_URL.replace(/\/+$/, '');
  return `https://${env.ROOT_DOMAIN || 'nicolaspitz.dev'}`;
}

/**
 * Envia um email via Resend. Sem `RESEND_API_KEY` (local/testes), apenas registra o evento
 * e retorna `simulated: true`, sem interromper o fluxo da requisição.
 */
export async function sendEmail(env: Env, message: EmailMessage): Promise<EmailResult> {
  if (!env.RESEND_API_KEY) {
    await logAuditEvent(null, 'email.simulated', { to_domain: message.to.split('@')[1], subject: message.subject });
    return { sent: false, simulated: true };
  }

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM || 'GuestBook <onboarding@resend.dev>',
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
    });

    if (!response.ok) {
      const error = `Resend HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`;
      await logAuditEvent(null, 'email.failed', { subject: message.subject, error });
      return { sent: false, simulated: false, error };
    }

    const data = (await response.json().catch(() => ({}))) as { id?: string };
    await logAuditEvent(null, 'email.sent', { subject: message.subject, email_id: data.id });
    return { sent: true, simulated: false, id: data.id };
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    await logAuditEvent(null, 'email.failed', { subject: message.subject, error });
    return { sent: false, simulated: false, error };
  }
}

/**
 * Notifica o dono do perfil sobre um novo comentário (RF15, RN13, UC11).
 * `authorName` e `content` chegam já sanitizados (HTML escapado) do banco.
 */
export async function sendNewCommentNotification(
  env: Env,
  toEmail: string,
  profileUsername: string,
  authorName: string,
  content: string
): Promise<EmailResult> {
  const appUrl = getAppUrl(env);
  const profileUrl = `${appUrl}/u/${encodeURIComponent(profileUsername)}`;
  const plainAuthor = decodeEntities(authorName);
  const plainContent = decodeEntities(content);
  const preview = plainContent.length > 500 ? `${plainContent.slice(0, 500)}…` : plainContent;

  return sendEmail(env, {
    to: toEmail,
    subject: `📖 Novo recado no seu GuestBook de ${plainAuthor}`,
    text: `${plainAuthor} deixou um novo recado no seu GuestBook (@${profileUsername}):\n\n"${preview}"\n\nVeja em: ${profileUrl}`,
    html: `<div style="font-family:monospace;background:#121212;color:#e0e0e0;padding:24px">
  <h2 style="color:#00ffcc">📖 Novo recado no seu GuestBook!</h2>
  <p><strong>${escapeHtml(plainAuthor)}</strong> escreveu em <strong>@${escapeHtml(profileUsername)}</strong>:</p>
  <blockquote style="border-left:3px solid #00ffcc;padding-left:12px;white-space:pre-wrap">${escapeHtml(preview)}</blockquote>
  <p><a href="${escapeHtml(profileUrl)}" style="color:#00ffcc">Ver no GuestBook</a></p>
</div>`,
  });
}

/**
 * Envia o link de redefinição de senha de uso único (RF6, RN4, UC05).
 */
export async function sendPasswordResetEmail(env: Env, toEmail: string, token: string): Promise<EmailResult> {
  const resetUrl = `${getAppUrl(env)}/reset-password?token=${encodeURIComponent(token)}`;

  return sendEmail(env, {
    to: toEmail,
    subject: '🔑 Redefinição de senha do GuestBook',
    text: `Recebemos um pedido para redefinir sua senha.\n\nAcesse o link abaixo (válido por 1 hora e de uso único):\n${resetUrl}\n\nSe você não fez esse pedido, ignore este email.`,
    html: `<div style="font-family:monospace;background:#121212;color:#e0e0e0;padding:24px">
  <h2 style="color:#00ffcc">🔑 Redefinição de senha</h2>
  <p>Recebemos um pedido para redefinir a senha da sua conta no GuestBook.</p>
  <p><a href="${escapeHtml(resetUrl)}" style="color:#00ffcc">Clique aqui para definir uma nova senha</a></p>
  <p style="color:#888">O link é válido por 1 hora e pode ser usado apenas uma vez. Se você não fez esse pedido, ignore este email.</p>
</div>`,
  });
}
