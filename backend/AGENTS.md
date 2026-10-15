# Backend — GuestBook API

## Stack
- **Runtime:** Cloudflare Workers (`nodejs_compat`, `compatibility_date: 2026-10-01`)
- **HTTP Framework:** Hono v4
- **Database:** MongoDB Atlas (driver oficial `mongodb`, lazy-loaded)
- **Testes:** Vitest + `@cloudflare/vitest-plugin`
- **IaC:** Pulumi Python (em `/pulumi-prj`)

## Arquitetura de Arquivos
- `src/index.ts`: Entrypoint do Worker, middleware CORS, rotas base (`/health`, `/api/setup/indexes`).
- `src/db.ts`: Gerenciamento de conexão com MongoDB Atlas (reúso de isolate, `maxPoolSize: 5`, `ensureIndexes`).
- `src/types.ts`: Interfaces TypeScript das coleções de dados.
- `wrangler.jsonc`: Configuração do Worker e flags de compatibilidade.
- `.dev.vars`: Variáveis de ambiente locais (`MONGODB_URI`, `DATABASE_NAME`). Ignorado no Git.

## Modelagem de Dados (MongoDB Atlas)
- **`users`**: Contas e credenciais. Índices: `email` (único, case-insensitive), `{ auth_provider, auth_provider_id }`.
- **`profiles`**: Páginas de guestbook (1:1 com `users`). Índices: `user_id` (único), `username` (único, case-insensitive).
- **`comments`**: Comentários por `profile_id`. Contém `likes_count` e array `liked_by` (fingerprints). Índices: `{ profile_id, created_at: -1 }`, `{ ip_hash, created_at: -1 }`.
- **`sessions`**: Tokens de sessão. Índice TTL: `{ expires_at: 1 }` (`expireAfterSeconds: 0`).
- **`password_reset_tokens`**: Tokens de recuperação com índice TTL.

## Regras Técnicas do Runtime
1. **Serverless Connection Pooling:** Conexão MongoDB mantida em escopo global (`cachedClient`) para reuso dentro do mesmo isolate.
2. **Likes Concorrentes:** Operação atômica em `comments` via `$addToSet` e `$inc` para evitar locks e race conditions em testes de estresse.
3. **Subdomínios:** Roteamento baseado no header `Host` (`*.dominio.com` -> perfil, raiz -> app).
4. **Sessões:** Cookie `HttpOnly; Domain=.dominio.com; SameSite=Lax`.

## Comandos Principais
```bash
npm run dev          # Iniciar servidor local (http://localhost:8787)
npm test             # Executar testes unitários com Vitest
npm run cf-typegen   # Regenerar definições de tipos do Worker
npx wrangler deploy  # Publicar Worker na Cloudflare
```

## Endpoints Atuais
- `GET /`: Retorno de texto simples.
- `GET /health`: Estado do Worker e status de conexão com MongoDB.
- `POST /api/setup/indexes`: Criação idempotente de índices e coleções no MongoDB.
