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
import { setTestDatabase } from "../src/db";
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
