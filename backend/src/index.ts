import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { cors } from 'hono/cors';
import { ObjectId } from 'bson';
import { Env, getDatabase, ensureIndexes, withRequestDatabaseScope } from './db';
import { Profile, User, Comment } from './types';
import {
  profilesRouter,
  findProfileWithComments,
  serializeProfile,
  serializeComment,
} from './routes/profiles';
import { profileCommentsRouter, commentsRouter } from './routes/comments';
import { authRouter } from './routes/auth';
import { extractSubdomainUsername, getClientIdentity, timingSafeEqual } from './utils/security';
import { renderWidgetEmbedScript, renderWidgetFrameHtml } from './widget';
import { openApiSpec, renderSwaggerUiHtml } from './openapi';

const app = new Hono<{ Bindings: Env }>();

// Permite requisições CORS de qualquer origem para facilitar testes e widget externo.
// Sem `credentials`, navegadores não enviam cookies de sessão em requisições cross-origin.
app.use('/api/*', cors());

// Uma única conexão MongoDB por requisição, fechada ao final (evita vazamento de conexões no Atlas)
app.use('*', (_c, next) => withRequestDatabaseScope(() => next()));

/**
 * Protege rotas administrativas em produção: exige header `X-Setup-Token` igual ao secret `SETUP_TOKEN`.
 */
async function requireSetupToken(c: Context<{ Bindings: Env }>, next: Next) {
  if (c.env.NODE_ENV === 'production') {
    const provided = c.req.header('X-Setup-Token') || '';
    if (!c.env.SETUP_TOKEN || !timingSafeEqual(provided, c.env.SETUP_TOKEN)) {
      return c.json({ error: 'Rota administrativa protegida.' }, 403);
    }
  }
  await next();
}
app.use('/api/setup/*', requireSetupToken);

/**
 * Encaminha requisições de páginas/assets para o frontend estático no Cloudflare Pages,
 * mantendo domínio raiz e subdomínios de usuário na mesma origem da API (cookies RN16).
 */
async function proxyToPages(c: Context<{ Bindings: Env }>): Promise<Response> {
  const url = new URL(c.req.url);
  const target = new URL(url.pathname + url.search, c.env.PAGES_ORIGIN);
  const upstream = await fetch(target.toString(), {
    method: c.req.method,
    headers: c.req.raw.headers,
    body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : c.req.raw.body,
    redirect: 'manual',
  });
  return new Response(upstream.body, upstream);
}

// Endpoint base (mantido para compatibilidade com smoke tests quando o frontend não está configurado)
app.get('/', (c) => {
  if (c.env.PAGES_ORIGIN) {
    return proxyToPages(c);
  }
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

// Script embutível do widget: <script src=".../api/widget/<username>/embed.js"></script> (UC10)
app.get('/api/widget/:username/embed.js', async (c) => {
  try {
    const { db } = await getDatabase(c.env);
    const result = await findProfileWithComments(db, c.req.param('username'), 1);
    if (!result) {
      return c.body('console.warn("GuestBook: perfil não encontrado (RN11).");', 404, {
        'Content-Type': 'application/javascript; charset=utf-8',
      });
    }
    const origin = new URL(c.req.url).origin;
    return c.body(renderWidgetEmbedScript(origin, result.profile.username), 200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

// Versão HTML do widget para uso em <iframe> (UC10)
app.get('/api/widget/:username/frame', async (c) => {
  try {
    const limit = Number(c.req.query('limit')) || 10;
    const { db } = await getDatabase(c.env);
    const result = await findProfileWithComments(db, c.req.param('username'), limit);
    if (!result) {
      return c.html('<p style="font-family:monospace">Perfil não encontrado (RN11).</p>', 404);
    }
    const origin = new URL(c.req.url).origin;
    return c.html(renderWidgetFrameHtml(origin, result.profile, result.comments), 200, {
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:",
      'Cache-Control': 'public, max-age=60',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

// Serve avatares armazenados no Cloudflare R2 (RF3)
app.get('/api/avatars/:key', async (c) => {
  const bucket = c.env.AVATARS_BUCKET;
  if (!bucket) {
    return c.json({ error: 'Armazenamento de avatares (R2) não configurado.' }, 503);
  }
  const key = c.req.param('key');
  if (!/^[a-f0-9]{24}-\d+\.(?:png|jpg|webp|gif)$/.test(key)) {
    return c.json({ error: 'Avatar não encontrado.' }, 404);
  }
  const object = await bucket.get(`avatars/${key}`);
  if (!object) {
    return c.json({ error: 'Avatar não encontrado.' }, 404);
  }
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('ETag', object.httpEtag);
  headers.set('X-Content-Type-Options', 'nosniff');
  if (!headers.has('Cache-Control')) {
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  }
  return new Response(object.body, { headers });
});

// Documentação da API RESTful (OpenAPI 3.0 + Swagger UI)
app.get('/api/openapi.json', (c) => c.json(openApiSpec));
app.get('/api/docs', (c) => c.html(renderSwaggerUiHtml('/api/openapi.json')));

// Registro dos módulos de rotas REST
app.route('/api/auth', authRouter);
app.route('/api/profiles', profilesRouter);
app.route('/api/profiles', profileCommentsRouter);
app.route('/api/comments', commentsRouter);

// Rotas desconhecidas: JSON para a API; páginas do frontend (SPA) via Cloudflare Pages
app.notFound((c) => {
  const path = new URL(c.req.url).pathname;
  if (!path.startsWith('/api/') && path !== '/health' && c.env.PAGES_ORIGIN) {
    return proxyToPages(c);
  }
  return c.json({ error: 'Rota não encontrada.' }, 404);
});

export default app;
