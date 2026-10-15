# Infraestrutura como Código (IaC) — Pulumi Cloudflare

## Stack
- **IaC Engine:** Pulumi (`pulumi>=3.0.0,<4.0.0`)
- **Provider:** `pulumi-cloudflare` v6 (`>=6.0.0,<7.0.0`)
- **Linguagem / Gerenciador:** Python (`>=3.14`) gerenciado com `uv`
- **Stacks Configuradas:** `dev` (`Pulumi.dev.yaml`) e `prod` (`Pulumi.prod.yaml`)

## Recursos Provisionados (`__main__.py`)
1. **`cloudflare.DnsRecord` (`dns-record-<stack>`):** Registro DNS principal do ambiente (`dev.nicolaspitz.dev` / `preview-prod.nicolaspitz.dev`) com proxy da Cloudflare ativo (`proxied=True`).
2. **`cloudflare.DnsRecord` (`dns-wildcard-<stack>`):** Registro DNS Wildcard (`*.dev.nicolaspitz.dev` / `*.preview-prod.nicolaspitz.dev`) para permitir subdomínios dinâmicos por usuário (`<username>.nicolaspitz.dev`, conforme **RN2**).
3. **`cloudflare.WorkersRoute` (`worker-route-<stack>` e `worker-wildcard-route-<stack>`):** Roteamento de borda conectando o domínio e os subdomínios wildcard ao script do Cloudflare Worker correspondente (`guestbook-backend-dev` / `guestbook-backend-prod`).

## Comandos Principais
```bash
# Validar sintaxe Python (executado no CI)
python3 -m py_compile pulumi-prj/__main__.py

# Visualizar mudanças planejadas na stack dev
cd pulumi-prj && uv run pulumi preview --stack dev

# Aplicar infraestrutura na stack dev
cd pulumi-prj && uv run pulumi up --stack dev
```
