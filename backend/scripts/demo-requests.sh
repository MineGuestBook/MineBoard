#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://localhost:8787}"
DEMO_USER="visitante-$(date +%s)"

echo "============================================================"
echo " GuestBook — Demonstração SAM (Cloudflare Workers + MongoDB)"
echo " Target URL: ${BASE_URL}"
echo "============================================================"

echo -e "\n[1/8] Health Check (/health)..."
curl -sS "${BASE_URL}/health"
echo ""

echo -e "\n[2/8] Inicializando Índices e Seed (/api/setup/seed)..."
curl -sS -X POST "${BASE_URL}/api/setup/seed"
echo ""

echo -e "\n[3/8] Criando novo Perfil (${DEMO_USER}) em POST /api/profiles..."
curl -sS -X POST "${BASE_URL}/api/profiles" \
  -H "Content-Type: application/json" \
  -d "{
    \"email\": \"${DEMO_USER}@exemplo.com\",
    \"username\": \"${DEMO_USER}\",
    \"display_name\": \"Perfil Demo (${DEMO_USER})\",
    \"bio\": \"Testando Cloudflare Workers + MongoDB Atlas <script>alert(1)</script>\"
  }"
echo ""

echo -e "\n[4/8] Publicando comentário anônimo com teste de sanitização XSS (POST /api/profiles/${DEMO_USER}/comments)..."
COMMENT_JSON=$(curl -sS -X POST "${BASE_URL}/api/profiles/${DEMO_USER}/comments" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Olá! Comentário sem login <img src=x onerror=alert(1)>"
  }')
echo "${COMMENT_JSON}"
COMMENT_ID=$(echo "${COMMENT_JSON}" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -n 1)

if [ -n "${COMMENT_ID}" ]; then
  echo -e "\n[5/8] Curtindo comentário atomicamente (${COMMENT_ID})..."
  curl -sS -X POST "${BASE_URL}/api/comments/${COMMENT_ID}/like" \
    -H "X-Origin-Fingerprint: demo-visitor-1"
  echo ""

  echo -e "\n[6/8] Testando bloqueio de curtida duplicada da mesma origem (RN9)..."
  curl -sS -X POST "${BASE_URL}/api/comments/${COMMENT_ID}/like" \
    -H "X-Origin-Fingerprint: demo-visitor-1"
  echo ""
fi

echo -e "\n[7/8] Resolvendo perfil via subdomínio Host: ${DEMO_USER}.nicolaspitz.dev (/api/host-profile)..."
curl -sS "${BASE_URL}/api/host-profile" \
  -H "Host: ${DEMO_USER}.nicolaspitz.dev"
echo ""

echo -e "\n[8/8] Excluindo perfil temporário em cascata (DELETE /api/profiles/${DEMO_USER} - RN3)..."
curl -sS -X DELETE "${BASE_URL}/api/profiles/${DEMO_USER}"
echo -e "\n\nDemonstração concluída com sucesso!"
