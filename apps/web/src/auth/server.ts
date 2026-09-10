import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@/db";
import { webEnv } from "@/env/web";

const siteUrl = webEnv.VARIANTLAB_SITE_URL ?? webEnv.NEXT_PUBLIC_SITE_URL;

export const auth = betterAuth({
	database: drizzleAdapter(db, {
		provider: "pg",
		usePlural: true,
	}),
	secret: webEnv.BETTER_AUTH_SECRET,
	user: {
		deleteUser: {
			enabled: false,
		},
	},
	emailAndPassword: {
		enabled: true,
	},
	rateLimit: {
		enabled: true,
		storage: "database",
	},
	baseURL: siteUrl,
	appName: "VariantLab",
	trustedOrigins: [siteUrl],
});

export type Auth = typeof auth;
