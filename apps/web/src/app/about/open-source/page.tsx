import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
	title: "VariantLab — открытый исходный код",
	description: "Лицензии, происхождение и уведомления об открытом исходном коде VariantLab.",
};

export default function OpenSourceAttributionPage() {
	return (
		<main className="min-h-screen bg-[#e7e9e6] p-6 text-[#172128] lg:p-12">
			<article className="mx-auto max-w-3xl border-2 border-[#172128] bg-[#f6f7f4] p-6 shadow-[6px_6px_0_#172128] lg:p-10">
				<p className="font-mono text-xs font-bold uppercase tracking-[0.18em] text-[#48606d]">VariantLab / Open Source</p>
				<h1 className="mt-3 text-4xl font-black tracking-tight">Лицензии и происхождение</h1>
				<p className="mt-6 leading-7">VariantLab использует upstream editor codebase с лицензией MIT. VariantLab — самостоятельный продукт и не заявляет об endorsement сторонних проектов.</p>
				<p className="mt-4 leading-7">Корневой файл LICENSE, исходное авторское уведомление, история Git и сведения о сторонних компонентах сохранены без удаления.</p>
				<div className="mt-8 flex flex-wrap gap-3">
					<Link href="/variantlab" className="border-2 border-[#172128] bg-[#194f78] px-4 py-2 font-bold text-white">Вернуться в VariantLab</Link>
					<a href="https://github.com/godaylor/variantlab" rel="noreferrer" className="border-2 border-[#172128] px-4 py-2 font-bold">Репозиторий VariantLab</a>
				</div>
			</article>
		</main>
	);
}
