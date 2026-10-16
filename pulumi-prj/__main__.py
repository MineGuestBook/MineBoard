import pulumi
import pulumi_cloudflare as cloudflare

# Carrega as configurações da stack ativa (dev ou prod)
config = pulumi.Config()
zone_id = config.require("zoneId")
subdomain = config.require("subdomain")
domain = config.get("domain") or "nicolaspitz.dev"
current_stack = pulumi.get_stack()
worker_script = config.get("workerScript") or f"guestbook-backend-{current_stack}"

# 1. Registro DNS principal do ambiente (ex: dev.nicolaspitz.dev)
dns_record = cloudflare.DnsRecord(
    f"dns-record-{current_stack}",
    zone_id=zone_id,
    name=subdomain,
    content="192.0.2.1",
    type="A",
    ttl=1,
    proxied=True,
    comment=f"GuestBook DNS Base - Stack {current_stack}",
)

# 2. Registro DNS Wildcard para subdomínios de perfis de usuários (RN2: *.dev.nicolaspitz.dev)
wildcard_dns_record = cloudflare.DnsRecord(
    f"dns-wildcard-{current_stack}",
    zone_id=zone_id,
    name=f"*.{subdomain}",
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
    pattern=f"{subdomain}.{domain}/*",
    script=worker_script,
)

# 4. Rota Wildcard do Cloudflare Worker para capturar subdomínios de usuários (<username>.<subdomain>.<domain>/*)
wildcard_worker_route = cloudflare.WorkersRoute(
    f"worker-wildcard-route-{current_stack}",
    zone_id=zone_id,
    pattern=f"*.{subdomain}.{domain}/*",
    script=worker_script,
)

# Outputs exportados no terminal
pulumi.export("stack", current_stack)
pulumi.export("zone_id", zone_id)
pulumi.export("record_name", dns_record.name)
pulumi.export("wildcard_record_name", wildcard_dns_record.name)
pulumi.export("worker_script", worker_script)
pulumi.export("worker_route_pattern", worker_route.pattern)
pulumi.export("wildcard_route_pattern", wildcard_worker_route.pattern)