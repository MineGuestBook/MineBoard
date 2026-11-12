import os
import pulumi
import pulumi_cloudflare as cloudflare

# Carrega as configurações da stack ativa (dev ou prod), permitindo override via variáveis de ambiente no CI/CD
config = pulumi.Config()
account_id = os.getenv("CLOUDFLARE_ACCOUNT_ID") or config.require("accountId")
zone_id = os.getenv("CLOUDFLARE_ZONE_ID") or config.require("zoneId")
domain = os.getenv("ROOT_DOMAIN") or config.get("domain") or "nicolaspitz.dev"
current_stack = pulumi.get_stack()
default_subdomain = "preview-prod" if current_stack == "prod" else "dev"
subdomain = os.getenv("SUBDOMAIN") or config.get("subdomain") or default_subdomain
worker_script = os.getenv("WORKER_SCRIPT") or config.get("workerScript") or f"guestbook-backend-{current_stack}"
r2_bucket_name = os.getenv("R2_BUCKET_NAME") or config.get("r2BucketName") or f"guestbook-avatars-{current_stack}"
pages_project_name = os.getenv("PAGES_PROJECT_NAME") or config.get("pagesProjectName") or f"mineboard-guestbook-{current_stack}"
production_branch = "main" if current_stack == "prod" else "dev"

# Suporta tanto domínio raiz (subdomain="@") quanto subdomínio dedicado (ex: dev.nicolaspitz.dev)
is_root_domain = subdomain in ("@", "")
base_dns_name = "@" if is_root_domain else subdomain
wildcard_dns_name = "*" if is_root_domain else f"*.{subdomain}"
base_host = domain if is_root_domain else f"{subdomain}.{domain}"

# 1. Registro DNS principal do ambiente
dns_record = cloudflare.DnsRecord(
    f"dns-record-{current_stack}",
    zone_id=zone_id,
    name=base_dns_name,
    content="192.0.2.1",
    type="A",
    ttl=1,
    proxied=True,
    comment=f"GuestBook DNS Base - Stack {current_stack}",
)

# 2. Registro DNS Wildcard para subdomínios de perfis de usuários (RN2)
wildcard_dns_record = cloudflare.DnsRecord(
    f"dns-wildcard-{current_stack}",
    zone_id=zone_id,
    name=wildcard_dns_name,
    content="192.0.2.1",
    type="A",
    ttl=1,
    proxied=True,
    comment=f"GuestBook Wildcard Subdomains (RN2) - Stack {current_stack}",
)

# 3. Rota do Cloudflare Worker para o domínio principal da stack
worker_route = cloudflare.WorkersRoute(
    f"worker-route-{current_stack}",
    zone_id=zone_id,
    pattern=f"{base_host}/*",
    script=worker_script,
)

# 4. Rota Wildcard do Cloudflare Worker para capturar subdomínios de usuários (<username>.<base_host>/*)
wildcard_worker_route = cloudflare.WorkersRoute(
    f"worker-wildcard-route-{current_stack}",
    zone_id=zone_id,
    pattern=f"*.{base_host}/*",
    script=worker_script,
)

# 5. Bucket Cloudflare R2 para armazenamento de avatares e assets de estilização (RF3)
avatars_bucket = cloudflare.R2Bucket(
    f"r2-avatars-{current_stack}",
    account_id=account_id,
    name=r2_bucket_name,
)

# 6. Projeto Cloudflare Pages para hospedar o frontend estático (Vite + TS)
pages_project = cloudflare.PagesProject(
    f"pages-frontend-{current_stack}",
    account_id=account_id,
    name=pages_project_name,
    production_branch=production_branch,
)

# Outputs exportados no terminal
pulumi.export("stack", current_stack)
pulumi.export("zone_id", zone_id)
pulumi.export("record_name", dns_record.name)
pulumi.export("wildcard_record_name", wildcard_dns_record.name)
pulumi.export("worker_script", worker_script)
pulumi.export("worker_route_pattern", worker_route.pattern)
pulumi.export("wildcard_route_pattern", wildcard_worker_route.pattern)
pulumi.export("r2_bucket_name", avatars_bucket.name)
pulumi.export("pages_project_name", pages_project.name)
