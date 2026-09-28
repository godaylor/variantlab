"use client";

import { useEffect, useRef, useState } from "react";
import { useVariantLabLocale } from "./locale";

// An optional, read-only guide. It never creates, edits, uploads or resets data.
export function EditorGuide() {
	const { t } = useVariantLabLocale();
	const [step, setStep] = useState<number | null>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const panel = useRef<HTMLDivElement>(null);
	const [targetNotice, setTargetNotice] = useState("");
	const highlighted = useRef<{ element: HTMLElement; shadow: string } | null>(null);
	const steps = [
		{ target: "#campaign-name", title: t({ ru: "Создайте учебную кампанию", en: "Create a practice campaign" }), text: t({ ru: "Введите новое название в поле «Название новой кампании» и нажмите «+ Новая кампания». Для знакомства используйте отдельную кампанию: текущая работа сохранится.", en: "Enter a new name in ‘New campaign name’, then choose ‘+ New campaign’. Use a separate campaign for practice; your current work stays saved." }) },
		{ target: "#media-library", title: t({ ru: "Добавьте исходник", en: "Add a source file" }), text: t({ ru: "В разделе «Монтаж» нажмите «Добавить видео или аудио». Файл останется на вашем устройстве, пока вы сами не выберете загрузку в облако.", en: "In Edit, choose ‘Import master media’. Your file stays on this device until you choose to upload it to the cloud." }) },
		{ target: '[data-testid="m2-timeline"]', title: t({ ru: "Уберите лишний фрагмент", en: "Remove a clip" }), text: t({ ru: "Выберите клип на ленте, затем «Удалить выбранные клипы». Исходник остаётся в «Файлах». Кнопка «Отменить в активной сцене» возвращает клип.", en: "Select a timeline clip, then ‘Delete selected clips’. Its source stays in Files. ‘Undo active scene’ restores the clip." }) },
		{ target: "#variant-matrix", title: t({ ru: "Подготовьте форматы", en: "Prepare formats" }), text: t({ ru: "Создайте вертикальную версию 9:16. Кнопка «Добавить форматы 16:9 и 1:1» добавляет остальные; выберите их в таблице и нажмите «Включить».", en: "Create the 9:16 portrait version. Add 16:9 and 1:1 formats, select them in the table and choose Enable." }) },
		{ target: "#export-package", title: t({ ru: "Скачайте видео", en: "Download your video" }), text: t({ ru: "В «Экспорте» выберите версии, нажмите «Проверить перед экспортом», затем «Создать видео на устройстве». Не закрывайте вкладку до появления кнопки «Скачать».", en: "In Export, select versions, run Preflight and start local rendering. Keep the tab open until Download appears." }) },
		{ target: "#connected-workspace", title: t({ ru: "Сохраните в личное облако", en: "Save to your private cloud" }), text: t({ ru: "Войдите через ChatGPT, сохраните кампанию в облако и загрузите оригиналы. На другом устройстве войдите в тот же аккаунт и откройте свою кампанию.", en: "Sign in with ChatGPT, save your campaign to the cloud and upload originals. Sign in to the same account on another device to reopen it." }) },
	];
	function closeGuide() { setStep(null); trigger.current?.focus(); }
	useEffect(() => {
		const restore = () => {
			if (highlighted.current) highlighted.current.element.style.boxShadow = highlighted.current.shadow;
			highlighted.current = null;
		};
		restore();
		if (step === null) return;
		panel.current?.focus();
		const escape = (event: KeyboardEvent) => {
			if (event.key === "Escape") { setStep(null); trigger.current?.focus(); }
		};
		document.addEventListener("keydown", escape);
		return () => { document.removeEventListener("keydown", escape); restore(); };
	}, [step]);
	function showTarget() {
		if (step === null) return;
		const target = document.querySelector<HTMLElement>(steps[step].target);
		if (!target || target.getClientRects().length === 0) {
			setTargetNotice(t({ ru: "Этот элемент появится после открытия кампании на широком экране. Можно перейти к следующему шагу или закрыть инструкцию.", en: "This control appears after opening a campaign in a wide window. You can continue to the next step or close the guide." }));
			return;
		}
		setTargetNotice("");
		if (highlighted.current) highlighted.current.element.style.boxShadow = highlighted.current.shadow;
		highlighted.current = { element: target, shadow: target.style.boxShadow };
		target.style.boxShadow = "0 0 0 4px #a15d00";
		target.scrollIntoView({ behavior: "instant", block: "center" });
		target.focus({ preventScroll: true });
	}
	return <div className="mx-auto max-w-[1500px] px-5 py-3">
		<button ref={trigger} type="button" onClick={() => setStep(0)} aria-expanded={step !== null} aria-controls="editor-guide" className="min-h-11 border-2 border-[#172128] bg-white px-4 font-bold focus-visible:outline-3 focus-visible:outline-[#a15d00]">{t({ ru: "Как пользоваться", en: "How to use" })}</button>
		{step !== null && <div ref={panel} id="editor-guide" role="region" aria-label={t({ ru: "Как пользоваться", en: "How to use" })} tabIndex={-1} className="mt-3 border-2 border-[#172128] bg-white p-4 focus-visible:outline-3 focus-visible:outline-[#a15d00]">
			<p className="text-sm">{step + 1} / {steps.length}</p>
			<h2 className="my-2 text-xl font-bold">{steps[step].title}</h2>
			<p className="max-w-prose text-sm leading-6">{steps[step].text}</p>
			{targetNotice && <p role="status" className="mt-2 text-sm">{targetNotice}</p>}
			<p className="my-2 text-sm lg:hidden">{t({ ru: "Монтаж доступен при ширине окна от 1024 px. Здесь можно знакомиться с шагами, сохранять и скачивать готовое.", en: "Editing needs a window at least 1024 px wide. Here you can read the guide, save and download finished work." })}</p>
			<div className="mt-3 flex flex-wrap gap-2 [&>button]:min-h-11 [&>button]:border [&>button]:border-[#172128] [&>button]:px-3 [&>button]:font-bold [&>button]:focus-visible:outline-3">
				<button type="button" disabled={step === 0} onClick={() => setStep(step - 1)}>{t({ ru: "Назад", en: "Back" })}</button>
				<button type="button" onClick={showTarget}>{t({ ru: "Показать элемент", en: "Show control" })}</button>
				{step < steps.length - 1 ? <button type="button" onClick={() => setStep(step + 1)}>{t({ ru: "Далее", en: "Next" })}</button> : <button type="button" onClick={closeGuide}>{t({ ru: "Завершить", en: "Finish" })}</button>}
				<button type="button" onClick={closeGuide}>{t({ ru: "Пропустить", en: "Skip" })}</button>
			</div>
		</div>}
	</div>;
}
