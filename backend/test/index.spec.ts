import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ObjectId } from "bson";
import type { Db } from "mongodb";
import worker from "../src/index";
import { setTestDatabase, getMongoConnectionOptions } from "../src/db";
import {
	sanitizeText,
	validateUsername,
	extractSubdomainUsername,
} from "../src/utils/security";

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

/**
 * Banco MongoDB em memória leve para testes de integração das rotas no runtime Workers (Vitest)
 * sem depender de conexão externa durante o CI.
 */
function createInMemoryMongoDb(): Db {
	const store = new Map<string, Record<string, any>[]>();

	const getColData = (name: string) => {
		if (!store.has(name)) {
			store.set(name, []);
		}
		return store.get(name)!;
	};

	const matchesFilter = (doc: Record<string, any>, filter: Record<string, any> = {}): boolean => {
		for (const [key, cond] of Object.entries(filter)) {
			if (key === "$or" && Array.isArray(cond)) {
				if (!cond.some((sub) => matchesFilter(doc, sub))) return false;
				continue;
			}

			const val = doc[key];
			if (cond && typeof cond === "object" && !(cond instanceof ObjectId) && !(cond instanceof Date)) {
				if ("$regex" in cond) {
					const regex = new RegExp(cond.$regex, cond.$options || "");
					if (!regex.test(String(val ?? ""))) return false;
					continue;
				}
				if ("$ne" in cond) {
					if (Array.isArray(val)) {
						if (val.includes(cond.$ne)) return false;
					} else if (val === cond.$ne) {
						return false;
					}
					continue;
				}
				if ("$gte" in cond) {
					if (!(val >= cond.$gte)) return false;
					continue;
				}
			}

			if (val instanceof ObjectId && cond instanceof ObjectId) {
				if (!val.equals(cond)) return false;
			} else if (Array.isArray(val)) {
				if (!val.includes(cond)) return false;
			} else if (val !== cond) {
				return false;
			}
		}
		return true;
	};

	const collection = (name: string) => {
		return {
			createIndex: async () => "ok_idx",
			findOne: async (filter: Record<string, any> = {}) => {
				const list = getColData(name);
				return list.find((doc) => matchesFilter(doc, filter)) ?? null;
			},
			find: (filter: Record<string, any> = {}) => {
				let results = getColData(name).filter((doc) => matchesFilter(doc, filter));
				const cursor = {
					sort: (sortSpec: Record<string, number>) => {
						const [[field, dir]] = Object.entries(sortSpec);
						results = [...results].sort((a, b) => {
							const av = a[field] instanceof Date ? a[field].getTime() : a[field];
							const bv = b[field] instanceof Date ? b[field].getTime() : b[field];
							return dir < 0 ? bv - av : av - bv;
						});
						return cursor;
					},
					skip: (n: number) => {
						results = results.slice(n);
						return cursor;
					},
					limit: (n: number) => {
						results = results.slice(0, n);
						return cursor;
					},
					toArray: async () => results,
				};
				return cursor;
			},
			insertOne: async (doc: Record<string, any>) => {
				const list = getColData(name);
				const _id = doc._id ?? new ObjectId();
				const saved = { ...doc, _id };
				list.push(saved);
				return { acknowledged: true, insertedId: _id };
			},
			insertMany: async (docs: Record<string, any>[]) => {
				const list = getColData(name);
				for (const d of docs) {
					list.push({ ...d, _id: d._id ?? new ObjectId() });
				}
				return { acknowledged: true, insertedCount: docs.length };
			},
			updateOne: async (filter: Record<string, any>, update: Record<string, any>) => {
				const list = getColData(name);
				const target = list.find((doc) => matchesFilter(doc, filter));
				if (!target) {
					return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
				}
				if (update.$set) {
					Object.assign(target, update.$set);
				}
				if (update.$addToSet) {
					for (const [k, v] of Object.entries(update.$addToSet)) {
						if (!Array.isArray(target[k])) target[k] = [];
						if (!target[k].includes(v)) target[k].push(v);
					}
				}
				if (update.$pull) {
					for (const [k, v] of Object.entries(update.$pull)) {
						if (Array.isArray(target[k])) {
							target[k] = target[k].filter((item: any) => item !== v);
						}
					}
				}
				if (update.$inc) {
					for (const [k, v] of Object.entries(update.$inc)) {
						target[k] = (Number(target[k]) || 0) + Number(v);
					}
				}
				return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
			},
			deleteOne: async (filter: Record<string, any>) => {
				const list = getColData(name);
				const idx = list.findIndex((doc) => matchesFilter(doc, filter));
				if (idx === -1) return { acknowledged: true, deletedCount: 0 };
				list.splice(idx, 1);
				return { acknowledged: true, deletedCount: 1 };
			},
			deleteMany: async (filter: Record<string, any>) => {
				const list = getColData(name);
				const before = list.length;
				const remaining = list.filter((doc) => !matchesFilter(doc, filter));
				store.set(name, remaining);
				return { acknowledged: true, deletedCount: before - remaining.length };
			},
			countDocuments: async (filter: Record<string, any> = {}) => {
				return getColData(name).filter((doc) => matchesFilter(doc, filter)).length;
			},
		};
	};

	return {
		command: async () => ({ ok: 1 }),
		collection,
	} as unknown as Db;
}

