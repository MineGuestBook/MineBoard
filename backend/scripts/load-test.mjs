#!/usr/bin/env node
/**
 * GuestBook (MineBoard) — Bateria de Testes de Carga e Concorrência (RNF2, RNF3, RN9)
 *
 * Executa publicações simultâneas de comentários, curtidas atômicas concorrentes,
 * bloqueio de curtidas duplicadas (RN9) e leituras concorrentes de perfil (RNF3),
 * validando consistência exata dos contadores no banco (sem perda de dados — RNF2).
 *
 * Uso:
 *   cd backend && npm run test:load
 *   BASE_URL=https://dev.nicolaspitz.dev CONCURRENCY=20 npm run test:load
 */
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const BASE_URL = (process.env.BASE_URL || 'http://localhost:8787').replace(/\/+$/, '');
const CONCURRENCY = Math.max(5, Number(process.env.CONCURRENCY) || 20);
const READ_BURST = Math.max(10, Number(process.env.READ_BURST) || 40);
const MAX_P95_MS = Number(process.env.MAX_P95_MS) || 2500;
const ROOT_DOMAIN = process.env.ROOT_DOMAIN || 'nicolaspitz.dev';

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Number(sorted[Math.max(0, idx)].toFixed(2));
}

async function timedFetch(url, options = {}) {
  const start = performance.now();
  const res = await fetch(url, options);
  const elapsedMs = performance.now() - start;
  const data = await res.json().catch(() => ({}));
  return { status: res.status, elapsedMs, data };
}

async function isServerReachable(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureLocalWorkerIfNeeded(baseUrl) {
  if (await isServerReachable(baseUrl)) {
    return null;
  }

  const parsed = new URL(baseUrl);
  if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    throw new Error(`Servidor alvo ${baseUrl} não está acessível.`);
  }

  const port = parsed.port || '8787';
  console.log(`[Setup] Nenhum servidor ativo em ${baseUrl}. Iniciando wrangler dev na porta ${port}...`);
  const child = spawn('npx', ['wrangler', 'dev', '--port', port, '--ip', '127.0.0.1'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: 'true' },
  });

  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (await isServerReachable(baseUrl)) {
      console.log(`[Setup] Worker local pronto em ${baseUrl}`);
      return child;
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  child.kill('SIGTERM');
  throw new Error(`Timeout aguardando wrangler dev iniciar em ${baseUrl}`);
}

