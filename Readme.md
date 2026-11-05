# GuestBook (MineBoard)

Um livro de visitas (guestbook) na web, no estilo dos sites antigos: cada usuário cria uma conta e ganha uma página de perfil própria (`<username>.nicolaspitz.dev` ou `/u/<username>`), que pode estilizar do jeito que quiser. Qualquer visitante, sem precisar de conta ou login, pode ver os comentários de qualquer perfil e deixar um comentário nele, informando um nome livre (ou ficando anônimo) e opcionalmente um email de contato.

O dono do perfil pode excluir comentários no seu próprio perfil. A conta autenticada serve só para gerenciar o próprio perfil (criar, editar, trocar/recuperar senha, excluir). O sistema também notifica por email via **Resend** quando alguém recebe um novo comentário, e oferece um widget embutível (`<script>` Shadow DOM ou `<iframe>`) para o usuário colocar seu guestbook em outros sites.

## Arquitetura do Monorepo

- [`/backend`](./backend): API RESTful serverless em **Cloudflare Workers + Hono + MongoDB Atlas (`nodejs_compat`) + Cloudflare R2 + Resend**, com especificação OpenAPI 3.0 (`/api/openapi.json` e `/api/docs`).
- [`/frontend`](./frontend): SPA retrô leve em **HTML/CSS/TypeScript Vanilla + Vite**, com suporte automático a portal raiz e subdomínios de usuários.
- [`/pulumi-prj`](./pulumi-prj): Infraestrutura como Código (IaC) em **Python + Pulumi** gerenciando DNS, Wildcard DNS, `WorkersRoute`, `R2Bucket` e `PagesProject` na Cloudflare.
- [`/docs`](./docs): Documentação completa de requisitos, casos de uso (`UCs/`), DER e diagrama de blocos.

## Documentação

| Documento | Descrição |
|---|---|
| [Requisitos](./docs/requisitosfuncionais.md) | Requisitos funcionais, não funcionais e regras de negócio |
| [Casos de Uso](./docs/casos_de_uso.md) | Descrição textual dos casos de uso (UC01–UC11) |
| [Diagrama de Blocos](./docs/diagrama_de_blocos.md) | Arquitetura Cloudflare Workers, Pages, R2, MongoDB Atlas e Resend |
| [Modelagem de Dados (DER)](./docs/der.md) | Diagrama Entidade-Relacionamento e coleções do MongoDB Atlas |
| [Fluxos individuais](./docs/UCs/) | Um fluxograma por caso de uso |

## Como Executar Localmente

```bash
# 1. Iniciar a API do Backend (http://localhost:8787)
cd backend && npm install && npm run dev

# 2. Iniciar o Frontend Web (http://localhost:5173)
cd frontend && npm install && npm run dev

# 3. Executar testes automatizados e checagem de tipos
cd backend && npm run typecheck && npm test -- --run
cd frontend && npm run typecheck && npm run build
```