describe("Hello World worker", () => {
	it("responds with Hello World! (unit style)", async () => {
		const request = new IncomingRequest("http://example.com");
		// Create an empty context to pass to `worker.fetch()`.
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		// Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
		await waitOnExecutionContext(ctx);
		expect(await response.text()).toMatchInlineSnapshot(`"Hello World!"`);
	});

	it("responds with Hello World! (integration style)", async () => {
		const response = await SELF.fetch("https://example.com");
		expect(await response.text()).toMatchInlineSnapshot(`"Hello World!"`);
	});
});

describe("Security, XSS Sanitization & Subdomain Rules", () => {
	it("escapes dangerous HTML characters to prevent XSS (RNF4)", () => {
		const dirty = `<script>alert("xss")</script> & 'quotes'`;
		expect(sanitizeText(dirty)).toBe(
			"&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; &amp; &#39;quotes&#39;"
		);
	});

	it("validates allowed usernames and blocks reserved system routes (RN2, RN15)", () => {
		expect(validateUsername("joaosilva").valid).toBe(true);
		expect(validateUsername("admin").valid).toBe(false);
		expect(validateUsername("api").valid).toBe(false);
		expect(validateUsername("ab").valid).toBe(false);
	});

	it("extracts username from subdomain Host headers accurately (RN2)", () => {
		expect(extractSubdomainUsername("joaosilva.nicolaspitz.dev", "nicolaspitz.dev")).toBe("joaosilva");
		expect(extractSubdomainUsername("maria.dev.nicolaspitz.dev", "nicolaspitz.dev")).toBe("maria");
		expect(extractSubdomainUsername("nicolaspitz.dev", "nicolaspitz.dev")).toBeNull();
		expect(extractSubdomainUsername("api.nicolaspitz.dev", "nicolaspitz.dev")).toBeNull();
		expect(extractSubdomainUsername("pedro.localhost:8787", "nicolaspitz.dev")).toBe("pedro");
	});
});

