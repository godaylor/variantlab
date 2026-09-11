import type { Metadata } from "next";
import { cookies } from "next/headers";
import { VariantLabShell } from "./variantlab-shell";

const METADATA = {
	ru: {
		title: "VariantLab — студия рекламных вариантов",
		description: "Управляемые рекламные варианты из одной мастер-таймлинии.",
		openGraphLocale: "ru_RU",
	},
	en: {
		title: "VariantLab — advertising variant studio",
		description: "Controlled advertising variants from one master timeline.",
		openGraphLocale: "en_US",
	},
} as const;

export async function generateMetadata(): Promise<Metadata> {
	const cookieStore = await cookies();
	const locale = cookieStore.get("variantlab-language")?.value === "en" ? "en" : "ru";
	const metadata = METADATA[locale];
	return {
		title: metadata.title,
		description: metadata.description,
		openGraph: {
			title: metadata.title,
			description: metadata.description,
			locale: metadata.openGraphLocale,
			type: "website",
			siteName: "VariantLab",
		},
		twitter: {
			card: "summary_large_image",
			title: metadata.title,
			description: metadata.description,
		},
	};
}

export default async function VariantLabPage({ searchParams }: {
	searchParams: Promise<{ publication?: string }>;
}) {
	const params = await searchParams;
	return <VariantLabShell browserLocal={params.publication === "browser-local"} />;
}
