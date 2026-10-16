/**
 * Utilitários de segurança, sanitização XSS, hashing criptográfico (Web Crypto API)
 * e validação/resolução de subdomínios para o ambiente Cloudflare Workers.
 */

export const RESERVED_USERNAMES = new Set([
  'www',
  'api',
  'admin',
  'mail',
  'smtp',
  'pop',
  'imap',
  'ftp',
  'dev',
  'preview-prod',
  'prod',
  'staging',
  'test',
  'static',
  'assets',
  'cdn',
  'r2',
  'widget',
  'auth',
  'oauth',
  'login',
  'logout',
  'register',
  'signup',
  'signin',
  'reset',
  'setup',
  'health',
  'status',
  'u',
  'user',
  'users',
  'profile',
  'profiles',
  'comment',
  'comments',
  'root',
  'system',
  'support',
  'help',
]);

const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Sanitiza conteúdo textual contra ataques de XSS (RNF4),
 * escapando tags e caracteres especiais HTML.
 */
export function sanitizeText(input: string): string {
  return input
    .trim()
    .replace(/[&<>"']/g, (char) => HTML_ESCAPE_MAP[char] || char);
}

/**
 * Gera um hash SHA-256 em formato hexadecimal usando a Web Crypto API nativa do Worker.
 * Utilizado para ip_hash (RNF1) e origin_fingerprint (RN9).
 */
export async function hashSha256(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(value);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Normaliza um username para minúsculas e sem espaços nas extremidades.
 */
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

/**
 * Valida se o username atende às regras de formato de subdomínio DNS (RN2)
 * e não colide com rotas/subdomínios reservados do sistema (RN15).
 */
export function validateUsername(rawUsername: string): { valid: boolean; username: string; error?: string } {
  const username = normalizeUsername(rawUsername);

  if (username.length < 3 || username.length > 30) {
    return {
      valid: false,
      username,
      error: 'O nome de usuário deve ter entre 3 e 30 caracteres.',
    };
  }

  if (!/^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])?$/.test(username)) {
    return {
      valid: false,
      username,
      error: 'O nome de usuário deve conter apenas letras minúsculas, números e hifens (sem iniciar ou terminar com hífen).',
    };
  }

  if (RESERVED_USERNAMES.has(username)) {
    return {
      valid: false,
      username,
      error: `O nome de usuário "${username}" é reservado pelo sistema (RN15).`,
    };
  }

  return { valid: true, username };
}

/**
 * Extrai o username a partir do header Host quando a requisição é feita via subdomínio (RN2).
 * Suporta tanto produção (`<username>.nicolaspitz.dev`) quanto subdomínios de ambiente
 * (`<username>.dev.nicolaspitz.dev`) e desenvolvimento local (`<username>.localhost:8787`).
 */
export function extractSubdomainUsername(
  hostHeader: string | undefined,
  rootDomain = 'nicolaspitz.dev'
): string | null {
  if (!hostHeader) {
    return null;
  }

  // Remove porta caso exista (ex: joao.localhost:8787 -> joao.localhost)
  const hostname = hostHeader.split(':')[0].trim().toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname === '127.0.0.1') {
    return null;
  }

  let candidate: string | null = null;
  const normalizedRoot = rootDomain.trim().toLowerCase();

  if (hostname.endsWith('.localhost')) {
    const prefix = hostname.slice(0, -'.localhost'.length);
    const parts = prefix.split('.');
    candidate = parts[0] || null;
  } else if (hostname === normalizedRoot) {
    return null;
  } else if (hostname.endsWith(`.${normalizedRoot}`)) {
    const prefix = hostname.slice(0, -`.${normalizedRoot}`.length);
    const parts = prefix.split('.');
    // Suporta tanto `<username>.nicolaspitz.dev` quanto `<username>.dev.nicolaspitz.dev`
    candidate = parts[0] || null;
  }

  if (!candidate || RESERVED_USERNAMES.has(candidate)) {
    return null;
  }

  return candidate;
}

/**
 * Obtém o ip_hash (para rate limit - RNF1) e origin_fingerprint (para unicidade de likes - RN9)
 * a partir dos headers da requisição no Cloudflare Worker.
 */
export async function getClientIdentity(req: Request): Promise<{
  ipHash: string;
  originFingerprint: string;
}> {
  const clientIp =
    req.headers.get('CF-Connecting-IP') ||
    req.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    '127.0.0.1';
  const userAgent = req.headers.get('User-Agent') || 'unknown-agent';
  const customOrigin = req.headers.get('X-Origin-Fingerprint')?.trim();

  const ipHash = await hashSha256(`ip:${clientIp}`);
  const originFingerprint = customOrigin
    ? await hashSha256(`custom:${customOrigin}`)
    : await hashSha256(`origin:${clientIp}|${userAgent}`);

  return { ipHash, originFingerprint };
}