describe("GuestBook API — Profiles, Comments, Likes & Subdomain Integration", () => {
	beforeEach(() => {
		setTestDatabase(createInMemoryMongoDb());
	});

	afterEach(() => {
		setTestDatabase(null);
	});

	it("initializes indexes and seeds demo data via /api/setup/seed", async () => {
		const res = await SELF.fetch("https://example.com/api/setup/seed", {
			method: "POST",
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, any>;
		expect(body.success).toBe(true);
		expect(body.profile.username).toBe("joaosilva");
	});

	it("performs full lifecycle: create profile, comment, like atomically, resolve via Host subdomain, and cascade delete", async () => {
		// 1. Criar perfil (RF1, RF2, RN1, RN2)
		const createRes = await SELF.fetch("https://example.com/api/profiles", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: "ana@exemplo.com",
				username: "anaclara",
				display_name: "Ana Clara",
				bio: "Meu mural retrô <3",
			}),
		});
		expect(createRes.status).toBe(201);
		const created = (await createRes.json()) as Record<string, any>;
		expect(created.profile.username).toBe("anaclara");
		expect(created.profile.bio).toBe("Meu mural retrô &lt;3");

		// 2. Bloquear username duplicado (RN2)
		const dupRes = await SELF.fetch("https://example.com/api/profiles", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: "outra@exemplo.com",
				username: "anaclara",
				display_name: "Outra Ana",
			}),
		});
		expect(dupRes.status).toBe(409);

		// 3. Publicar comentário anônimo com tentativa de XSS (RF10, RF11, RN6, RN7, RNF4)
		const commentRes = await SELF.fetch("https://example.com/api/profiles/anaclara/comments", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: "<img src=x onerror=alert(1)> Adorei seu perfil!",
			}),
		});
		expect(commentRes.status).toBe(201);
		const commentData = (await commentRes.json()) as Record<string, any>;
		expect(commentData.comment.author_name).toBe("Anônimo");
		expect(commentData.comment.content).toContain("&lt;img src=x onerror=alert(1)&gt;");
		const commentId = commentData.comment.id;

		// 4. Curtir comentário (RF13, RN9)
		const likeRes1 = await SELF.fetch(`https://example.com/api/comments/${commentId}/like`, {
			method: "POST",
			headers: { "X-Origin-Fingerprint": "visitante-1" },
		});
		expect(likeRes1.status).toBe(200);
		const likeBody1 = (await likeRes1.json()) as Record<string, any>;
		expect(likeBody1.likes_count).toBe(1);

		// 5. Bloquear curtida duplicada da mesma origem (RN9)
		const likeResDup = await SELF.fetch(`https://example.com/api/comments/${commentId}/like`, {
			method: "POST",
			headers: { "X-Origin-Fingerprint": "visitante-1" },
		});
		expect(likeResDup.status).toBe(409);

		// 6. Resolver perfil via header Host de subdomínio (RN2)
		const hostRes = await SELF.fetch("https://anaclara.nicolaspitz.dev/api/host-profile");
		expect(hostRes.status).toBe(200);
		const hostBody = (await hostRes.json()) as Record<string, any>;
		expect(hostBody.mode).toBe("subdomain");
		expect(hostBody.profile.username).toBe("anaclara");
		expect(hostBody.comments).toHaveLength(1);
		expect(hostBody.comments[0].likes_count).toBe(1);

		// 7. Excluir conta e verificar remoção em cascata (RF4, RN3)
		const delRes = await SELF.fetch("https://example.com/api/profiles/anaclara", {
			method: "DELETE",
		});
		expect(delRes.status).toBe(200);
		const delBody = (await delRes.json()) as Record<string, any>;
		expect(delBody.deleted_comments_count).toBe(1);

		const getAfterDel = await SELF.fetch("https://example.com/api/profiles/anaclara");
		expect(getAfterDel.status).toBe(404);
	});
});

