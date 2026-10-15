import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Env, getDatabase, ensureIndexes } from './db';

const app = new Hono<{ Bindings: Env }>();

// Permite requisições CORS de qualquer origem para facilitar testes e widget externo
app.use('*', cors());

// Endpoint base
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

export default app;
