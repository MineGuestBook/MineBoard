import { AsyncLocalStorage } from 'node:async_hooks';
import type { MongoClient, Db } from 'mongodb';

export interface Env {
  MONGODB_URI: string;
  DATABASE_NAME?: string;
  NODE_ENV?: string;
  ROOT_DOMAIN?: string;
  RATE_LIMIT_MAX_PER_MINUTE?: string;
  /** Origem pública do frontend (Cloudflare Pages) para proxy de assets e links em emails. */
  PAGES_ORIGIN?: string;
  /** URL pública da aplicação usada em links de email e redirects OAuth (ex: https://dev.nicolaspitz.dev). */
  APP_URL?: string;
  /** Nome do cookie de sessão (permite isolar dev/prod no mesmo domínio raiz). */
  SESSION_COOKIE_NAME?: string;
  /** Envio de emails via Resend (RF6, RF15). */
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  /** OAuth Google (requisito geral: autenticação via provedor externo). */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Protege rotas administrativas /api/setup/* em produção. */
  SETUP_TOKEN?: string;
  /** Bucket R2 para avatares e assets de estilização (RF3). */
  AVATARS_BUCKET?: R2Bucket;
}

let testDbOverride: Db | null = null;
const cacheResetListeners: Array<() => void> = [];

export function onDatabaseReset(listener: () => void): void {
  cacheResetListeners.push(listener);
}

/**
 * Permite injetar uma instância de banco (mock/in-memory) durante a execução de testes no Vitest.
 */
export function setTestDatabase(db: Db | null): void {
  testDbOverride = db;
  for (const listener of cacheResetListeners) {
    listener();
  }
}

/**
 * Retorna as opções padronizadas de conexão do driver MongoDB para Cloudflare Workers.
 * maxPoolSize: 1 e minPoolSize: 0 são mandatórios para prevenir travamentos de sockets e esgotamento de conexões em isolates serverless.
 */
export function getMongoConnectionOptions() {
  return {
    maxPoolSize: 1,
    minPoolSize: 0,
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
  };
}

/**
 * Escopo de conexão por requisição.
 * Um cache global de MongoClient entre requisições causa deadlocks de I/O em isolates do Workers
 * (sockets não podem ser reutilizados por outra requisição). Por isso a conexão é reaproveitada
 * apenas dentro da mesma requisição e fechada ao final (ver `withRequestDatabaseScope`).
 */
interface RequestDbScope {
  pending: Promise<{ client: MongoClient; db: Db }> | null;
}

const requestScope = new AsyncLocalStorage<RequestDbScope>();

/**
 * Executa `fn` dentro de um escopo de conexão por requisição e fecha o client ao final.
 */
export async function withRequestDatabaseScope<T>(fn: () => Promise<T>): Promise<T> {
  const scope: RequestDbScope = { pending: null };
  try {
    return await requestScope.run(scope, fn);
  } finally {
    if (scope.pending) {
      const pending = scope.pending;
      scope.pending = null;
      pending.then(({ client }) => client.close()).catch(() => undefined);
    }
  }
}

async function connect(env: Env): Promise<{ client: MongoClient; db: Db }> {
  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(env.MONGODB_URI, getMongoConnectionOptions());
  await client.connect();
  const dbName = env.DATABASE_NAME || 'guestbook';
  return { client, db: client.db(dbName) };
}

/**
 * Obtém a conexão com o MongoDB Atlas, reutilizando-a durante a mesma requisição.
 */
export async function getDatabase(env: Env): Promise<{ client: MongoClient | null; db: Db }> {
  if (testDbOverride) {
    return { client: null, db: testDbOverride };
  }

  if (!env.MONGODB_URI) {
    throw new Error('Variável MONGODB_URI não configurada. Defina no .dev.vars (local) ou em Secrets (produção).');
  }

  const scope = requestScope.getStore();
  if (!scope) {
    return connect(env);
  }

  if (!scope.pending) {
    scope.pending = connect(env);
    scope.pending.catch(() => {
      scope.pending = null;
    });
  }
  return scope.pending;
}

/**
 * Cria os índices necessários no MongoDB Atlas de forma idempotente.
 */
export async function ensureIndexes(db: Db): Promise<void> {
  // Índices para users
  await db.collection('users').createIndex(
    { email: 1 },
    { unique: true, collation: { locale: 'en', strength: 2 } }
  );
  await db.collection('users').createIndex({ auth_provider: 1, auth_provider_id: 1 });

  // Índices para profiles
  await db.collection('profiles').createIndex({ user_id: 1 }, { unique: true });
  await db.collection('profiles').createIndex(
    { username: 1 },
    { unique: true, collation: { locale: 'en', strength: 2 } }
  );

  // Índices para comments
  await db.collection('comments').createIndex({ profile_id: 1, created_at: -1 });
  await db.collection('comments').createIndex({ ip_hash: 1, created_at: -1 });

  // Índices para sessions (TTL index: expira automaticamente!)
  await db.collection('sessions').createIndex({ user_id: 1 });
  await db.collection('sessions').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });

  // Índices para password_reset_tokens
  await db.collection('password_reset_tokens').createIndex({ token_hash: 1 }, { unique: true });
  await db.collection('password_reset_tokens').createIndex({ user_id: 1 });
  await db.collection('password_reset_tokens').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });

  // Índices para audit_logs (retenção de 90 dias para análise posterior)
  await db.collection('audit_logs').createIndex({ action: 1, created_at: -1 });
  await db.collection('audit_logs').createIndex(
    { created_at: 1 },
    { expireAfterSeconds: 60 * 60 * 24 * 90 }
  );
}
