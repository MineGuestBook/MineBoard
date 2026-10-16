import type { MongoClient, Db } from 'mongodb';

export interface Env {
  MONGODB_URI: string;
  DATABASE_NAME?: string;
  NODE_ENV?: string;
  ROOT_DOMAIN?: string;
  RATE_LIMIT_MAX_PER_MINUTE?: string;
}

let testDbOverride: Db | null = null;

/**
 * Permite injetar uma instância de banco (mock/in-memory) durante a execução de testes no Vitest.
 */
export function setTestDatabase(db: Db | null): void {
  testDbOverride = db;
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
 * Obtém a conexão com o MongoDB Atlas.
 * No Cloudflare Workers, a conexão é reaproveitada entre requisições no mesmo isolate,
 * reduzindo a latência de handshake TLS e evitando estourar o pool de conexões.
 */
export async function getDatabase(env: Env): Promise<{ client: MongoClient | null; db: Db }> {
  if (testDbOverride) {
    return { client: null, db: testDbOverride };
  }

  if (!env.MONGODB_URI) {
    throw new Error('Variável MONGODB_URI não configurada. Defina no .dev.vars (local) ou em Secrets (produção).');
  }

  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(env.MONGODB_URI, getMongoConnectionOptions());

  await client.connect();
  const dbName = env.DATABASE_NAME || 'guestbook';
  const db = client.db(dbName);

  return { client, db };
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
  await db.collection('password_reset_tokens').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
}
