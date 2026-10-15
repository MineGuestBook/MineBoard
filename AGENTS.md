# GuestBook (MineBoard) — Monorepo

## Visão Geral
O **GuestBook** é uma aplicação web de livros de visitas retrô construída sobre a plataforma **Cloudflare** (Workers, Pages, R2, DNS Wildcard) com persistência distribuída no **MongoDB Atlas**.

## Estrutura do Monorepo
- `/backend`: API RESTful serverless em Cloudflare Workers + Hono + MongoDB Atlas (`nodejs_compat`). Veja `backend/AGENTS.md`.
- `/pulumi-prj`: Infraestrutura como Código (IaC) em Python + Pulumi gerenciando DNS, Wildcard DNS e `WorkersRoute` na Cloudflare. Veja `pulumi-prj/AGENTS.md`.
- `/docs`: Documentação de requisitos funcionais/não funcionais, casos de uso (`UCs/`), DER e diagrama de blocos.

## Fluxo Obrigatório de Git e Branches
1. **Nunca faça commits ou push direto na `main` ou na `dev`.**
2. **Sempre parta da branch `dev` atualizada:**
   ```bash
   git checkout dev && git pull origin dev
   ```
3. **Crie uma branch específica para a funcionalidade ou correção:**
   ```bash
   git checkout -b feat/nome-da-funcionalidade
   ```
4. **Valide todos os checks do CI antes de abrir Pull Request:**
   - `cd backend && npm run typecheck`
   - `cd backend && npm test -- --run`
   - `cd backend && npx wrangler deploy --dry-run`
   - `python3 -m py_compile pulumi-prj/__main__.py`
5. **Abra sempre o Pull Request apontando para a branch `dev` (`base: dev`)** seguindo o template `.github/pull_request_template.md`.
