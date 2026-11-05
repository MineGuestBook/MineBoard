# Backend — GuestBook API

## Stack
- **Runtime:** Cloudflare Workers (`nodejs_compat`, `compatibility_date: 2026-10-01`)
- **HTTP Framework:** Hono v4
- **Database:** MongoDB Atlas (driver oficial `mongodb` lazy-loaded com escopo por requisição via `AsyncLocalStorage` + `bson` para `ObjectId`)
- **Storage & Email:** Cloudflare R2 (`AVATARS_BUCKET` para upload de avatares) + Resend API (notificações e recuperação de senha)
- **Testes:** Vitest + `@cloudflare/vitest-plugin`
- **IaC:** Pulumi Python (em `/pulumi-prj`) + `wrangler.jsonc` (ambientes `dev` e `prod`)

## Arquitetura de Arquivos
- `src/index.ts`: Entrypoint do Worker, middleware CORS, escopo de conexão MongoDB por requisição, rotas base (`/health`, `/api/setup/indexes`, `/api/setup/seed`), resolução por subdomínio (`/api/host-profile`), widget (`/api/widget/:username`, `/api/widget/:username/embed.js`, `/api/widget/:username/frame`), avatares R2 (`/api/avatars/:key`), documentação OpenAPI (`/api/openapi.json`, `/api/docs`) e proxy transparente para o Cloudflare Pages.
- `src/db.ts`: Gerenciamento de conexão com MongoDB Atlas (`withRequestDatabaseScope`, `maxPoolSize: 1`, `ensureIndexes` e `setTestDatabase` para testes no Vitest).
- `src/types.ts`: Interfaces TypeScript das coleções de dados (`User`, `Profile`, `Comment`, `Session`, `PasswordResetToken`, `AuditLog`).
- `src/utils/security.ts`: Sanitização XSS (`sanitizeText`), hashing SHA-256 e PBKDF2-SHA256 com salt (`hashPassword`, `verifyPassword`), validação de temas/cores/fontes seguras (RNF5), bloqueio de usernames reservados (`RESERVED_USERNAMES` - RN15) e extração de subdomínio (`extractSubdomainUsername` - RN2).
- `src/utils/session.ts`: Emissão e verificação de sessões (`createSessionForUser`, `resolveAuthenticatedUser`, `authorizeProfileOwner`) com cookies `HttpOnly; Domain=.nicolaspitz.dev; SameSite=Lax` (RN16).
- `src/utils/email.ts`: Integração via `fetch` com a API do Resend para notificação de novos comentários (RF15, RN13, UC11) e recuperação de senha (RF6, RN4, UC05), com fallback simulado em ambiente de teste/local.
- `src/utils/audit.ts`: Registro estruturado de operações críticas (`logAuditEvent`) no console do Worker e na coleção `audit_logs` (TTL de 90 dias).
- `src/routes/auth.ts`: Autenticação local (`/api/auth/login`, `/api/auth/logout`, `/api/auth/me`), troca/redefinição de senha (`/api/auth/change-password`, `/api/auth/forgot-password`, `/api/auth/reset-password`) e OAuth 2.0 Google (`/api/auth/google`, `/api/auth/google/callback`).
- `src/routes/profiles.ts`: CRUD de contas e perfis (`/api/profiles`), autenticação automática no cadastro (UC01), upload de avatar no R2 (`POST /api/profiles/:username/avatar`), busca pública e exclusão em cascata (RN3).
- `src/routes/comments.ts`: Publicação de comentários públicos/anônimos com rate-limit por `ip_hash` (RNF1), disparo de notificação por email (RF15), curtidas atômicas via `$addToSet`/`$inc` (`/api/comments`) e exclusão restrita ao dono do perfil (RN8).
- `src/widget.ts`: Renderizador do script Web Component (Shadow DOM) e página de `<iframe>` do widget embutível (RF14, UC10).
- `src/openapi.ts`: Especificação OpenAPI 3.0 e interface Swagger UI.

## Comandos Principais
```bash
npm run dev                  # Iniciar servidor local (http://localhost:8787)
npm test -- --run            # Executar testes automatizados com Vitest
npm run typecheck            # Checagem estática de tipos TypeScript
npx wrangler deploy --dry-run # Smoke test de empacotamento do Worker
```

## Endpoints Atuais
- `GET /`: Retorno de texto simples (`Hello World!`) ou proxy para o frontend quando `PAGES_ORIGIN` está configurado.
- `GET /health`: Estado do Worker e status de conexão com MongoDB.
- `GET /api/openapi.json` e `GET /api/docs`: Especificação OpenAPI 3.0 e Swagger UI.
- `POST /api/setup/indexes`: Criação idempotente de índices e coleções no MongoDB.
- `POST /api/setup/seed`: Popula dados de demonstração de forma idempotente no MongoDB.
- `POST /api/auth/login`: Login com email e senha e emissão de cookie de sessão cross-subdomain (RN16).
- `POST /api/auth/logout`: Encerramento da sessão ativa.
- `GET /api/auth/me`: Dados do usuário autenticado e seu perfil.
- `POST /api/auth/change-password`: Alteração de senha pelo usuário autenticado (UC04, RN5).
- `POST /api/auth/forgot-password`: Solicitação de link/token de recuperação por email (UC05, RN4).
- `POST /api/auth/reset-password`: Redefinição de senha com token de uso único (UC05, RN4, RN5).
- `GET /api/auth/google` e `GET /api/auth/google/callback`: Fluxo OAuth 2.0 com Google.
- `GET /api/host-profile`: Resolve automaticamente o perfil e comentários a partir do subdomínio no header `Host`.
- `GET /api/widget/:username`: Retorna dados JSON do perfil e comentários para o widget embutível (RF14).
- `GET /api/widget/:username/embed.js`: Script JavaScript embutível com Shadow DOM (UC10).
- `GET /api/widget/:username/frame`: Página HTML para embutir via `<iframe>` (UC10).
- `GET /api/profiles`: Busca e listagem paginada de perfis públicos (`?q=`).
- `POST /api/profiles`: Criação de conta (`users`) + perfil 1:1 (`profiles`) + sessão automática (UC01).
- `GET /api/profiles/:username`: Visualização pública do perfil e comentários recentes.
- `PATCH /api/profiles/:username`: Atualização autenticada de nome, bio, avatar e `theme_config` (UC02).
- `POST /api/profiles/:username/avatar` e `GET /api/avatars/:key`: Upload e entrega de foto de perfil via Cloudflare R2 (RF3).
- `DELETE /api/profiles/:username`: Exclusão autenticada em cascata de conta, perfil, sessões e comentários (UC03, RN3).
- `GET /api/profiles/:username/comments`: Listagem paginada de comentários do perfil.
- `POST /api/profiles/:username/comments`: Publicação de comentário (identificado ou anônimo) com sanitização XSS, rate limit e notificação por email (RF15).
- `POST /api/comments/:id/like`: Like atômico por `origin_fingerprint` (`$addToSet` + `$inc`).
- `DELETE /api/comments/:id/like`: Remoção atômica de like (`$pull` + `$inc: -1`).
- `DELETE /api/comments/:id`: Exclusão de comentário e seus likes restrita ao dono do perfil (RF12, RN8, RN10).