describe("Regression Tests — Bug Prevention & Serverless Robustness", () => {
	beforeEach(() => {
		setTestDatabase(createInMemoryMongoDb());
	});

	afterEach(() => {
		setTestDatabase(null);
	});

	it("regression: enforces serverless connection pool safety (maxPoolSize: 1, minPoolSize: 0)", () => {
		const opts = getMongoConnectionOptions();
		expect(opts.maxPoolSize).toBe(1);
		expect(opts.minPoolSize).toBe(0);
		expect(opts.serverSelectionTimeoutMS).toBeLessThanOrEqual(5000);
		expect(opts.connectTimeoutMS).toBeLessThanOrEqual(5000);
	});

	it("regression: rejects underscores and non-DNS characters in usernames (RFC 1123 compliance)", async () => {
		// Garante que o bug 'visitante_1792110475' com underscore nunca seja aceito
		expect(validateUsername("visitante_1792110475").valid).toBe(false);
		expect(validateUsername("user.name").valid).toBe(false);
		expect(validateUsername("user@name").valid).toBe(false);
		expect(validateUsername("user name").valid).toBe(false);
		expect(validateUsername("-leadinghyphen").valid).toBe(false);
		expect(validateUsername("trailinghyphen-").valid).toBe(false);

		// Garante que o formato correto com hífen seja sempre aceito
		expect(validateUsername("visitante-1792110475").valid).toBe(true);

		// Valida rejeição na camada de API com HTTP 400
		const res = await SELF.fetch("https://example.com/api/profiles", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: "teste@exemplo.com",
				username: "visitante_invalido",
				display_name: "Teste",
			}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as Record<string, any>;
		expect(body.error).toContain("apenas letras minúsculas, números e hifens");
	});

	it("regression: handles rapid consecutive requests without isolate promise deadlocks", async () => {
		// Dispara 5 requisições rápidas consecutivas para garantir que o isolate não congele
		const requests = Array.from({ length: 5 }, (_, i) =>
			SELF.fetch("https://example.com/api/profiles", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					email: `concurrency-${i}@exemplo.com`,
					username: `user-conc-${i}`,
					display_name: `User ${i}`,
				}),
			})
		);

		const responses = await Promise.all(requests);
		for (const r of responses) {
			expect(r.status).toBe(201);
		}
	});

	it("regression: guarantees XSS protection on nested script and image tags", async () => {
		const res = await SELF.fetch("https://example.com/api/profiles", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: "sec@exemplo.com",
				username: "sec-user",
				display_name: "<b>User</b>",
				bio: "<script src='evil.js'></script>",
			}),
		});
		expect(res.status).toBe(201);
		const profile = ((await res.json()) as Record<string, any>).profile;
		expect(profile.display_name).toBe("&lt;b&gt;User&lt;/b&gt;");
		expect(profile.bio).toBe("&lt;script src=&#39;evil.js&#39;&gt;&lt;/script&gt;");
	});
});


