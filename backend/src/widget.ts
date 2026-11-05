import type { Comment, Profile } from './types';
import { DEFAULT_THEME, sanitizeThemeConfig, serializeComment } from './routes/profiles';

/**
 * Widget embutível (RF14, RN11, RN12, UC10).
 *
 * - `embed.js`: script auto-contido que renderiza o mural em um Shadow DOM (isolando estilos do site
 *   hospedeiro) e consome `GET /api/widget/:username` — a mesma fonte de dados da página pública (RN12).
 * - `frame`: página HTML leve para uso em `<iframe>`.
 *
 * Os campos textuais (`display_name`, `bio`, `author_name`, `content`) já são armazenados com HTML
 * escapado (RNF4), por isso podem ser interpolados diretamente no HTML gerado.
 */

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function resolveTheme(profile: Profile) {
  return { ...DEFAULT_THEME, ...(sanitizeThemeConfig(profile.theme_config) || {}) };
}

export function renderWidgetEmbedScript(apiOrigin: string, username: string): string {
  const config = JSON.stringify({ apiOrigin, username });
  return `/* GuestBook Widget — ${username} */
(function () {
  var cfg = ${config};
  var script = document.currentScript;
  var limit = Number(script && script.getAttribute('data-limit')) || 10;
  var host = document.createElement('div');
  host.className = 'guestbook-widget';
  if (script && script.parentNode) { script.parentNode.insertBefore(host, script.nextSibling); }
  else { document.body.appendChild(host); }
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

  function esc(v) { return String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function safeColor(v, d) { return /^#[0-9a-fA-F]{3,8}$/.test(v || '') ? v : d; }
  var FONTS = ['monospace','serif','sans-serif','cursive','Courier New','Comic Sans MS','Times New Roman','Verdana','Georgia','Tahoma'];

  fetch(cfg.apiOrigin + '/api/widget/' + encodeURIComponent(cfg.username) + '?limit=' + limit)
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (data) {
      var p = data.profile || {}; var t = p.theme_config || {};
      var font = FONTS.indexOf(t.font_family) >= 0 ? t.font_family : 'monospace';
      var profileUrl = cfg.apiOrigin + '/u/' + encodeURIComponent(p.username);
      var items = (data.comments || []).map(function (c) {
        return '<li><div class="meta"><strong>' + c.author_name + '</strong> · ' +
          esc(new Date(c.created_at).toLocaleDateString()) + ' · ♥ ' + Number(c.likes_count || 0) +
          '</div><div class="content">' + c.content + '</div></li>';
      }).join('') || '<li class="empty">Nenhum recado ainda. Seja o primeiro!</li>';
      root.innerHTML = '<style>' +
        ':host{all:initial}' +
        '.gb{font-family:' + font + ';background:' + safeColor(t.background_color,'#121212') + ';color:' + safeColor(t.text_color,'#e0e0e0') + ';border:3px double ' + safeColor(t.accent_color,'#00ffcc') + ';padding:12px;max-width:480px;box-sizing:border-box}' +
        '.gb h3{margin:0 0 8px;color:' + safeColor(t.accent_color,'#00ffcc') + ';font-size:16px}' +
        '.gb ul{list-style:none;margin:0;padding:0;max-height:360px;overflow:auto}' +
        '.gb li{background:' + safeColor(t.card_background,'#1e1e1e') + ';margin:6px 0;padding:8px;border:1px dashed ' + safeColor(t.accent_color,'#00ffcc') + '}' +
        '.gb .meta{font-size:11px;opacity:.75;margin-bottom:4px}.gb .content{font-size:13px;white-space:pre-wrap;word-break:break-word}' +
        '.gb a{color:' + safeColor(t.accent_color,'#00ffcc') + ';font-size:12px}' +
        '</style><div class="gb"><h3>📖 GuestBook de ' + p.display_name + '</h3><ul>' + items + '</ul>' +
        '<a href="' + esc(profileUrl) + '" target="_blank" rel="noopener">✍️ Assine o livro de visitas</a></div>';
    })
    .catch(function () {
      root.innerHTML = '<div style="font-family:monospace;border:1px solid #c33;padding:8px;color:#c33">GuestBook indisponível.</div>';
    });
})();
`;
}

export function renderWidgetFrameHtml(apiOrigin: string, profile: Profile, comments: Comment[]): string {
  const t = resolveTheme(profile);
  const profileUrl = `${apiOrigin}/u/${encodeURIComponent(profile.username)}`;
  const items = comments
    .map((raw) => {
      const c = serializeComment(raw);
      const date = c.created_at ? new Date(c.created_at).toLocaleDateString('pt-BR') : '';
      return `<li><div class="meta"><strong>${c.author_name}</strong> · ${escapeAttr(date)} · ♥ ${Number(c.likes_count)}</div><div class="content">${c.content}</div></li>`;
    })
    .join('');

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GuestBook de ${profile.display_name}</title>
<style>
  body{margin:0;font-family:${t.font_family};background:${t.background_color};color:${t.text_color}}
  .gb{padding:12px;border:3px double ${t.accent_color};min-height:100vh;box-sizing:border-box}
  h3{margin:0 0 8px;color:${t.accent_color};font-size:16px}
  ul{list-style:none;margin:0;padding:0}
  li{background:${t.card_background};margin:6px 0;padding:8px;border:1px dashed ${t.accent_color}}
  .meta{font-size:11px;opacity:.75;margin-bottom:4px}
  .content{font-size:13px;white-space:pre-wrap;word-break:break-word}
  a{color:${t.accent_color};font-size:12px}
</style>
</head>
<body>
<div class="gb">
  <h3>📖 GuestBook de ${profile.display_name}</h3>
  <ul>${items || '<li>Nenhum recado ainda. Seja o primeiro!</li>'}</ul>
  <a href="${escapeAttr(profileUrl)}" target="_blank" rel="noopener">✍️ Assine o livro de visitas</a>
</div>
</body>
</html>`;
}
