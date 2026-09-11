"use client";

import { VariantLabLanguageSwitch, VariantLabLocaleProvider } from "@/variantlab/locale";
import { VariantLabStudio } from "@/variantlab/studio";

export function VariantLabShell({ browserLocal = false }: { browserLocal?: boolean }) {
	return (
		<VariantLabLocaleProvider>
			<VariantLabLanguageSwitch />
			<VariantLabStudio browserLocal={browserLocal} />
		</VariantLabLocaleProvider>
	);
}
