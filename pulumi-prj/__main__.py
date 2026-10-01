import pulumi
import pulumi_cloudflare as cloudflare

# Carrega as configurações da stack ativa
config = pulumi.Config()
zone_id = config.require("zoneId")
subdomain = config.require("subdomain")
current_stack = pulumi.get_stack()

# Cria o registro DNS usando o recurso DnsRecord
dns_record = cloudflare.DnsRecord(
    f"dns-record-{current_stack}",
    zone_id=zone_id,
    name=subdomain,
    content="192.0.2.1",
    type="A",
    ttl=1,
    proxied=True,
    comment=f"Teste IaC Pulumi - Stack {current_stack}",
)

# Outputs exportados no terminal
pulumi.export("stack", current_stack)
pulumi.export("zone_id", zone_id)
pulumi.export("record_name", dns_record.name)