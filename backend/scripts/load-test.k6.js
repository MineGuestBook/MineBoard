/**
 * GuestBook (MineBoard) — Teste de Carga e Concorrência com k6 (RNF2, RNF3, RN9)
 *
 * Como executar:
 *   k6 run backend/scripts/load-test.k6.js
 *   k6 run -e BASE_URL=https://dev.nicolaspitz.dev -e VUS=20 -e DURATION=20s backend/scripts/load-test.k6.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:8787').replace(/\/+$/, '');
const ROOT_DOMAIN = __ENV.ROOT_DOMAIN || 'nicolaspitz.dev';

export const options = {
  vus: Number(__ENV.VUS) || 15,
  duration: __ENV.DURATION || '15s',
  thresholds: {
    // RNF3: carregamento rápido do perfil e comentários sob carga
    http_req_duration: ['p(95)<2000'],
    // RNF2: nenhuma perda de dados ou falha inesperada sob concorrência
    checks: ['rate>0.99'],
  },
};

export function setup() {
  const username = `loadtest-${Date.now()}`;
  const createRes = http.post(
    `${BASE_URL}/api/profiles`,
    JSON.stringify({
      email: `${username}@exemplo.com`,
      username,
      display_name: `Perfil Carga (${username})`,
      password: 'Password123!',
      bio: 'Perfil temporário para bateria de testes de carga e concorrência (RNF2, RNF3).',
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );

  check(createRes, {
    'setup: perfil criado (201)': (r) => r.status === 201,
  });

  const body = createRes.json();
  const sessionToken = body && body.session_token ? body.session_token : '';

  const commentRes = http.post(
    `${BASE_URL}/api/profiles/${username}/comments`,
    JSON.stringify({
      author_name: 'Seed Carga',
      content: 'Comentário alvo para curtidas concorrentes atômicas (RNF2, RN9).',
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '198.51.100.1',
      },
    }
  );

  check(commentRes, {
    'setup: comentário inicial criado (201)': (r) => r.status === 201,
  });

  const commentBody = commentRes.json();
  const seedCommentId = commentBody && commentBody.comment ? commentBody.comment.id : '';

  return { username, sessionToken, seedCommentId };
}

export default function (data) {
  const uniqueVisitorIp = `203.0.${(__VU % 250) + 1}.${(__ITER % 250) + 1}`;
  const uniqueFingerprint = `k6-vu-${__VU}-iter-${__ITER}-${Date.now()}`;

  // 1. RNF3: Leitura concorrente da página pública do perfil + comentários
  const profileRes = http.get(`${BASE_URL}/api/profiles/${data.username}?limit=20`, {
    headers: { 'X-Origin-Fingerprint': uniqueFingerprint },
  });
  check(profileRes, {
    'RNF3: GET /api/profiles/:username responde 200': (r) => r.status === 200,
  });

  // 2. RNF3 / RN2: Resolução do perfil via subdomínio Host
  const hostRes = http.get(`${BASE_URL}/api/host-profile`, {
    headers: {
      'X-Forwarded-Host': `${data.username}.${ROOT_DOMAIN}`,
      'X-Origin-Fingerprint': uniqueFingerprint,
    },
  });
  check(hostRes, {
    'RN2/RNF3: GET /api/host-profile resolve subdomínio (200)': (r) => r.status === 200,
  });

  // 3. RNF2 / RNF4: Publicação simultânea de comentários de visitantes distintos
  const postCommentRes = http.post(
    `${BASE_URL}/api/profiles/${data.username}/comments`,
    JSON.stringify({
      author_name: `Visitante VU ${__VU}`,
      content: `Recado concorrente #${__ITER} <script>alert("xss")</script>`,
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': uniqueVisitorIp,
        'X-Origin-Fingerprint': uniqueFingerprint,
      },
    }
  );
  check(postCommentRes, {
    'RNF2: comentário concorrente publicado (201)': (r) => r.status === 201,
    'RNF4: payload XSS sanitizado sob carga': (r) => {
      const json = r.json();
      return json && json.comment && !String(json.comment.content).includes('<script>');
    },
  });

  // 4. RNF2 / RN9: Curtida atômica concorrente + bloqueio de curtida duplicada da mesma origem
  if (data.seedCommentId) {
    const likeRes = http.post(`${BASE_URL}/api/comments/${data.seedCommentId}/like`, null, {
      headers: { 'X-Origin-Fingerprint': uniqueFingerprint },
    });
    check(likeRes, {
      'RNF2: like atômico registrado (200)': (r) => r.status === 200,
    });

    const dupLikeRes = http.post(`${BASE_URL}/api/comments/${data.seedCommentId}/like`, null, {
      headers: { 'X-Origin-Fingerprint': uniqueFingerprint },
    });
    check(dupLikeRes, {
      'RN9: like duplicado da mesma origem bloqueado (409)': (r) => r.status === 409,
    });
  }

  sleep(0.1);
}

export function teardown(data) {
  if (!data || !data.username) return;
  const headers = data.sessionToken ? { Authorization: `Bearer ${data.sessionToken}` } : {};
  const delRes = http.del(`${BASE_URL}/api/profiles/${data.username}`, null, { headers });
  check(delRes, {
    'teardown: perfil temporário removido em cascata (200)': (r) => r.status === 200,
  });
}
