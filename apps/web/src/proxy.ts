import { NextResponse, type NextRequest } from "next/server";

/** Per-request policy: the nonce is forwarded to Next's script renderer. */
export function proxy(request: NextRequest) {
	const nonce = btoa(crypto.randomUUID());
	const development = process.env.NODE_ENV !== "production";
	const storageOrigin = new URL(
		process.env.VARIANTLAB_PUBLIC_STORAGE_URL ?? "http://127.0.0.1:32212",
	).origin;
	const policy = [
		"default-src 'self'",
		`script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${development ? " 'unsafe-eval'" : ""}`,
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' blob: data:",
		"font-src 'self'",
		`connect-src 'self' ${storageOrigin}${development ? " ws://127.0.0.1:* ws://localhost:*" : ""}`,
		`media-src 'self' blob: ${storageOrigin}`,
		"worker-src 'self' blob:",
		"object-src 'none'",
		"base-uri 'self'",
		"form-action 'self'",
		"frame-ancestors 'none'",
	].join("; ");
	const headers = new Headers(request.headers);
	headers.set("x-nonce", nonce);
	headers.set("content-security-policy", policy);
	const response = NextResponse.next({ request: { headers } });
	response.headers.set("content-security-policy", policy);
	response.headers.set("x-content-type-options", "nosniff");
	response.headers.set("referrer-policy", "no-referrer");
	response.headers.set(
		"permissions-policy",
		"camera=(), microphone=(), geolocation=()",
	);
	response.headers.set("x-frame-options", "DENY");
	response.headers.set("cache-control", "no-store");
	if (request.nextUrl.pathname === "/variantlab/review") {
		response.headers.set("x-robots-tag", "noindex, nofollow, noarchive");
	}
	// Trust the configured public origin, never an untrusted forwarded header.
	if (process.env.NEXT_PUBLIC_SITE_URL?.startsWith("https://")) {
		response.headers.set(
			"strict-transport-security",
			"max-age=31536000; includeSubDomains",
		);
	}
	return response;
}

export const config = {
	matcher: ["/variantlab/:path*", "/api/variantlab/:path*", "/api/auth/:path*"],
};
