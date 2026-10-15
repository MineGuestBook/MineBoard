#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://localhost:8787}"
DEMO_USER="visitante_$(date +%s)"

echo "============================================================"
echo " GuestBook — Demonstração SAM (Cloudflare Workers + MongoDB)"
echo " Target URL: ${BASE_URL}"
echo "============================================================"

echo -e "\n[1/7] Health Check (/health)..."
curl -sS "${BASE_URL}/health" | tee /dev/stderr
echo ""

echo -e "\n[2/7] Inicializando Índices e Seed (/api/setup/seed)..."
curl -sS -X POST "${BASE_URL}/api/setup/seed" | tee /dev/stderr
echo ""

echo -e "\n[3/7] Criando novo Perfil (${DEMO_USER}) em POST /api/profiles..."
curl -sS -X POST "${BASE_URL}/api/profiles" \
  -H "Content-Type: application/json" \
  -d "{
    \"email\": \"${DEMO_USER}@exemplo.com\",
    \"username\": \"${DEMO_USER}\",
    \"display_name\": \"Perfil Demo (${DEMO_USER})\",
    \"bio\": \"Testando Cloudflare Workers + MongoDB Atlas <script>alert(1)</script>\"
  }" | tee /dev/stderr
echo ""

echo -e "\n[4/7] Publicando comentário anônimo com teste de sanitização XSS (POST /api/profiles/${DEMO_USER}/comments)..."
COMMENT_JSON=$(curl -sS -X POST "${BASE_URL}/api/profiles/${DEMO_USER}/comments" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Olá! Comentário sem login <img src=x onerror=alert(1)>"
  }')
echo "${COMMENT_JSON}"
COMMENT_ID=$(echo "${COMMENT_JSON}" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -n 1)

if [ -n "${COMMENT_ID}" ]; then
  echo -e "\n[5/7] Curtindo comentário atomicamente (${COMMENT_ID})..."
  curl -sS -X POST "${BASE_URL}/api/comments/${COMMENT_ID}/like" \
    -H "X-Origin-Fingerprint: demo-visitor-1" | tee /dev/stderr
  echo ""

  echo -e "\n[6/7] Testando bloqueio de curtida duplicada da mesma origem (RN9)..."
  curl -sS -X POST "${BASE_URL}/api/comments/${COMMENT_ID}/like" \
    -H "X-Origin-Fingerprint: demo-visitor-1" | tee /dev/stderr
  echo ""
fi

echo -e "\n[7/7] Resolvendo perfil via subdomínio Host: ${DEMO_USER}.nicolaspitz.dev (/api/host-profile)..."
curl -sS "${BASE_URL}/api/host-profile" \
  -H "Host: ${DEMO_USER}.nicolaspitz.dev" | tee /dev/stderr
echo -e "\n\nDemonstração concluída com sucesso!"
