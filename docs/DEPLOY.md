# Guia de Implantação (Deploy Independente / Fork)

Este documento descreve como qualquer pessoa (como o professor ou avaliador) pode implantar sua própria instância completa do **MineBoard (GuestBook)** na sua conta da **Cloudflare** e no **MongoDB Atlas**, seja via **GitHub Actions (CI/CD)** ou via linha de comando local.

---

## 1. Pré-requisitos

1. **Conta na Cloudflare** com um domínio próprio ativo na zona DNS (ex.: `meudominio.dev`).
   - Gere um **API Token** em *My Profile → API Tokens → Create Custom Token* com as permissões:
     - `Account → Workers R2 Storage: Edit`
     - `Account → Workers Scripts: Edit`
     - `Account → Cloudflare Pages: Edit`
     - `Zone → DNS: Edit`
     - `Zone → Workers Routes: Edit`
   - Anote o **Account ID** e o **Zone ID** na página inicial do domínio na Cloudflare.
2. **Cluster gratuito no MongoDB Atlas** (`M0 Free`):
   - Crie um usuário de banco e libere acesso de rede (`0.0.0.0/0` em *Network Access*, pois os IPs de saída do Cloudflare Workers são dinâmicos).
   - Copie a string de conexão (`mongodb+srv://usuario:senha@cluster...`).
3. **Conta gratuita no Pulumi Cloud** ([app.pulumi.com](https://app.pulumi.com)):
   - Gere um **Access Token** em *Settings → Access Tokens*.
4. *(Opcional)* **Resend API Key** (para envio real de emails) e credenciais **OAuth 2.0 Google**. Se omitidos, o sistema funciona normalmente e simula o envio de emails nos logs.

---

## 2. Implantação Automática via GitHub Actions (Recomendado)

1. Faça um **Fork** deste repositório no GitHub.
2. No seu fork, acesse **Settings → Secrets and variables → Actions**.
3. Na aba **Secrets**, cadastre:

| Secret | Obrigatório? | Descrição |
|---|:---:|---|
| `CLOUDFLARE_API_TOKEN` | **Sim** | Token de API da Cloudflare com permissões de Workers, Pages, R2 e DNS |
| `CLOUDFLARE_ACCOUNT_ID` | **Sim** | ID da sua conta Cloudflare |
| `CLOUDFLARE_ZONE_ID` | **Sim** | ID da zona DNS do seu domínio na Cloudflare |
| `PULUMI_ACCESS_TOKEN` | **Sim** | Token do Pulumi Cloud para provisionar DNS, Wildcard DNS, R2 e Pages |
| `MONGODB_URI` | **Sim** | String de conexão `mongodb+srv://...` do seu cluster MongoDB Atlas |
| `RESEND_API_KEY` | Opcional | Chave da API do Resend para notificações e recuperação de senha |
| `GOOGLE_CLIENT_ID` | Opcional | Client ID do Google OAuth 2.0 |
| `GOOGLE_CLIENT_SECRET` | Opcional | Client Secret do Google OAuth 2.0 |
| `SETUP_TOKEN` | Opcional | Token administrativo para proteger `/api/setup/indexes` e `/api/setup/seed` |

4. Na aba **Variables** (Repository Variables), cadastre para usar seu próprio domínio:

| Variável | Exemplo | Default (se omitido) | Descrição |
|---|---|---|---|
| `ROOT_DOMAIN` | `meudominio.dev` | `nicolaspitz.dev` | Domínio raiz gerenciado na Cloudflare |
| `DEV_SUBDOMAIN` | `dev` | `dev` | Subdomínio da stack `dev` (`dev.meudominio.dev`) |
| `PROD_SUBDOMAIN` | `@` ou `preview-prod` | `preview-prod` | Subdomínio da stack `prod` (`@` = domínio raiz) |
| `PAGES_PROJECT_PREFIX` | `mineboard-prof` | `mineboard-guestbook` | Prefixo único do projeto Cloudflare Pages (deve ser globalmente único na Cloudflare) |

5. **Disparar o Deploy ou Destroy:**
   - **Automático:** Qualquer `push` na branch `dev` publica o ambiente `dev`, e qualquer `push` na `main` publica `prod`.
   - **Manual (Deploy ou Destroy):** Vá na aba **Actions → CD — Deploy & Destroy Cloudflare**, clique em **Run workflow**, escolha:
     - `action`: `deploy` (subir tudo) ou `destroy` (derrubar a infraestrutura via Pulumi)
     - `environment`: `dev` ou `prod`

---

## 3. Implantação Manual via Terminal (Local)

Caso prefira subir diretamente da sua máquina:

```bash
# 1. Exporte suas credenciais
export CLOUDFLARE_API_TOKEN="seu_token_cloudflare"
export CLOUDFLARE_ACCOUNT_ID="seu_account_id"
export CLOUDFLARE_ZONE_ID="seu_zone_id"
export ROOT_DOMAIN="meudominio.dev"
export SUBDOMAIN="dev"
export PAGES_PROJECT_NAME="mineboard-meu-projeto-dev"

# 2. Provisionar DNS, Wildcard DNS, WorkersRoute, R2 e Pages com Pulumi
cd pulumi-prj
uv sync
uv run pulumi login
uv run pulumi stack select --create dev
uv run pulumi up --stack dev --yes

# 3. Publicar o Backend (Cloudflare Worker) e configurar o MongoDB
cd ../backend
npm ci
npx wrangler deploy --env dev \
  --var "ROOT_DOMAIN:${ROOT_DOMAIN}" \
  --var "APP_URL:https://${SUBDOMAIN}.${ROOT_DOMAIN}" \
  --var "PAGES_ORIGIN:https://${PAGES_PROJECT_NAME}.pages.dev"
npx wrangler secret put MONGODB_URI --env dev

# 4. Compilar e publicar o Frontend no Cloudflare Pages
cd ../frontend
npm ci
VITE_ROOT_DOMAIN="${ROOT_DOMAIN}" npm run build
npx --yes wrangler pages deploy dist --project-name "${PAGES_PROJECT_NAME}" --branch dev
```

Para destruir a infraestrutura provisionada depois dos testes:

```bash
cd pulumi-prj && uv run pulumi destroy --stack dev --yes
```
