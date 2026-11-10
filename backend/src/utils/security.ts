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

// ---------------------------------------------------------------------------
// Senhas (RF5, RF6) — PBKDF2-SHA256 com salt via Web Crypto API
// ---------------------------------------------------------------------------

/** Máximo de iterações PBKDF2 suportado pelo runtime workerd. */
const PBKDF2_ITERATIONS = 100_000;
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Comparação em tempo constante para evitar timing attacks. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

/**
 * Valida requisitos mínimos de senha. Não compara com senhas anteriores (RN5).
 */
export function validatePassword(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `A senha deve ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `A senha deve ter no máximo ${MAX_PASSWORD_LENGTH} caracteres.`;
  }
  return null;
}

/**
 * Gera hash de senha no formato `pbkdf2$<iterações>$<salt_hex>$<hash_hex>`.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToHex(salt)}$${hash}`;
}

/**
 * Verifica uma senha contra o hash armazenado.
 * Mantém compatibilidade com hashes SHA-256 legados (64 caracteres hex sem salt).
 */
export async function verifyPassword(password: string, storedHash: string | null | undefined): Promise<boolean> {
  if (!storedHash) return false;

  if (storedHash.startsWith('pbkdf2$')) {
    const [, iterStr, saltHex, hashHex] = storedHash.split('$');
    const iterations = Number(iterStr);
    if (!iterations || !saltHex || !hashHex) return false;
    const candidate = await pbkdf2(password, hexToBytes(saltHex), iterations);
    return timingSafeEqual(candidate, hashHex);
  }

  if (/^[0-9a-f]{64}$/.test(storedHash)) {
    return timingSafeEqual(await hashSha256(password), storedHash);
  }

  return false;
}

/** Indica se o hash armazenado é legado e deve ser atualizado após login bem-sucedido. */
export function needsPasswordRehash(storedHash: string | null | undefined): boolean {
  return !!storedHash && !storedHash.startsWith('pbkdf2$');
}

/**
 * Gera um token aleatório criptograficamente seguro em hexadecimal.
 */
export function generateSecureToken(bytes = 32): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

// ---------------------------------------------------------------------------
// Estilização segura (RF8, RNF5) e URLs de avatar (RF3)
// ---------------------------------------------------------------------------

export const ALLOWED_FONT_FAMILIES = [
  'monospace',
  'serif',
  'sans-serif',
  'cursive',
  'Courier New',
  'Comic Sans MS',
  'Times New Roman',
  'Verdana',
  'Georgia',
  'Tahoma',
] as const;

const COLOR_REGEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Aceita apenas cores hexadecimais para impedir injeção de CSS (RNF5). */
export function isSafeColor(value: unknown): value is string {
  return typeof value === 'string' && COLOR_REGEX.test(value.trim());
}

/** Aceita apenas fontes da lista permitida (RNF5). */
export function isSafeFontFamily(value: unknown): value is string {
  return typeof value === 'string' && (ALLOWED_FONT_FAMILIES as readonly string[]).includes(value.trim());
}

/** Aceita apenas URLs http(s) de avatar, bloqueando esquemas como `javascript:` e `data:`. */
export function isSafeAvatarUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 512) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Validação simples de formato de email. */
export function isValidEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(value);
}
