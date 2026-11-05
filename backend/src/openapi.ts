/**
 * Especificação OpenAPI 3.0 da API RESTful do GuestBook
 * (requisito geral: documentação de API para comunicação frontend/backend).
 */

const jsonBody = (schema: Record<string, unknown>) => ({
  required: true,
  content: { 'application/json': { schema } },
});

const ok = (description: string) => ({ description, content: { 'application/json': {} } });

const usernameParam = { name: 'username', in: 'path', required: true, schema: { type: 'string' } };
const commentIdParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', description: 'ObjectId' } };
const pagination = [
  { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
];
const authed = [{ sessionCookie: [] }, { bearerAuth: [] }];

export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'GuestBook API',
    version: '1.0.0',
    description:
      'API RESTful do GuestBook (Cloudflare Workers + Hono + MongoDB Atlas). Comentar e curtir não exigem autenticação (RN6); ' +
      'operações sobre conta/perfil exigem sessão via cookie HttpOnly (RN16) ou header Authorization: Bearer.',
  },
  servers: [{ url: '/' }],
  components: {
    securitySchemes: {
      sessionCookie: { type: 'apiKey', in: 'cookie', name: 'guestbook_session' },
      bearerAuth: { type: 'http', scheme: 'bearer' },
    },
    schemas: {
      ThemeConfig: {
        type: 'object',
        properties: {
          background_color: { type: 'string', example: '#121212' },
          card_background: { type: 'string', example: '#1e1e1e' },
          text_color: { type: 'string', example: '#e0e0e0' },
          accent_color: { type: 'string', example: '#00ffcc' },
          font_family: {
            type: 'string',
            enum: ['monospace', 'serif', 'sans-serif', 'cursive', 'Courier New', 'Comic Sans MS', 'Times New Roman', 'Verdana', 'Georgia', 'Tahoma'],
          },
        },
      },
      Profile: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          user_id: { type: 'string' },
          username: { type: 'string' },
          display_name: { type: 'string' },
          bio: { type: 'string', nullable: true },
          avatar_url: { type: 'string', nullable: true },
          theme_config: { $ref: '#/components/schemas/ThemeConfig' },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
        },
      },
      Comment: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          profile_id: { type: 'string' },
          author_name: { type: 'string' },
          author_email: { type: 'string', nullable: true },
          content: { type: 'string' },
          likes_count: { type: 'integer' },
          liked_by_me: { type: 'boolean' },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      Error: { type: 'object', properties: { error: { type: 'string' } } },
    },
  },
  paths: {
    '/health': { get: { tags: ['Sistema'], summary: 'Status do Worker e do MongoDB', responses: { 200: ok('OK') } } },
    '/api/setup/indexes': {
      post: { tags: ['Sistema'], summary: 'Cria índices (protegido por X-Setup-Token em produção)', responses: { 200: ok('OK') } },
    },
    '/api/setup/seed': {
      post: { tags: ['Sistema'], summary: 'Popula dados de demonstração (protegido em produção)', responses: { 200: ok('OK') } },
    },
    '/api/auth/login': {
      post: {
        tags: ['Autenticação'],
        summary: 'Login local (email + senha)',
        requestBody: jsonBody({
          type: 'object',
          required: ['email', 'password'],
          properties: { email: { type: 'string' }, password: { type: 'string' } },
        }),
        responses: { 200: ok('Sessão criada (cookie + session_token)'), 401: ok('Credenciais inválidas') },
      },
    },
    '/api/auth/logout': { post: { tags: ['Autenticação'], summary: 'Encerra a sessão atual', security: authed, responses: { 200: ok('OK') } } },
    '/api/auth/me': {
      get: { tags: ['Autenticação'], summary: 'Usuário e perfil autenticados', security: authed, responses: { 200: ok('OK'), 401: ok('Não autenticado') } },
    },
    '/api/auth/change-password': {
      post: {
        tags: ['Autenticação'],
        summary: 'Altera a senha (UC04, RN5)',
        security: authed,
        requestBody: jsonBody({
          type: 'object',
          required: ['new_password'],
          properties: { current_password: { type: 'string' }, new_password: { type: 'string', minLength: 8 } },
        }),
        responses: { 200: ok('Senha alterada'), 401: ok('Não autenticado'), 403: ok('Senha atual incorreta') },
      },
    },
    '/api/auth/forgot-password': {
      post: {
        tags: ['Autenticação'],
        summary: 'Solicita link de redefinição por email (UC05, RN4)',
        requestBody: jsonBody({ type: 'object', required: ['email'], properties: { email: { type: 'string' } } }),
        responses: { 200: ok('Resposta genérica (não revela se a conta existe)') },
      },
    },
    '/api/auth/reset-password': {
      post: {
        tags: ['Autenticação'],
        summary: 'Redefine a senha com token de uso único (UC05, RN4)',
        requestBody: jsonBody({
          type: 'object',
          required: ['token', 'new_password'],
          properties: { token: { type: 'string' }, new_password: { type: 'string', minLength: 8 } },
        }),
        responses: { 200: ok('Senha redefinida'), 400: ok('Token inválido, expirado ou já utilizado') },
      },
    },
    '/api/auth/google': { get: { tags: ['Autenticação'], summary: 'Inicia login OAuth com Google', responses: { 302: { description: 'Redirect' } } } },
    '/api/auth/google/callback': {
      get: { tags: ['Autenticação'], summary: 'Callback OAuth do Google', responses: { 302: { description: 'Redirect para o painel' } } },
    },
    '/api/host-profile': {
      get: { tags: ['Perfis'], summary: 'Resolve o perfil pelo subdomínio do header Host (RN2)', responses: { 200: ok('OK'), 404: ok('Não encontrado') } },
    },
    '/api/profiles': {
      get: {
        tags: ['Perfis'],
        summary: 'Busca de perfis (RF7)',
        parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }, ...pagination],
        responses: { 200: ok('Lista de perfis') },
      },
      post: {
        tags: ['Perfis'],
        summary: 'Cria conta + perfil e autentica automaticamente (UC01)',
        requestBody: jsonBody({
          type: 'object',
          required: ['email', 'username'],
          properties: {
            email: { type: 'string' },
            username: { type: 'string', pattern: '^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])?$' },
            password: { type: 'string', minLength: 8 },
            display_name: { type: 'string' },
            bio: { type: 'string' },
            theme_config: { $ref: '#/components/schemas/ThemeConfig' },
          },
        }),
        responses: { 201: ok('Conta criada'), 400: ok('Dados inválidos'), 409: ok('Email ou username em uso') },
      },
    },
    '/api/profiles/{username}': {
      get: { tags: ['Perfis'], summary: 'Perfil público + comentários (RF9)', parameters: [usernameParam], responses: { 200: ok('OK'), 404: ok('Não encontrado') } },
      patch: {
        tags: ['Perfis'],
        summary: 'Edita perfil e tema (UC02, RF3, RF8)',
        security: authed,
        parameters: [usernameParam],
        requestBody: jsonBody({
          type: 'object',
          properties: {
            display_name: { type: 'string' },
            bio: { type: 'string' },
            avatar_url: { type: 'string' },
            theme_config: { $ref: '#/components/schemas/ThemeConfig' },
          },
        }),
        responses: { 200: ok('Atualizado'), 401: ok('Não autenticado'), 403: ok('Não é o dono') },
      },
      delete: {
        tags: ['Perfis'],
        summary: 'Exclui conta, perfil e comentários em cascata (UC03, RN3)',
        security: authed,
        parameters: [usernameParam],
        responses: { 200: ok('Excluído'), 401: ok('Não autenticado'), 403: ok('Não é o dono') },
      },
    },
    '/api/profiles/{username}/avatar': {
      post: {
        tags: ['Perfis'],
        summary: 'Upload de avatar no Cloudflare R2 (RF3) — PNG/JPEG/WEBP/GIF até 2 MB',
        security: authed,
        parameters: [usernameParam],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': { schema: { type: 'object', properties: { avatar: { type: 'string', format: 'binary' } } } },
            'image/*': { schema: { type: 'string', format: 'binary' } },
          },
        },
        responses: { 200: ok('Avatar atualizado'), 413: ok('Arquivo muito grande'), 415: ok('Formato inválido') },
      },
    },
    '/api/avatars/{key}': {
      get: {
        tags: ['Perfis'],
        summary: 'Serve a imagem de avatar armazenada no R2',
        parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Imagem' }, 404: ok('Não encontrado') },
      },
    },
    '/api/profiles/{username}/comments': {
      get: { tags: ['Comentários'], summary: 'Lista comentários paginados (RF9)', parameters: [usernameParam, ...pagination], responses: { 200: ok('OK') } },
      post: {
        tags: ['Comentários'],
        summary: 'Publica comentário sem autenticação (RF10, RF11) e notifica o dono (RF15)',
        parameters: [usernameParam],
        requestBody: jsonBody({
          type: 'object',
          required: ['content'],
          properties: {
            content: { type: 'string', maxLength: 2000 },
            author_name: { type: 'string' },
            author_email: { type: 'string' },
          },
        }),
        responses: { 201: ok('Publicado'), 400: ok('Inválido'), 429: ok('Rate limit (RNF1)') },
      },
    },
    '/api/comments/{id}/like': {
      post: { tags: ['Comentários'], summary: 'Curte comentário (RF13, RN9)', parameters: [commentIdParam], responses: { 200: ok('OK'), 409: ok('Já curtido') } },
      delete: { tags: ['Comentários'], summary: 'Remove curtida', parameters: [commentIdParam], responses: { 200: ok('OK') } },
    },
    '/api/comments/{id}': {
      delete: {
        tags: ['Comentários'],
        summary: 'Exclui comentário (somente dono do perfil — RF12, RN8, RN10)',
        security: authed,
        parameters: [commentIdParam],
        responses: { 200: ok('Excluído'), 401: ok('Não autenticado'), 403: ok('Não é o dono') },
      },
    },
    '/api/widget/{username}': {
      get: { tags: ['Widget'], summary: 'Dados JSON do widget (RF14)', parameters: [usernameParam], responses: { 200: ok('OK') } },
    },
    '/api/widget/{username}/embed.js': {
      get: {
        tags: ['Widget'],
        summary: 'Script embutível para sites de terceiros (UC10)',
        parameters: [usernameParam],
        responses: { 200: { description: 'application/javascript' } },
      },
    },
    '/api/widget/{username}/frame': {
      get: { tags: ['Widget'], summary: 'Página HTML para uso em iframe (UC10)', parameters: [usernameParam], responses: { 200: { description: 'text/html' } } },
    },
  },
} as const;

export function renderSwaggerUiHtml(specUrl: string): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>GuestBook API — Documentação</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
</head>
<body>
<div id="swagger-ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin></script>
<script>window.ui = SwaggerUIBundle({ url: ${JSON.stringify(specUrl)}, dom_id: '#swagger-ui' });</script>
</body>
</html>`;
}
