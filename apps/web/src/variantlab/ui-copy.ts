"use client";
import { useVariantLabLocale } from "./locale";

// Static interface copy only. Never call this with user text, filenames or asset names.
export const UI_COPY: Record<string, string> = {
	"succeeded · verified": "Готово · файл проверен",
	"succeeded · stale revision": "Готово для прежней версии кампании",
	"Free storage or change destination.": "Освободите место или выберите другую папку.",
	"Relink or repair the source media.": "Добавьте исходный файл заново или исправьте повреждённый файл.",
	"Choose a supported codec or preset.": "Выберите формат экспорта, который поддерживает ваш браузер.",
	"Review the failure details before retrying.": "Проверьте причину ошибки и повторите экспорт.",
	"Content probe": "Проверка содержимого",
	"Preview proxy": "Копия для быстрого просмотра",
	"Waveform pyramid": "Многоуровневая звуковая волна",
	"Media jobs are loading.": "Загрузка медиа-задач.",
	"Media jobs are idle.": "Нет активных медиа-задач.",
	"Media jobs are ready.": "Медиа-задачи готовы.",
	"Recovered local jobs. They were paused while the tab was closed.": "Локальные задачи восстановлены. Пока вкладка была закрыта, выполнение было приостановлено.",
	"Copying the original to protected staging storage.": "Копируем исходный файл на это устройство.",
	"Import stopped before the asset manifest was committed.": "Импорт остановлен до сохранения описания медиа.",
	"Original copied. Content probe is queued before the asset becomes visible.": "Файл скопирован. Проверяем, можно ли его открыть.",
	"Import failed before the asset manifest was committed.": "Импорт не выполнен; описание медиа не сохранено.",
	"Probe passed. Playback can use the original while proxy and waveform continue.": "Файл готов к просмотру. Дополнительные данные для монтажа ещё готовятся.",
	"Proxy and waveform are yielding to active playback.": "Подготовка прокси и звуковой волны уступает приоритет воспроизведению.",
	"Proxy derivative is ready.": "Прокси готов.",
	"Waveform derivative is ready.": "Звуковая волна готова.",
	"Retry this job": "Повторите задачу",
	"Choose the original unmodified media file": "Выберите исходный неизменённый медиафайл",
	"Open in a browser with VP9/VP8 WebCodecs support or use a connected proxy provider": "Откройте в браузере с поддержкой VP9/VP8 WebCodecs или используйте подключённого поставщика прокси",
	overflow: "текст не помещается",
	"missing glyph": "нет символа в шрифте",
	readability: "читаемость",
	"Caption exceeds the safe-area line capacity":
		"Субтитр не помещается в строки безопасной области",
	"Shorten the caption or select a smaller permitted size":
		"Сократите субтитр или выберите меньший разрешённый размер",
	"Caption reading speed exceeds the locale limit":
		"Скорость чтения субтитра превышает ограничение языкового профиля",
	"Shorten the copy or split it at a word boundary":
		"Сократите текст или разделите его по границе слова",
	"Add a licensed font with the required Unicode range":
		"Добавьте лицензированный шрифт с нужным диапазоном Unicode",
	"The crop is near the edge of the allowlisted safe geometry.":
		"Кадрирование близко к границе допустимой безопасной области.",
	"Nudge toward center or reset to master.":
		"Сдвиньте к центру или восстановите значение мастера.",
	"A required brand logo slot is missing.":
		"Отсутствует обязательный слот логотипа бренда.",
	"Create a typed logo slot or assign its explicit CreativeSet replacement.":
		"Создайте типизированный слот логотипа или явно назначьте замену в наборе креативов.",
	"DeliveryProfile safe area does not contain the BrandKit custom safe region.":
		"Безопасная область профиля формата не вмещает область BrandKit.",
	"Increase the profile safe-area insets to the named BrandKit region.":
		"Увеличьте отступы безопасной области профиля до указанной области BrandKit.",
	"DeliveryProfile font is not in the BrandKit allowlist.":
		"Шрифт профиля формата отсутствует в списке разрешённых BrandKit.",
	"Choose an allowed font token in the DeliveryProfile.":
		"Выберите разрешённый шрифт в профиле формата.",
	"DeliveryProfile color is not in the BrandKit allowlist.":
		"Цвет профиля формата отсутствует в списке разрешённых BrandKit.",
	"Choose an allowed color token in the DeliveryProfile.":
		"Выберите разрешённый цвет в профиле формата.",
	"MasterSequence duration is outside the BrandKit rule.":
		"Длительность мастер-таймлинии не соответствует правилу BrandKit.",
	"Edit MasterSequence timing; profile and cell overrides cannot change it.":
		"Измените время мастер-таймлинии: профиль и исключения ячеек не могут его менять.",
	queued: "в очереди",
	preparing: "подготовка",
	running: "выполняется",
	pausing: "приостановка",
	paused: "приостановлено",
	cancelling: "отмена",
	succeeded: "завершено",
	failed: "ошибка",
	cancelled: "отменено",
	ready: "готово",
	warning: "предупреждение",
	error: "ошибка",
	stale: "устарело",
	detached: "отделено",
	disabled: "выключено",
	"yielding to playback": "приоритет воспроизведения",
	"Transcription ready": "Распознавание готово к запуску",
	"M4 / controlled creative rows": "Текст и содержание версий",
	"Creative slot board": "Заголовки, логотип и призыв к действию",
	"Typed values inherit master timing and style; assignments never copy the timeline.":
		"Заменяйте содержание отдельных версий. Длительность и исходный монтаж сохранятся.",
	Rows: "Наборы",
	Slots: "Слоты",
	"/ 32 · cells": "/ 32 · ячейки",
	"Setup and source bundle": "Настройка и исходный набор",
	"Declare standard creative slots": "Создать стандартные креативные слоты",
	"Create 3 hook sets": "Создать 3 набора вступлений",
	"Draggable source": "Перетаскиваемый источник",
	"Hook + headline + CTA": "Вступление + заголовок + призыв",
	"3 typed assignments · fixed duration":
		"3 замены · длительность не меняется",
	"Staged via": "Подготовлено через",
	"Apply staged assignment": "Применить подготовленное назначение",
	Cancel: "Отмена",
	"Source of truth": "Источник данных",
	"Drop bundle here": "Перетащите набор сюда",
	"Assign bundle via menu": "Назначить набор через меню",
	"Undo this row": "Отменить изменение набора",
	"Create the M3 delivery profile before CreativeSet rows.":
		"Сначала создайте вертикальную версию 9:16 в блоке предпросмотра выше.",
	"Master inheritance and safe deletion":
		"Наследование мастера и безопасное удаление",
	"Update master headline style": "Обновить стиль заголовка мастера",
	"Delete live Hook slot": "Удалить используемый слот вступления",
	"Remap Hook to fallback + delete": "Переназначить вступление и удалить слот",
	"Drop references + delete": "Удалить ссылки и слот",
	"Undo master slot change": "Отменить изменение слота мастера",
	"Audit ·": "История ·",
	"Creative command blocked": "Креативная команда отклонена",
	"M5 · local captions": "Субтитры на вашем устройстве",
	"Caption + locale control": "Субтитры и языковые профили",
	"Human-edited copy only · no automatic translation.":
		"Текст редактирует автор · автоматического перевода нет.",
	"Start local transcription": "Запустить локальное распознавание",
	"Cancel transcription": "Отменить распознавание",
	"Simulate worker error": "Имитировать ошибку обработчика",
	"Retry transcription": "Повторить распознавание",
	MODEL: "МОДЕЛЬ",
	"· CHUNKED AUDIO": "· АУДИО ПО ЧАСТЯМ",
	CAPTION: "СУБТИТР",
	"TICKS ·": "ТИКОВ ·",
	WORDS: "СЛОВ",
	"Add RU + RTL locale profile": "Добавить языковой профиль RU + RTL",
	Locale: "Язык",
	"· pinned fallback": "· закреплённые запасные шрифты",
	"Text diagnostics": "Диагностика текста",
	"Safe area width 360 px. Each issue names a fix.":
		"Ширина безопасной области — 360 px. Каждая проблема содержит способ исправления.",
	"Fix:": "Исправление:",
	"Jump to exact caption": "Перейти к субтитру",
	"No text blockers.": "Блокирующих ошибок текста нет.",
	"M6 / production QA": "Версии и форматы",
	"Variant Matrix + Prism": "Выберите версии для экспорта",
	"Only explicit cells are persisted. Matrix readiness is local preflight, not reviewer approval.":
		"Нажмите на нужные ячейки таблицы, затем «Включить». Только включённые версии появятся в экспорте. Добавление формата само по себе не создаёт новую версию.",
	PROFILES: "ПРОФИЛИ",
	CELLS: "ЯЧЕЙКИ",
	DETACHED: "ОТДЕЛЁННЫЕ",
	"Add 16:9 + 1:1 profiles": "Добавить форматы 16:9 и 1:1",
	"Add review rows to 8": "Добавить наборы вариантов (до 8)",
	"Select first 24": "Выбрать первые 24",
	"Select first 50": "Выбрать первые 50",
	Enable: "Включить",
	selected: "выбрано",
	"Detach selected": "Отделить выбранные",
	"Undo Matrix Change": "Отменить изменение матрицы",
	"PRE-COMMIT ·": "ПЕРЕД СОХРАНЕНИЕМ ·",
	"cells ·": "ячеек ·",
	"bounded thumbnail jobs · no Cartesian materialization":
		"готовятся миниатюры выбранных версий",
	"CREATIVE / DELIVERY": "КРЕАТИВ / ФОРМАТ",
	"DOM GRIDCELLS": "ЯЧЕЕК НА ЭКРАНЕ",
	"/ 80 · PAGE": "/ 80 · СТРАНИЦА",
	"Production diagnostics": "Диагностика вариантов",
	"Action, exact cell/slot, and BrandKit source are always textual.":
		"Действие, точная ячейка/слот и источник BrandKit всегда указаны текстом.",
	"Import versioned BrandKit JSON": "Импортировать версионный BrandKit JSON",
	"KIT v": "НАБОР v",
	"Apply BrandKit text + safe-area fixes":
		"Применить исправления текста и безопасных областей BrandKit",
	SOURCE: "ИСТОЧНИК",
	"· REV": "· РЕДАКЦИЯ",
	"Focus exact cell": "Перейти к ячейке",
	"No blockers in the current projection page.":
		"На текущей странице вариантов блокирующих ошибок нет.",
	"FOCUS ·": "ФОКУС ·",
	"−1 frame": "−1 кадр",
	"+1 frame": "+1 кадр",
	"Split selected (S)": "Разделить выбранные (S)",
	"Trim start [": "Обрезать начало [",
	"Trim end ]": "Обрезать конец ]",
	"Snap (N)": "Привязка (N)",
	"Ripple (R)": "Сдвиг вслед (R)",
	Zoom: "Масштаб",
	s: "с",
	"selected ·": "выбрано ·",
	"logical clips mounted": "клипов отображено",
	"Master rough cut timeline": "Мастер-таймлиния чернового монтажа",
	"Shuttle reverse (J)": "Воспроизведение назад (J)",
	"Stop playback (K)": "Остановить воспроизведение (K)",
	"Shuttle forward (L)": "Воспроизведение вперёд (L)",
	"Playhead timecode": "Таймкод позиции",
	"Timeline zoom": "Масштаб таймлинии",
	"Timeline clips": "Клипы таймлинии",
	"Timeline tracks and clips. Use J K L for playback, Alt arrows to move, brackets to trim, S to split.":
		"Дорожки и клипы. J K L — воспроизведение, Alt со стрелками — перемещение, скобки — обрезка, S — разделение.",
	"Transcription progress": "Прогресс распознавания",
};