describe("Authentication, Sessions (RN16), Password Reset (UC04/UC05) & Ownership (RN8)", () => {
	let testDb: Db;

	beforeEach(() => {
		testDb = createInMemoryMongoDb();
		setTestDatabase(testDb);
	});

	afterEach(() => {
		setTestDatabase(null);
	});

	it("authenticates automatically on registration (UC01), supports login/logout, and enforces ownership (RN8)", async () => {
		// 1. Criar conta com senha (UC01) -> emite session_token e cookie com Domain=.nicolaspitz.dev (RN16)
		const regOwner = await SELF.fetch("https://nicolaspitz.dev/api/profiles", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: "dono@exemplo.com",
				username: "donoperfil",
				display_name: "Dono do Perfil",
				password: "senhaSegura123",
			}),
		});
		expect(regOwner.status).toBe(201);
		const setCookieHeader = regOwner.headers.get("Set-Cookie") || "";
		expect(setCookieHeader).toContain("Domain=.nicolaspitz.dev");
		expect(setCookieHeader).toContain("HttpOnly");
		const ownerData = (await regOwner.json()) as Record<string, any>;
		expect(ownerData.session_token).toBeTruthy();
		const ownerToken = ownerData.session_token as string;

		// 2. Criar segunda conta (intruso)
		const regIntruder = await SELF.fetch("https://nicolaspitz.dev/api/profiles", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: "intruso@exemplo.com",
				username: "intruso",
				display_name: "Intruso",
				password: "outraSenha123",
			}),
		});
		expect(regIntruder.status).toBe(201);
		const intruderData = (await regIntruder.json()) as Record<string, any>;
		const intruderToken = intruderData.session_token as string;

		// 3. Visitante publica comentário no perfil do dono (RF10, RF15)
		const commentRes = await SELF.fetch("https://nicolaspitz.dev/api/profiles/donoperfil/comments", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				author_name: "Visitante",
				content: "Recado importante!",
			}),
		});
		expect(commentRes.status).toBe(201);
		const commentBody = (await commentRes.json()) as Record<string, any>;
		expect(commentBody.owner_notified).toBe(true);
		const commentId = commentBody.comment.id as string;

		// 4. Sem token: bloquear edição/exclusão de conta protegida por senha (401)
		const unauthPatch = await SELF.fetch("https://nicolaspitz.dev/api/profiles/donoperfil", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ bio: "Hackeado" }),
		});
		expect(unauthPatch.status).toBe(401);

		const unauthDelComment = await SELF.fetch(`https://nicolaspitz.dev/api/comments/${commentId}`, {
			method: "DELETE",
		});
		expect(unauthDelComment.status).toBe(401);

		// 5. Com token de outro usuário (intruso): bloquear com 403 Forbidden (RN8)
		const forbiddenPatch = await SELF.fetch("https://nicolaspitz.dev/api/profiles/donoperfil", {
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${intruderToken}`,
			},
			body: JSON.stringify({ bio: "Hackeado pelo intruso" }),
		});
		expect(forbiddenPatch.status).toBe(403);

		const forbiddenDelComment = await SELF.fetch(`https://nicolaspitz.dev/api/comments/${commentId}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${intruderToken}` },
		});
		expect(forbiddenDelComment.status).toBe(403);

		// 6. Com token do próprio dono: permitir edição de perfil (UC02) e exclusão de comentário (UC09, RN8)
		const ownerPatch = await SELF.fetch("https://nicolaspitz.dev/api/profiles/donoperfil", {
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({
				bio: "Bio oficial atualizada",
				theme_config: {
					background_color: "#001122",
					accent_color: "#ff00aa",
					font_family: "Courier New",
					malicious_key: "expression(alert(1))",
				},
			}),
		});
		expect(ownerPatch.status).toBe(200);
		const patchedProfile = ((await ownerPatch.json()) as Record<string, any>).profile;
		expect(patchedProfile.bio).toBe("Bio oficial atualizada");
		expect(patchedProfile.theme_config.background_color).toBe("#001122");
		expect(patchedProfile.theme_config.malicious_key).toBeUndefined();

		const ownerDelComment = await SELF.fetch(`https://nicolaspitz.dev/api/comments/${commentId}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${ownerToken}` },
		});
		expect(ownerDelComment.status).toBe(200);

		// 7. Consultar /api/auth/me, fazer logout e fazer login novamente
		const meRes = await SELF.fetch("https://nicolaspitz.dev/api/auth/me", {
			headers: { Authorization: `Bearer ${ownerToken}` },
		});
		expect(meRes.status).toBe(200);
		const meBody = (await meRes.json()) as Record<string, any>;
		expect(meBody.authenticated).toBe(true);
		expect(meBody.profile.username).toBe("donoperfil");

		const logoutRes = await SELF.fetch("https://nicolaspitz.dev/api/auth/logout", {
			method: "POST",
			headers: { Authorization: `Bearer ${ownerToken}` },
		});
		expect(logoutRes.status).toBe(200);

		const meAfterLogout = await SELF.fetch("https://nicolaspitz.dev/api/auth/me", {
			headers: { Authorization: `Bearer ${ownerToken}` },
		});
		expect(meAfterLogout.status).toBe(401);

		const loginRes = await SELF.fetch("https://nicolaspitz.dev/api/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: "dono@exemplo.com",
				password: "senhaSegura123",
			}),
		});
		expect(loginRes.status).toBe(200);
		const loginBody = (await loginRes.json()) as Record<string, any>;
		expect(loginBody.session_token).toBeTruthy();
	});

	it("supports password change (UC04, RN5) and single-use password reset token flow (UC05, RN4)", async () => {
		const regRes = await SELF.fetch("https://nicolaspitz.dev/api/profiles", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: "recuperar@exemplo.com",
				username: "user-senha",
				display_name: "User Senha",
				password: "senhaInicial123",
			}),
		});
		expect(regRes.status).toBe(201);
		const { session_token: token } = (await regRes.json()) as Record<string, any>;

		// 1. Alterar senha permitindo senha igual à anterior (RN5)
		const samePassRes = await SELF.fetch("https://nicolaspitz.dev/api/auth/change-password", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				current_password: "senhaInicial123",
				new_password: "senhaInicial123",
			}),
		});
		expect(samePassRes.status).toBe(200);

		// 2. Rejeitar senha atual incorreta (UC04)
		const wrongPassRes = await SELF.fetch("https://nicolaspitz.dev/api/auth/change-password", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				current_password: "senhaErrada999",
				new_password: "novaSenha456",
			}),
		});
		expect(wrongPassRes.status).toBe(403);

		// 3. Solicitar recuperação de senha (UC05)
		const forgotRes = await SELF.fetch("https://nicolaspitz.dev/api/auth/forgot-password", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "recuperar@exemplo.com" }),
		});
		expect(forgotRes.status).toBe(200);

		// 4. Testar redefinição com token conhecido inserido na coleção password_reset_tokens (RN4)
		const userDoc = await testDb.collection("users").findOne({ email: "recuperar@exemplo.com" });
		expect(userDoc).toBeTruthy();

		const rawResetToken = "token-unico-recuperacao-123456";
		const encoder = new TextEncoder();
		const hashBuf = await crypto.subtle.digest("SHA-256", encoder.encode(rawResetToken));
		const tokenHash = Array.from(new Uint8Array(hashBuf))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");

		await testDb.collection("password_reset_tokens").insertOne({
			user_id: userDoc!._id,
			token_hash: tokenHash,
			expires_at: new Date(Date.now() + 3600_000),
			used_at: null,
			created_at: new Date(),
		});

		const resetRes = await SELF.fetch("https://nicolaspitz.dev/api/auth/reset-password", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				token: rawResetToken,
				new_password: "senhaRedefinida789",
			}),
		});
		expect(resetRes.status).toBe(200);

		// 5. Garantir que o mesmo token não pode ser reutilizado (RN4)
		const reuseRes = await SELF.fetch("https://nicolaspitz.dev/api/auth/reset-password", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				token: rawResetToken,
				new_password: "outraTentativa789",
			}),
		});
		expect(reuseRes.status).toBe(400);

		// 6. Login com a nova senha funciona
		const loginNew = await SELF.fetch("https://nicolaspitz.dev/api/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: "recuperar@exemplo.com",
				password: "senhaRedefinida789",
			}),
		});
		expect(loginNew.status).toBe(200);
	});

	it("serves embeddable widget script/iframe (RF14, UC10), R2 avatar upload (RF3) and OpenAPI spec", async () => {
		const regRes = await SELF.fetch("https://nicolaspitz.dev/api/profiles", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: "widget@exemplo.com",
				username: "retro-widget",
				display_name: "Retro Widget",
				password: "senhaSegura123",
			}),
		});
		expect(regRes.status).toBe(201);
		const { session_token: token } = (await regRes.json()) as Record<string, any>;

		// 1. Widget script (embed.js) e iframe HTML (frame)
		const scriptRes = await SELF.fetch("https://nicolaspitz.dev/api/widget/retro-widget/embed.js");
		expect(scriptRes.status).toBe(200);
		expect(scriptRes.headers.get("Content-Type")).toContain("application/javascript");
		expect(await scriptRes.text()).toContain("retro-widget");

		const frameRes = await SELF.fetch("https://nicolaspitz.dev/api/widget/retro-widget/frame");
		expect(frameRes.status).toBe(200);
		expect(await frameRes.text()).toContain("GuestBook de Retro Widget");

		// 2. Upload de avatar no R2 (RF3)
		const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
		const avatarRes = await SELF.fetch("https://nicolaspitz.dev/api/profiles/retro-widget/avatar", {
			method: "POST",
			headers: {
				"Content-Type": "image/png",
				Authorization: `Bearer ${token}`,
			},
			body: pngBytes,
		});
		expect(avatarRes.status).toBe(200);
		const avatarData = (await avatarRes.json()) as Record<string, any>;
		expect(avatarData.avatar_url).toContain("/api/avatars/");

		// Buscar o avatar recém-enviado
		const getAvatarRes = await SELF.fetch(avatarData.avatar_url);
		expect(getAvatarRes.status).toBe(200);
		expect(getAvatarRes.headers.get("Content-Type")).toBe("image/png");

		// 3. Especificação OpenAPI 3.0
		const openApiRes = await SELF.fetch("https://nicolaspitz.dev/api/openapi.json");
		expect(openApiRes.status).toBe(200);
		const spec = (await openApiRes.json()) as Record<string, any>;
		expect(spec.openapi).toBe("3.0.3");
		expect(spec.paths["/api/auth/login"]).toBeDefined();
	});
});
