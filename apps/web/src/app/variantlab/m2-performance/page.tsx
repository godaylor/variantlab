import type { Metadata } from "next";
import { M2PerformanceHarness } from "@/variantlab/m2-performance-harness";
import { VariantLabLocaleProvider } from "@/variantlab/locale";

export const metadata: Metadata = {
	title: "VariantLab M2 performance evidence",
	description: "Reference 2-hour, 20-track, 10,000-clip rough-cut corpus.",
};

export default function M2PerformancePage() {
	return <VariantLabLocaleProvider><M2PerformanceHarness /></VariantLabLocaleProvider>;
}
