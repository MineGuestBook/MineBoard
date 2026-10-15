# Backend — GuestBook API

## Stack
- **Runtime:** Cloudflare Workers (`nodejs_compat`, `compatibility_date: 2026-10-01`)
- **HTTP Framework:** Hono v4
- **Database:** MongoDB Atlas (driver oficial `mongodb` lazy-loaded + `bson` para `ObjectId`)
- **Testes:** Vitest + `@cloudflare/vitest-plugin`
- **IaC:** Pulumi Python (em `/pulumi-prj`) + `wrangler.jsonc` (ambientes `dev` e `prod`)

## Arquitetura de Arquivos
- `src/index.ts`: Entrypoint do Worker, middleware CORS, rotas base (`/health`, `/api/setup/indexes`, `/api/setup/seed`), resolução por subdomínio (`/api/host-profile`) e widget (`/api/widget/:username`).
- `src/db.ts`: Gerenciamento de conexão com MongoDB Atlas (reúso de isolate via `cachedClient`, `maxPoolSize: 5`, `ensureIndexes` e `setTestDatabase` para testes no Vitest).
- `src/types.ts`: Interfaces TypeScript das coleções de dados (`User`, `Profile`, `Comment`, `Session`, `PasswordResetToken`).
- `src/utils/security.ts`: Sanitização XSS (`sanitizeText`), hashing SHA-256 via Web Crypto API (`hashSha256`), bloqueio de usernames reservados (`RESERVED_USERNAMES` - RN15) e extração de subdomínio (`extractSubdomainUsername` - RN2).
- `src/routes/profiles.ts`: CRUD de contas e perfis (`/api/profiles`), busca pública e exclusão em cascata (RN3).
- `src/routes/comments.ts`: Publicação de comentários públicos/anônimos com rate-limit por `ip_hash` (RNF1) e curtidas atômicas via `$addToSet`/`$inc` (`/api/comments`).
- `scripts/demo-requests.sh`: Script de demonstração ponta a ponta para testar todas as rotas no MongoDB Atlas.
- `wrangler.jsonc`: Configuração declarativa do Worker e ambientes `dev` e `prod`.

## Modelagem de Dados (MongoDB Atlas)
- **`users`**: Contas e credenciais. Índices: `email` (único, case-insensitive), `{ auth_provider, auth_provider_id }`.
- **`profiles`**: Páginas de guestbook (1:1 com `users`). Índices: `user_id` (único), `username` (único, case-insensitive).
- **`comments`**: Comentários por `profile_id`. Contém `likes_count` e array `liked_by` (fingerprints). Índices: `{ profile_id, created_at: -1 }`, `{ ip_hash, created_at: -1 }`.
- **`sessions`**: Tokens de sessão. Índice TTL: `{ expires_at: 1 }` (`expireAfterSeconds: 0`).
- **`password_reset_tokens`**: Tokens de recuperação com índice TTL.

## Regras Técnicas do Runtime
1. **Serverless Connection Pooling & Lazy Loading:** O pacote `mongodb` deve ser importado dinamicamente (`await import('mongodb')`) dentro de `getDatabase` e mantido em escopo global (`cachedClient`). Para `ObjectId`, importe de `bson`.
2. **Likes Concorrentes:** Operação atômica em `comments` via `$addToSet` e `$inc` para evitar locks e race conditions em testes de estresse.
3. **Subdomínios:** Roteamento baseado no header `Host` (`*.nicolaspitz.dev` -> perfil, raiz -> app).
4. **Sessões:** Cookie `HttpOnly; Domain=.nicolaspitz.dev; SameSite=Lax`.

## Comandos Principais
```bash
npm run dev                  # Iniciar servidor local (http://localhost:8787)
npm test -- --run            # Executar testes automatizados com Vitest
npm run typecheck            # Checagem estática de tipos TypeScript
npx wrangler deploy --dry-run # Smoke test de empacotamento do Worker
```

## Endpoints Atuais
- `GET /`: Retorno de texto simples (`Hello World!`).
- `GET /health`: Estado do Worker e status de conexão com MongoDB.
- `POST /api/setup/indexes`: Criação idempotente de índices e coleções no MongoDB.
- `POST /api/setup/seed`: Popula dados de demonstração de forma idempotente no MongoDB.
- `GET /api/host-profile`: Resolve automaticamente o perfil e comentários a partir do subdomínio no header `Host`.
- `GET /api/widget/:username`: Retorna dados do perfil e comentários para o widget embutível (RF14).
- `GET /api/profiles`: Busca e listagem paginada de perfis públicos (`?q=`).
- `POST /api/profiles`: Criação de conta (`users`) + perfil 1:1 (`profiles`).
- `GET /api/profiles/:username`: Visualização pública do perfil e comentários recentes.
- `PATCH /api/profiles/:username`: Atualização de nome, bio, avatar e `theme_config`.
- `DELETE /api/profiles/:username`: Exclusão em cascata de conta, perfil, sessões e comentários.
- `GET /api/profiles/:username/comments`: Listagem paginada de comentários do perfil.
- `POST /api/profiles/:username/comments`: Publicação de comentário (identificado ou anônimo) com sanitização XSS e rate limit.
- `POST /api/comments/:id/like`: Like atômico por `origin_fingerprint` (`$addToSet` + `$inc`).
- `DELETE /api/comments/:id/like`: Remoção atômica de like (`$pull` + `$inc: -1`).
- `DELETE /api/comments/:id`: Exclusão de comentário e seus likes.
