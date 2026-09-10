"use client";

import { VariantLabLanguageSwitch, VariantLabLocaleProvider } from "@/variantlab/locale";
import { VariantLabStudio } from "@/variantlab/studio";

export function VariantLabShell() {
	return (
		<VariantLabLocaleProvider>
			<VariantLabLanguageSwitch />
			<VariantLabStudio />
		</VariantLabLocaleProvider>
	);
}
