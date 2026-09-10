"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

export type VariantLabLocale = "ru" | "en";

const STORAGE_KEY = "variantlab:language";

const METADATA_COPY = {
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

function setMetaContent({ selector, content }: { selector: string; content: string }) {
	const element = document.head.querySelector<HTMLMetaElement>(selector);
	if (element) element.content = content;
}

type LocaleContextValue = {
	locale: VariantLabLocale;
	hydrated: boolean;
	setLocale: (locale: VariantLabLocale) => void;
	t: (copy: { ru: string; en: string }) => string;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function VariantLabLocaleProvider({ children }: { children: React.ReactNode }) {
	const [locale, setLocaleState] = useState<VariantLabLocale>("ru");
	const [hydrated, setHydrated] = useState(false);

	useEffect(() => {
		const stored = localStorage.getItem(STORAGE_KEY);
		// eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate the persisted user preference once.
		if (stored === "en" || stored === "ru") setLocaleState(stored);
		setHydrated(true);
	}, []);

	const setLocale = useCallback((next: VariantLabLocale) => {
		setLocaleState(next);
		localStorage.setItem(STORAGE_KEY, next);
		document.cookie = `variantlab-language=${next}; Path=/; Max-Age=31536000; SameSite=Lax`;
		document.documentElement.lang = next;
	}, []);

	useEffect(() => {
		const metadata = METADATA_COPY[locale];
		document.documentElement.lang = locale;
		document.title = metadata.title;
		setMetaContent({ selector: 'meta[name="description"]', content: metadata.description });
		setMetaContent({ selector: 'meta[property="og:title"]', content: metadata.title });
		setMetaContent({ selector: 'meta[property="og:description"]', content: metadata.description });
		setMetaContent({ selector: 'meta[property="og:locale"]', content: metadata.openGraphLocale });
		setMetaContent({ selector: 'meta[name="twitter:title"]', content: metadata.title });
		setMetaContent({ selector: 'meta[name="twitter:description"]', content: metadata.description });
	}, [locale]);

	const value = useMemo<LocaleContextValue>(
		() => ({ locale, hydrated, setLocale, t: (copy) => copy[locale] }),
		[locale, hydrated, setLocale],
	);

	return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useVariantLabLocale(): LocaleContextValue {
	const value = useContext(LocaleContext);
	if (!value) throw new Error("VariantLab locale provider is missing");
	return value;
}

export function VariantLabLanguageSwitch({ position = "fixed" }: { position?: "fixed" | "inline" }) {
	const { locale, hydrated, setLocale, t } = useVariantLabLocale();
	return (
		<div className={`${position === "fixed" ? "fixed right-4 top-4 z-50" : "w-fit"} flex border-2 border-[#172128] bg-[#f6f7f4] shadow-[2px_2px_0_#172128]`} aria-label={t({ ru: "Язык интерфейса", en: "Interface language" })}>
			{(["ru", "en"] as const).map((value) => (
				<button
					key={value}
					type="button"
					onClick={() => setLocale(value)}
					disabled={!hydrated}
					aria-pressed={locale === value}
					className="px-3 py-2 font-mono text-xs font-black uppercase aria-pressed:bg-[#194f78] aria-pressed:text-white focus-visible:outline-4 focus-visible:outline-[#d26532]"
				>
					{value}
				</button>
			))}
		</div>
	);
}

export const localeStorageKey = STORAGE_KEY;