async function runLoadSuite() {
  console.log('================================================================');
  console.log(' GuestBook (MineBoard) — Teste de Carga e Concorrência (RNF2/3)');
  console.log(` Target: ${BASE_URL} | Concorrência: ${CONCURRENCY} | Leituras: ${READ_BURST}`);
  console.log('================================================================');

  const spawnedWorker = await ensureLocalWorkerIfNeeded(BASE_URL);
  const username = `load-${Date.now()}`;
  let sessionToken = '';

  try {
    // 1. Criação do perfil de teste
    const createRes = await timedFetch(`${BASE_URL}/api/profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `${username}@exemplo.com`,
        username,
        display_name: `Carga Concorrente (${username})`,
        password: 'Password123!',
        bio: 'Validação automatizada de RNF2 (concorrência sem perda) e RNF3 (baixa latência).',
      }),
    });

    if (createRes.status !== 201) {
      throw new Error(`Falha ao criar perfil de teste (${createRes.status}): ${JSON.stringify(createRes.data)}`);
    }
    sessionToken = createRes.data.session_token || '';
    console.log(`\n[1/4] Perfil "${username}" criado em ${createRes.elapsedMs.toFixed(1)} ms.`);

    // 2. RNF2: Publicação simultânea de N comentários (cada um de um IP distinto)
    console.log(`[2/4] Disparando ${CONCURRENCY} comentários simultâneos (RNF2 + RNF4)...`);
    const commentStart = performance.now();
    const commentResults = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        timedFetch(`${BASE_URL}/api/profiles/${username}/comments`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Forwarded-For': `198.51.100.${(i % 240) + 10}`,
            'X-Origin-Fingerprint': `load-commenter-${i}`,
          },
          body: JSON.stringify({
            author_name: i % 2 === 0 ? `Visitante #${i}` : '',
            content: `Comentário simultâneo #${i} <img src=x onerror=alert(${i})>`,
          }),
        })
      )
    );
    const commentTotalMs = performance.now() - commentStart;

    const failedComments = commentResults.filter((r) => r.status !== 201);
    if (failedComments.length > 0) {
      throw new Error(
        `RNF2 falhou: ${failedComments.length}/${CONCURRENCY} comentários não retornaram 201.`
      );
    }

    const unsanitized = commentResults.filter((r) =>
      String(r.data?.comment?.content || '').includes('<img')
    );
    if (unsanitized.length > 0) {
      throw new Error('RNF4 falhou: payload XSS não foi sanitizado sob carga.');
    }

    const targetCommentId = commentResults[0].data.comment.id;
    const commentLatencies = commentResults.map((r) => r.elapsedMs);
    console.log(
      `      ✓ ${CONCURRENCY}/${CONCURRENCY} comentários gravados sem perda em ${commentTotalMs.toFixed(1)} ms ` +
        `(p50=${percentile(commentLatencies, 50)}ms, p95=${percentile(commentLatencies, 95)}ms)`
    );

    // 3. RNF2 + RN9: Curtidas atômicas simultâneas no mesmo comentário + bloqueio de duplicatas
    console.log(
      `[3/4] Disparando ${CONCURRENCY} curtidas simultâneas + ${CONCURRENCY} tentativas duplicadas no comentário ${targetCommentId} (RNF2 + RN9)...`
    );
    const likeResults = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        timedFetch(`${BASE_URL}/api/comments/${targetCommentId}/like`, {
          method: 'POST',
          headers: { 'X-Origin-Fingerprint': `load-liker-${i}` },
        })
      )
    );

    const failedLikes = likeResults.filter((r) => r.status !== 200);
    if (failedLikes.length > 0) {
      throw new Error(`RNF2 falhou: ${failedLikes.length}/${CONCURRENCY} curtidas únicas falharam.`);
    }

    // Dispara curtidas duplicadas das mesmas origens simultaneamente (todas devem receber 409)
    const duplicateResults = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        timedFetch(`${BASE_URL}/api/comments/${targetCommentId}/like`, {
          method: 'POST',
          headers: { 'X-Origin-Fingerprint': `load-liker-${i}` },
        })
      )
    );
    const unblockedDuplicates = duplicateResults.filter((r) => r.status !== 409);
    if (unblockedDuplicates.length > 0) {
      throw new Error(
        `RN9 falhou: ${unblockedDuplicates.length} curtidas duplicadas não foram bloqueadas com 409.`
      );
    }

    const likeLatencies = likeResults.map((r) => r.elapsedMs);
    console.log(
      `      ✓ ${CONCURRENCY}/${CONCURRENCY} likes atômicos somados e ${CONCURRENCY}/${CONCURRENCY} duplicados bloqueados (409) ` +
        `(p50=${percentile(likeLatencies, 50)}ms, p95=${percentile(likeLatencies, 95)}ms)`
    );

    // 4. RNF3 + Verificação de consistência final no banco
    console.log(`[4/4] Executando rajada de ${READ_BURST} leituras concorrentes do perfil (RNF3)...`);
    const readResults = await Promise.all(
      Array.from({ length: READ_BURST }, (_, i) =>
        i % 2 === 0
          ? timedFetch(`${BASE_URL}/api/profiles/${username}?limit=100`, {
              headers: { 'X-Origin-Fingerprint': `reader-${i}` },
            })
          : timedFetch(`${BASE_URL}/api/host-profile`, {
              headers: {
                'X-Forwarded-Host': `${username}.${ROOT_DOMAIN}`,
                'X-Origin-Fingerprint': `reader-${i}`,
              },
            })
      )
    );

    const failedReads = readResults.filter((r) => r.status !== 200);
    if (failedReads.length > 0) {
      throw new Error(`RNF3 falhou: ${failedReads.length}/${READ_BURST} leituras falharam.`);
    }

    const readLatencies = readResults.map((r) => r.elapsedMs);
    const readP50 = percentile(readLatencies, 50);
    const readP95 = percentile(readLatencies, 95);
    const readP99 = percentile(readLatencies, 99);

    const finalProfileData = readResults[0].data;
    const finalComments = finalProfileData.comments || [];
    const targetComment = finalComments.find((c) => c.id === targetCommentId);

    if (finalComments.length !== CONCURRENCY) {
      throw new Error(
        `Inconsistência RNF2: esperados ${CONCURRENCY} comentários persistidos, encontrados ${finalComments.length}.`
      );
    }

    if (!targetComment || targetComment.likes_count !== CONCURRENCY) {
      throw new Error(
        `Inconsistência RNF2: esperado likes_count=${CONCURRENCY}, encontrado ${targetComment?.likes_count}.`
      );
    }

    if (readP95 > MAX_P95_MS) {
      throw new Error(`RNF3 violado: p95 de leitura (${readP95} ms) excedeu o limite (${MAX_P95_MS} ms).`);
    }

    console.log(
      `      ✓ ${READ_BURST}/${READ_BURST} leituras concluídas (p50=${readP50}ms, p95=${readP95}ms, p99=${readP99}ms)`
    );
    console.log(
      `      ✓ Consistência verificada (RNF2): ${finalComments.length} comentários e ${targetComment.likes_count} likes exatos.`
    );
    console.log('\nResultado: APROVADO (RNF2, RNF3, RNF4, RN9 validados com sucesso).');
  } finally {
    // Limpeza em cascata (RN3)
    if (sessionToken) {
      await fetch(`${BASE_URL}/api/profiles/${username}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${sessionToken}` },
      }).catch(() => undefined);
    }
    if (spawnedWorker) {
      spawnedWorker.kill('SIGTERM');
    }
  }
}

runLoadSuite().catch((err) => {
  console.error('\n[ERRO NO TESTE DE CARGA]', err instanceof Error ? err.message : err);
  process.exit(1);
});
