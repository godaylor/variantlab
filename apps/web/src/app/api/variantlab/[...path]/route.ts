/* eslint-disable variantlab/prefer-object-params -- Next route handlers require (request, context). */
import { createHash, createHmac, randomUUID } from "node:crypto";
import { auth } from "@/auth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ path: string[] }> };

function encodeIdentity(actorId: string) {
	const secret = process.env.VARIANTLAB_BFF_SECRET;
	if (!secret || secret.length < 24) throw new Error("VARIANTLAB_BFF_SECRET must contain at least 24 characters");
	const digest = createHash("sha256").update(actorId).digest("hex").slice(0, 24);
	const payload = Buffer.from(JSON.stringify({
		tenant_id: `tenant-personal-${digest}`,
		actor_id: actorId,
		role: "owner",
		expires_at_unix: Math.floor(Date.now() / 1000) + 60,
		nonce: randomUUID(),
	})).toString("base64url");
	return {
		payload,
		signature: createHmac("sha256", secret).update(payload).digest("base64url"),
	};
}

function secureHeaders(headers = new Headers()) {
	headers.set("cache-control", "no-store");
	headers.set("x-content-type-options", "nosniff");
	headers.set("referrer-policy", "no-referrer");
	headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
	return headers;
}

async function handler(request: Request, context: RouteContext) {
	const siteUrl = process.env.VARIANTLAB_SITE_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? "http://127.0.0.1:32200";
	if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
		const origin = request.headers.get("origin");
		if (origin !== siteUrl) return Response.json({ error: { code: "csrf_rejected", message: "Origin is not trusted" } }, { status: 403, headers: secureHeaders() });
	}
	const testActor = process.env.VARIANTLAB_M8_TEST_MODE === "1" && request.headers.get("x-variantlab-e2e") === "1"
		? "variantlab-m8-test-operator"
		: null;
	const session = await auth.api.getSession({ headers: request.headers });
	// Real sessions always win, including in the explicitly test-only profile.
	const { path } = await context.params;
	const reviewAccess = request.method === "POST" && path.length === 1 && ["review-access", "review-decision"].includes(path[0]);
	const actorId = session?.user.id ?? testActor;
	if (!actorId && !reviewAccess) return Response.json({ error: { code: "authentication_required", message: "Sign in to use connected rendering" } }, { status: 401, headers: secureHeaders() });
	if (!path.length || path.some((segment) => !/^[a-zA-Z0-9._-]+$/.test(segment))) {
		return Response.json({ error: { code: "invalid_path", message: "Connected API path is invalid" } }, { status: 400, headers: secureHeaders() });
	}
	const upstream = process.env.VARIANTLAB_CONTROL_PLANE_URL ?? "http://127.0.0.1:32201";
	const url = new URL(`/v1/${path.join("/")}`, upstream);
	url.search = new URL(request.url).search;
	const identity = actorId ? encodeIdentity(actorId) : null;
	const headers = new Headers();
	for (const name of ["accept", "content-type", "content-length", "x-content-sha256", "if-match"]) {
		const value = request.headers.get(name);
		if (value) headers.set(name, value);
	}
	if (identity) {
		headers.set("x-variantlab-identity", identity.payload);
		headers.set("x-variantlab-signature", identity.signature);
	}
	const init: RequestInit & { duplex?: "half" } = {
		method: request.method,
		headers,
		body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
		redirect: "manual",
	};
	if (init.body) init.duplex = "half";
	const response = await fetch(url, init);
	const responseHeaders = secureHeaders(new Headers());
	for (const name of ["content-type", "cache-control", "etag", "last-modified"]) {
		const value = response.headers.get(name);
		if (value) responseHeaders.set(name, value);
	}
	responseHeaders.set("cache-control", "no-store");
	return new Response(response.body, { status: response.status, headers: responseHeaders });
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
