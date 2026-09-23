"use client";

import { VariantLabLanguageSwitch, VariantLabLocaleProvider } from "@/variantlab/locale";
import { VariantLabStudio } from "@/variantlab/studio";

export function VariantLabShell({ browserLocal = false, sitesConnected = false }: { browserLocal?: boolean; sitesConnected?: boolean }) {
	return (
		<VariantLabLocaleProvider>
			<VariantLabLanguageSwitch />
			<VariantLabStudio browserLocal={browserLocal} sitesConnected={sitesConnected} />
		</VariantLabLocaleProvider>
	);
}