export function useUiCopy() {
	const { locale } = useVariantLabLocale();
	return (english: string) => {
		if (locale !== "ru") return english;
		if (UI_COPY[english]) return UI_COPY[english];
		const glyph = /^No pinned fallback font covers (U\+[0-9A-F]+)$/.exec(
			english,
		);
		if (glyph)
			return `Закреплённые запасные шрифты не содержат символ ${glyph[1]}`;
		const size =
			/^Text size (\d+)px is below the (\d+)px BrandKit minimum\.$/.exec(
				english,
			);
		if (size)
			return `Размер текста ${size[1]} px меньше минимума BrandKit ${size[2]} px.`;
		const constraint =
			/^Set DeliveryProfile layout constraint text_size_px:(\d+)\.$/.exec(
				english,
			);
		if (constraint)
			return `Задайте ограничение профиля формата text_size_px:${constraint[1]}.`;
		return english;
	};
}

// Translate only known application status formats; never alter user-authored names.
export function useStatusCopy() {
	const { locale } = useVariantLabLocale();
	return (message: string) => {
		if (locale !== "ru") return message;
		const exact: Record<string, string> = {
			"Local render queue is idle.": "Выберите версии и проверьте их перед экспортом.",
			"Recovered from the last checksum-valid snapshot.": "Кампания восстановлена из последней исправной копии.",
			"The campaign is still dirty. Retry keeps the same idempotent transaction.": "Изменения ещё не сохранены. Повторите сохранение — повторная попытка не создаст дубликат.",
			"Nothing changed in the recorded command scope.": "Нет изменений для отмены.",
			"Previewing one transaction; Escape restores canonical state.": "Предпросмотр изменения. Нажмите Escape, чтобы отменить его.",
			"Preflight is stale for the current revision, cells, scenes, preset, naming, or destination. Run preflight again.": "Настройки изменились. Повторите проверку перед экспортом.",
			"Recovered local jobs are queued; the browser was not reported as continuing while closed.": "Продолжаем экспорт. Пока вкладка была закрыта, он не выполнялся.",
		};
		if (exact[message]) return exact[message];
		if (/^Recovered revision \d+; replayed \d+ journal entries\.$/.test(message)) return "Кампания открыта. Сохранённые изменения восстановлены.";
		if (/^Revision \d+ received a durable journal receipt in [\d.]+ ms\.$/.test(message)) return "Изменения сохранены на этом устройстве.";
		if (/^Active scope: .*\. Selection and draft were revalidated\.$/.test(message)) return "Сцена открыта. Можно продолжать монтаж.";
		if (/^Preflight ready for \d+ frozen manifest\(s\):/.test(message)) return "Проверка пройдена. Нажмите «Создать видео на устройстве».";
		if (message.startsWith("Preflight blocked:")) return "Экспорт пока невозможен. Причины и способы исправления указаны ниже.";
		if (/^Queued \d+ local render job\(s\), concurrency 1\.$/.test(message)) return "Создаём выбранные видео по очереди. Не закрывайте вкладку.";
		if (/^Skipped \d+ already verified artifact\(s\)\.$/.test(message)) return "Эти видео уже готовы. Скачайте их из списка результатов.";
		if (message.endsWith(" succeeded and checksum verification passed.")) return "Видео готово и проверено. Нажмите «Скачать» рядом с результатом.";
		if (message.endsWith(" cancelled; no partial artifact committed.")) return "Экспорт отменён. Незавершённый файл не сохранён.";
		if (message.endsWith(" failed. Retry is available.")) return "Не удалось создать видео. Можно повторить попытку.";
		if (/^Editable bundle written as a stream \(\d+ bytes\)\.$/.test(message)) return "Редактируемый проект сохранён в файл.";
		return message;
	};
}
