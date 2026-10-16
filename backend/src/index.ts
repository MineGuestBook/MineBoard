import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ObjectId } from 'bson';
import { Env, getDatabase, ensureIndexes } from './db';
import { Profile, User, Comment } from './types';
import {
  profilesRouter,
  findProfileWithComments,
  serializeProfile,
  serializeComment,
} from './routes/profiles';
import { profileCommentsRouter, commentsRouter } from './routes/comments';
import { extractSubdomainUsername, getClientIdentity } from './utils/security';

const app = new Hono<{ Bindings: Env }>();

// Permite requisições CORS de qualquer origem para facilitar testes e widget externo
app.use('*', cors());

// Endpoint base (mantido para compatibilidade com smoke tests)
app.get('/', (c) => {
  return c.text('Hello World!');
});

// Health check para monitoramento e verificação do MongoDB
app.get('/health', async (c) => {
  let dbStatus = 'not_configured';

  if (c.env.MONGODB_URI) {
    try {
      const { db } = await getDatabase(c.env);
      await db.command({ ping: 1 });
      dbStatus = 'connected';
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      dbStatus = `connection_failed: ${message}`;
    }
  }

  return c.json({
    status: 'ok',
    service: 'guestbook-api',
    database: dbStatus,
    timestamp: new Date().toISOString(),
  });
});

// Endpoint para inicializar índices no MongoDB Atlas de forma idempotente
app.post('/api/setup/indexes', async (c) => {
  try {
    const { db } = await getDatabase(c.env);
    await ensureIndexes(db);
    return c.json({ success: true, message: 'Índices do MongoDB Atlas inicializados com sucesso.' });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ success: false, error: message }, 500);
  }
});

// Endpoint idempotente de seed para demonstração da Sprint (BD + Workers)
app.post('/api/setup/seed', async (c) => {
  try {
    const { db } = await getDatabase(c.env);
    await ensureIndexes(db);

    const demoUsername = 'joaosilva';
    let profile = await db.collection<Profile>('profiles').findOne({ username: demoUsername });

    if (!profile) {
      const now = new Date();
      const userId = new ObjectId();
      const profileId = new ObjectId();

      const demoUser: User = {
        _id: userId,
        email: 'joao@exemplo.com',
        password_hash: null,
        auth_provider: 'local',
        auth_provider_id: null,
        created_at: now,
        updated_at: now,
      };

      profile = {
        _id: profileId,
        user_id: userId,
        username: demoUsername,
        display_name: 'João Silva (Demo)',
        bio: 'Bem-vindo ao meu GuestBook retrô rodando em Cloudflare Workers + MongoDB Atlas!',
        theme_config: {
          background_color: '#121212',
          card_background: '#1e1e1e',
          text_color: '#e0e0e0',
          accent_color: '#00ffcc',
          font_family: 'monospace',
        },
        created_at: now,
        updated_at: now,
      };

      await db.collection<User>('users').insertOne(demoUser);
      await db.collection<Profile>('profiles').insertOne(profile);

      const sampleComments: Comment[] = [
        {
          _id: new ObjectId(),
          profile_id: profileId,
          author_name: 'Maria',
          author_email: 'maria@exemplo.com',
          content: 'Parabéns pelo GuestBook! Muito nostálgico!',
          ip_hash: 'seed-ip-hash-1',
          likes_count: 2,
          liked_by: ['seed-fp-1', 'seed-fp-2'],
          created_at: now,
        },
        {
          _id: new ObjectId(),
          profile_id: profileId,
          author_name: 'Anônimo',
          content: 'Passando para deixar um recado anônimo no mural!',
          ip_hash: 'seed-ip-hash-2',
          likes_count: 1,
          liked_by: ['seed-fp-1'],
          created_at: new Date(now.getTime() + 1000),
        },
      ];

      await db.collection<Comment>('comments').insertMany(sampleComments);
    }

    return c.json({
      success: true,
      message: 'Dados de demonstração garantidos no MongoDB Atlas.',
      profile: serializeProfile(profile),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ success: false, error: message }, 500);
  }
});

// Resolução automática de perfil por subdomínio via header Host ou URL (RN2: <username>.nicolaspitz.dev)
app.get('/api/host-profile', async (c) => {
  try {
    const hostHeader =
      c.req.header('X-Forwarded-Host') ||
      c.req.header('Host') ||
      new URL(c.req.url).host;
    const rootDomain = c.env.ROOT_DOMAIN || 'nicolaspitz.dev';
    const subdomainUsername = extractSubdomainUsername(hostHeader, rootDomain);

    if (!subdomainUsername) {
      return c.json(
        {
          mode: 'root',
          host: hostHeader || null,
          message: 'Requisição no domínio principal ou subdomínio reservado.',
        },
        200
      );
    }

    const { db } = await getDatabase(c.env);
    const result = await findProfileWithComments(db, subdomainUsername);
    if (!result) {
      return c.json(
        {
          mode: 'subdomain',
          username: subdomainUsername,
          error: `Perfil "${subdomainUsername}" não encontrado para este subdomínio.`,
        },
        404
      );
    }

    const { originFingerprint } = await getClientIdentity(c.req.raw);

    return c.json({
      mode: 'subdomain',
      profile: serializeProfile(result.profile),
      comments: result.comments.map((item) => serializeComment(item, originFingerprint)),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

// Endpoint para o widget embutível em sites de terceiros (RF14, RN11, RN12)
app.get('/api/widget/:username', async (c) => {
  try {
    const username = c.req.param('username');
    const limit = Number(c.req.query('limit')) || 10;
    const { db } = await getDatabase(c.env);

    const result = await findProfileWithComments(db, username, limit);
    if (!result) {
      return c.json({ error: 'Perfil não encontrado ou inativo (RN11).' }, 404);
    }

    const { originFingerprint } = await getClientIdentity(c.req.raw);

    return c.json({
      widget: true,
      profile: serializeProfile(result.profile),
      comments: result.comments.map((item) => serializeComment(item, originFingerprint)),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

// Registro dos módulos de rotas REST
app.route('/api/profiles', profilesRouter);
app.route('/api/profiles', profileCommentsRouter);
app.route('/api/comments', commentsRouter);

export default app;
