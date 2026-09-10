# Варианты продуктовой трансформации

## Назначение документа

Этот документ сравнивает ровно три самостоятельных продукта, которые можно построить на upstream editor/media-ядре. Речь не о ребрендинге универсального видеоредактора: каждый вариант меняет основную сущность продукта, рабочий процесс, модель состояния и коммерческое обещание.

Фактические возможности и ограничения исходной системы зафиксированы в [BASELINE_AUDIT.md](./BASELINE_AUDIT.md). Выбранный вариант раскрывается в [TRANSFORMATION_SPEC.md](./TRANSFORMATION_SPEC.md), его техническая граница — в [ARCHITECTURE.md](./ARCHITECTURE.md), а вертикальная последовательность поставки — в [PLAN.md](../PLAN.md).

На этапе выбора действуют общие ограничения:

- сохранить MIT `LICENSE`, сведения об исходной open-source основе и допустимую атрибуцию VariantLab;
- не использовать название и логотип VariantLab как марку нового продукта;
- использовать существующие timeline, playback, media import, compositor и export как стартовую точку, но не выдавать статически найденные функции за production-ready;
- вынести платформонезависимые правила продукта в `rust/`, оставив React-приложение UI-оболочкой;
- продемонстрировать сложное React/frontend engineering через пользовательский сценарий, а не через внутреннюю инфраструктуру, которую нельзя увидеть в портфолио;
- включить timeline interactions, drag-and-drop, keyboard-first управление, устойчивое autosave/recovery, фоновые задания и измеримые performance budgets.

## Как читать оценки

Все оценки выставлены по шкале от 1 до 5. Для `сложности`, `времени` и `риска` большее число означает худшую стоимость: `5` — наиболее сложно, долго или рискованно. Для `wow-effect`, `технической глубины` и `ценности для frontend-работодателя` большее число означает лучший результат.

Оценка срока предполагает одного сильного senior/full-stack инженера, занятого full-time, с возможностью точечной помощи по дизайну, codec/legal и инфраструктуре. Это диапазон до убедительного portfolio-grade beta, а не до enterprise-зрелости во всех направлениях. Он включает исправление критических baseline-проблем, автоматизированные проверки и демонстрационный production-like deployment.

---

## Вариант 1 — VariantLab: Creative Operations Studio

### Покупатель и JTBD

Основные покупатели — performance-маркетинговые команды DTC/SaaS-компаний, in-house creative operations и агентства, которые регулярно выпускают десятки рекламных креативов из одной идеи.

Их задача формулируется так:

> Когда у меня есть один утверждённый master-креатив, я хочу безопасно получить согласованное семейство вариантов по форматам, хукам, локалям, CTA и медиаслотам, чтобы запустить кампанию быстрее и не потерять бренд-консистентность.

Главная продуктовая сущность здесь — не отдельный видеопроект, а **семейство производных креативов**: master timeline, конечный набор измерений вариативности, наследуемые изменения, разрешённые overrides, диагностика и пакет deliverables.

### Сквозной рабочий процесс

1. Креативный продюсер создаёт campaign family и импортирует исходные видео, изображения, аудио и шрифты.
2. Он собирает master timeline, отмечает сцены и объявляет управляемые слоты: `hook`, `product shot`, `headline`, `CTA`.
3. В brand kit задаются безопасные зоны, минимальные размеры текста, допустимые цвета, логотип и требования к длительности.
4. Продюсер создаёт CreativeSet rows для hooks/media/text и явно составляет DeliveryProfile columns из format + locale rules.
5. Он включает только нужные VariantCell; engine заранее показывает количество/cost и не материализует полный Cartesian product.
6. В **синхронизированной preview wall** оператор воспроизводит несколько форматов в lockstep, видит inherited/overridden элементы и исправляет только разрешённые отклонения.
7. Диагностика до рендера показывает выход за safe zone, переполнение текста, отсутствующий asset, конфликт длительности и несовместимый codec preset.
8. Оператор запускает batch export, наблюдает прогресс, отменяет или повторяет отдельные задания и после сбоя продолжает очередь без повторного рендера готовых файлов.
9. На выходе формируется campaign pack: файлы, понятные имена, manifest параметров и отчёт проверок.

### Чем это отличается от VariantLab

Upstream editor организован вокруг ручного монтажа отдельной scene/timeline. VariantLab организован вокруг **master-to-many dependency graph**. Пользователь редактирует правило и семейство, а не вручную дублирует проект двенадцать раз.

Ключевые отличия:

- матрица вариантов вместо списка независимых проектов;
- наследование master-правок и точечные ограниченные overrides;
- synchronized multi-format playback вместо одного preview canvas;
- production diagnostics и campaign manifest как часть основного сценария;
- batch job orchestration с восстановлением, а не одиночное скачивание результата;
- brand-safe creative operations, а не универсальный consumer editor.

### Что переиспользуется из editor/media-ядра

- track/clip timeline, trim, split, snapping, selection и command transactions;
- canvas composition, text/media elements, transforms, effects и masks;
- playback clock, waveform, thumbnail и media metadata pipeline;
- OPFS/IndexedDB local-first foundation;
- Rust/WASM compositor и browser export как один из исполнителей job contract;
- keyboard shortcut registry, clipboard и drag-and-drop primitives.

Переиспользование не означает заморозку текущей реализации. History необходимо сделать project/scene/variant-scoped, preview и export — изолировать по render surface, autosave — превратить в подтверждаемый journal/checkpoint protocol, а кеши и timeline — ограничить бюджетами и виртуализировать.

### Сложное frontend engineering

| Область | Что именно демонстрирует VariantLab |
| --- | --- |
| Состояние | Нормализованный граф `MasterSequence → CreativeSet → DeliveryProfile → VariantCell`; typed patches; dependency invalidation; scoped undo/redo; атомарная multi-cell команда |
| Timeline | Master timeline и resolved variant view; linked selections; безопасное переключение scope; синхронные playheads; frame-accurate crop/reflow для разных aspect ratios |
| Drag-and-drop | Назначение asset в объявленный slot; bulk assignment выбранным rows/cells; валидируемый drop с preview, keyboard alternative и rollback |
| Keyboard | Полная навигация по matrix/grid; focus model без ловушек; trim/nudge/seek; переход к следующей ошибке; command palette; конфликт-детектор shortcuts |
| Autosave | Append-only local journal, checkpoint, save state `pending/saving/saved/error`, retry/backoff, crash replay, last-known-good revision и явный индикатор пользователю |
| Background jobs | Единая машина состояний `queued/preparing/running/pausing/paused/cancelling/succeeded/failed/cancelled`; idempotency, progress, retry и resume для thumbnails, proxies, diagnostics и render |
| Performance | Виртуализированная матрица и timeline; только активный вариант в полном качестве; worker-based resolution; LRU/cache budgets; backpressure; rAF-канал для playback без React render на каждый кадр |
| Accessibility | Семантическая grid-навигация, именованные controls, видимый focus, keyboard parity для pointer-операций, live regions для job/save status, reduced motion |

### Визуальный wow-effect

Центральный portfolio-момент — **Variant Prism**: стена из `16:9`, `1:1` и `9:16` превью, которые идут синхронно, а изменение master headline или product shot распространяется на семейство на глазах пользователя. Тонкие registration marks, safe-zone guides и цветовые сигналы inherited/override превращаются в функциональный визуальный язык production-системы, а не в декор.

Вторая сильная сцена — animated render queue рядом с variant matrix: двенадцать deliverables переходят через validate/render/package, не блокируя редактор, а сбой одного задания не уничтожает прогресс остальных.

### Недостающая инфраструктура

- Rust domain model для MasterSequence, CreativeSet, DeliveryProfile, VariantCell, slots, patches, resolution и diagnostics;
- совместимый Rust API для web/worker/native execution и contract/version tests;
- изолированные preview/export render surfaces и управление ресурсами compositor;
- надёжный local journal, миграции и crash recovery;
- proxy generation и memory-bounded media caches;
- durable job store; сначала local worker executor, затем Postgres/Redis-backed remote executor;
- object storage, chunked/resumable upload и signed access для cloud-рендера;
- workspace/auth/tenant model и RLS перед team workflow;
- provenance manifest для assets, fonts, models, music и codec policy;
- реальные E2E/browser, accessibility, recovery и performance tests.

### Монетизация

- Free/local: один active campaign, ограниченное число вариантов, browser render.
- Pro: оплата за seat и расширенные brand kits/templates.
- Team: workspace, approval/review, shared assets и history.
- Usage: render minutes, storage и high-resolution/server presets.

Ценность измеряется не количеством эффектов, а временем от одного утверждённого master до готового ad pack и снижением числа ручных ошибок.

### Срок и предположения

**26–32 недели** для одного senior до local portfolio-grade beta с BrandKit QA, editable bundle и resumable local render package.

Диапазон реалистичен при следующих условиях:

- первая версия работает с одним master и фиксированной hierarchy с жёсткими лимитами;
- local-first editor и local jobs поставляются раньше cloud execution;
- совместная работа в реальном времени не входит в beta;
- поддерживается небольшой, заранее проверенный набор output presets;
- AI generation и свободный scripting не входят в критический путь.

Connected cloud batch, cross-device continuity и review в этот диапазон не входят. Для них PLAN.md оценивает отдельный team scope примерно в 8–10 календарных месяцев от начала проекта.

### Главные риски

| Риск | Последствие | Ограничение/ответ |
| --- | --- | --- |
| Произвольное наследование превращается в spreadsheet/programming language | Непредсказуемое состояние и бесконечный UI | Фиксированная hierarchy, typed slots, allowlisted patches; один master; без custom axes, циклов и формул |
| Одновременный preview множества вариантов перегружает GPU/память | Jank, crash, перегрев | Один full-quality surface, остальные adaptive previews; LRU budgets; visibility scheduling |
| Batch export выглядит готовым раньше, чем надёжен | Потерянные или дублированные outputs | Durable state machine, idempotency key, persisted progress, fault-injection tests |
| Cloud/team scope поглощает редактор | Портфолио превращается в инфраструктурный проект | Local-first vertical slices; cloud только после полной локальной campaign flow |
| Brand diagnostics обещают абсолютную корректность | Ложное чувство compliance | Формулировать как проверяемые правила kit, показывать источник и severity каждого правила |

---

## Вариант 2 — ReplayForge: Esports Clips Command Center

### Покупатель и JTBD

Покупатели — esports-команды, турнирные операторы, игровые медиа и агентства, которые превращают многочасовые VOD/POV-записи в быстрые клипы во время или сразу после матча.

JTBD:

> Когда заканчивается карта или важный момент, я хочу найти его среди нескольких длинных источников, собрать историю и выпустить набор platform-ready клипов за минуты, не просматривая весь материал и не пересобирая каждый формат вручную.

Главная сущность — **событие матча**, связанное с несколькими синхронизированными источниками, event rail, highlight bin и производным story reel.

### Сквозной рабочий процесс

1. Оператор создаёт match session и импортирует broadcast VOD, POV игроков, observer feed и отдельные audio tracks.
2. Источники синхронизируются по timecode, clap/marker или ручной опорной точке; система генерирует proxies и waveforms в фоне.
3. Во время просмотра оператор использует J/K/L, числовые оценки и собственные hotkeys, чтобы ставить event markers и отправлять диапазоны в highlights bin.
4. При наличии официального event feed kills/rounds/objectives появляются на отдельном виртуализированном event rail; без него рабочий процесс остаётся полностью ручным.
5. Из отмеченных событий drag-and-drop собирается story reel: setup, play, reaction, score card и CTA.
6. Оператор переключает POV, корректирует in/out, добавляет scoreboard/roster overlay, captions и branded bumper.
7. Система строит вертикальные и квадратные social derivatives с subject-safe crop; оператор проверяет их в synchronized preview.
8. Batch queue выпускает пакет для Shorts/Reels/X и сохраняет failed jobs для повторного запуска.

### Чем это отличается от VariantLab

- многочасовая multi-source session вместо одиночного проекта;
- event rail и highlight bin как первичные инструменты навигации;
- source switching и match-time semantics вместо только clip-time монтажа;
- story assembly из игровых событий;
- roster/scoreboard/template data bindings;
- low-latency publishing workflow для редактора на турнире.

Это станет самостоятельным продуктом только при наличии настоящей event/timecode модели. Набор неоновых overlays поверх обычного редактора останется skin и не оправдает трансформацию.

### Что переиспользуется из editor/media-ядра

- transport, frame seek, J/K/L shortcuts, markers/bookmarks и timeline commands;
- multi-track media, split/trim/ripple, waveform и source audio;
- text/graphic/effect elements для overlays;
- compositor, masks и export presets;
- selection, clipboard, DnD и autosave foundation.

### Сложное frontend engineering

| Область | Что именно демонстрирует ReplayForge |
| --- | --- |
| Состояние | Match clock, source sync offsets, event entities, highlight ranges, story references и overlay bindings; undo/redo не разрушает исходные markers |
| Timeline | Виртуализация многочасового материала; two-scale navigation; source switching; event rail; linked multi-source cuts; proxy/full-res transitions |
| Drag-and-drop | Event/marker в highlights bin, highlight в story reel, player/team data в overlay slot, контролируемая замена angle |
| Keyboard | Logging без мыши, shuttle J/K/L, mark in/out, rating, source switching, быстрые bins и command palette |
| Autosave | Журнал событий и cuts с мгновенной фиксацией; восстановление live logging session после crash |
| Background jobs | Proxy, waveform, transcription, scene/event analysis, upload и social batch export с приоритетами |
| Performance | Windowed decode, partial waveform, coarse/fine timeline levels, virtualized thousands of events, bounded prefetch и worker parsing |

### Визуальный wow-effect

Сильнейшая демонстрация — четыре синхронизированных POV вокруг match timeline: оператор нажимает hotkey на decisive play, событие вспыхивает на event rail, правильный angle попадает в highlight bin, а вертикальный social cut сразу появляется рядом. Визуальный язык может опираться на broadcast control room, но не должен превращаться в декоративный «киберспорт-неон».

### Недостающая инфраструктура

- надёжный multi-source sync и общий match-time domain;
- streaming/proxy ingest для очень больших VOD;
- chunked/resumable storage и remote media indexing;
- адаптеры к event feeds разных игр и versioned parsers;
- roster/scoreboard data model и безопасный template binding;
- server-side render и быстрая публикация;
- права на footage, player likeness, music и tournament metadata;
- нагрузочные тесты на десятки часов media и тысячи markers.

### Монетизация

- seat/workstation для team editors;
- season/team workspace;
- ingest/storage/render usage;
- premium connectors к tournament/event feeds;
- branded template packs и publishing integrations.

### Срок и предположения

**24–32 недели** до portfolio-grade beta.

Предполагается одна дисциплина или нейтральный ручной event schema, максимум четыре синхронизированных источника и отсутствие обязательной live broadcast-интеграции в первой версии. Автоматическое распознавание игровых событий не входит в критический путь.

### Главные риски

| Риск | Последствие | Ограничение/ответ |
| --- | --- | --- |
| Продукт зависит от закрытых или нестабильных game APIs | Demo ломается вне подготовленного матча | Manual-first event logging; один опциональный reference connector |
| Многочасовые VOD превышают возможности browser-only pipeline | Память, задержки и огромные uploads | Обязательные proxies, chunking, range access и bounded decode |
| Multi-source sync оказывается недостаточно точным | Монтаж выглядит непрофессионально | Явные sync anchors, drift correction и измеримые sync tests |
| Лицензионные права на footage/музыку/данные неоднозначны | Нельзя коммерчески распространять demo pack | Собственные/разрешённые fixtures и provenance manifest |
| Слишком много domain-specific backend работы | Слабее видна React-инженерия | Сначала keyboard logging + event rail + story reel; connectors после UX proof |

---

## Вариант 3 — DemoMotion: Cinematic Product Demo Studio

### Покупатель и JTBD

Покупатели — product marketing, DevRel, indie founders и SaaS-команды, регулярно создающие launch videos, feature walkthroughs и обучающие ролики.

JTBD:

> Когда я записал реальный продукт, я хочу быстро превратить сырой screen capture в кинематографичный, брендированный demo для нескольких каналов, не анимируя вручную каждый zoom, cursor move и callout.

Главная сущность — **resolution-independent product walkthrough**: screen surface, camera path, cursor narrative, focus targets, callouts, voice/webcam layers и output reframing.

### Сквозной рабочий процесс

1. Пользователь записывает экран, системный звук, микрофон и опционально webcam либо импортирует готовую запись.
2. Recording session хранит screen geometry, cursor samples, clicks и focus markers отдельно от encoded video, если платформа позволяет это получить.
3. Пользователь удаляет паузы, чистит narration и отмечает смысловые шаги продукта.
4. Camera track предлагает zoom/pan вокруг click/focus, но остаётся полностью редактируемым на keyframe timeline.
5. Callout привязывается к screen coordinate/target, переживает crop и смену output aspect ratio.
6. Drag-and-drop theme/brand kit меняет background, typography, cursor treatment и captions без разрушения монтажа.
7. В synchronized preview пользователь проверяет landscape launch video и vertical teaser.
8. Background queue рендерит master, teaser, GIF/thumbnail и captions package.

### Чем это отличается от VariantLab

- запись и её семантическая геометрия — первичный источник, а не просто video clip;
- camera/cursor/callout tracks — основные инструменты, а не декоративные эффекты;
- resolution-independent layout и target anchoring;
- удаление пауз и narration workflow;
- theme-driven output family для product launch;
- специализированный recording-to-demo путь вместо универсального монтажа.

### Что переиспользуется из editor/media-ядра

- video/audio/text tracks, trim/split, waveform и playback;
- transform/keyframe/Bezier primitives для camera path;
- canvas compositor, masks, effects и export;
- transcription worker для captions;
- local media storage, commands, history и shortcuts.

### Сложное frontend engineering

| Область | Что именно демонстрирует DemoMotion |
| --- | --- |
| Состояние | Связь screen coordinates, cursor samples, camera keyframes, semantic steps и derived outputs; theme tokens без destructively baked styling |
| Timeline | Специализированные camera/cursor/callout lanes, Bezier editing, pause compaction и linked audio/video edits |
| Drag-and-drop | Callout на target, rearrange semantic step, theme/asset в slot, webcam layout presets |
| Keyboard | Recording review, mark/delete pause, step navigation, nudge camera/callout, narration-oriented shortcuts |
| Autosave | Recovery записи и metadata до завершения encode; journal camera edits; last-known-good project |
| Background jobs | Capture finalization, silence analysis, transcription, proxy, GIF/thumbnail и multi-format export |
| Performance | Decimation cursor samples, virtualized long recordings, adaptive preview, worker analysis и bounded frame cache |

### Визуальный wow-effect

Портфолио-сцена: сырой screen recording одним действием превращается в плавную camera choreography — курсор замедляется, viewport мягко приближает активную область, callout остаётся привязанным к кнопке, а справа в реальном времени виден вертикальный reframe. Важно сделать автоматизацию объяснимой: пользователь видит и редактирует каждый предложенный camera keyframe.

### Недостающая инфраструктура

- browser/desktop capture layer и разрешения для screen, mic, system audio и webcam;
- потоковая запись с crash-safe chunk persistence;
- cursor/click/focus metadata capture; часть возможностей потребует desktop companion;
- silence analysis, audio cleanup и многопоточная media synchronization;
- target anchoring и resolution-independent layout engine;
- secure handling для записей, которые могут содержать секреты и PII;
- remote render/storage для тяжёлых deliverables.

### Монетизация

- Pro seat для creators/DevRel;
- team brand kits и reusable demo themes;
- storage/render usage;
- desktop recorder как paid capability;
- shared review и approved template library.

### Срок и предположения

**14–18 недель** до portfolio-grade beta.

Диапазон предполагает browser capture либо импорт готовой записи, один screen source, необязательный webcam, ограниченный набор camera/callout rules и отсутствие полноценного cross-platform desktop recorder в первой beta.

### Главные риски

| Риск | Последствие | Ограничение/ответ |
| --- | --- | --- |
| Рынок уже знает несколько сильных screen-demo продуктов | Продукт выглядит как клон | Дифференцировать editable camera semantics и multi-output target anchoring, не только авто-zoom |
| Полноценный capture уводит проект в native/platform engineering | React-часть откладывается | Beta с browser capture/import; desktop companion — отдельный последующий slice |
| Автоматические zoom/callout раздражают пользователя | Demo выглядит искусственно | Suggestions, а не irreversible edits; понятные keyframes и one-command revert |
| Запись содержит секреты, уведомления или персональные данные | Высокий security/privacy риск | Local-first default, explicit upload, redaction workflow и короткие retention policies |
| Связка cursor metadata с encoded video дрейфует | Callout и камера промахиваются | Единый monotonic clock, sync markers и drift fixtures |

---

## Сравнительная оценка

| Вариант | Сложность ↓ | Время ↓ | Wow-effect ↑ | Техническая глубина ↑ | Риск ↓ | Ценность для frontend-работодателя ↑ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| VariantLab | 5 | 4 | 5 | 5 | 4 | 5 |
| ReplayForge | 5 | 5 | 5 | 5 | 5 | 5 |
| DemoMotion | 4 | 3 | 5 | 4 | 3 | 4 |

Стрелка показывает желаемое направление. Высокая сложность VariantLab — осознанная цена за derived state, inheritance и multi-variant rendering. ReplayForge получает максимальные время и риск из-за long-form ingest, multi-source sync и зависимости от event data. DemoMotion быстрее, но часть технической глубины и дифференциации уходит в capture/OS integration, а не в видимый web frontend.

### Взвешенное решение

Для portfolio-продукта веса отдают приоритет видимой frontend-инженерии и технической глубине:

| Критерий | Вес | Преобразование |
| --- | ---: | --- |
| Сложность | 5% | `6 − оценка`, потому что меньше лучше |
| Время | 10% | `6 − оценка`, потому что меньше лучше |
| Wow-effect | 20% | исходная оценка |
| Техническая глубина | 25% | исходная оценка |
| Риск | 10% | `6 − оценка`, потому что меньше лучше |
| Ценность для frontend-работодателя | 30% | исходная оценка |

Итог — сумма преобразованных оценок, умноженных на веса; максимум `5.00`.

| Место | Вариант | Взвешенный результат |
| ---: | --- | ---: |
| 1 | **VariantLab** | **4.20 / 5.00** |
| 2 | ReplayForge | 4.00 / 5.00 |
| 3 | DemoMotion | 3.90 / 5.00 |

Числа не подменяют продуктовый выбор. Они делают явным, почему более короткий DemoMotion не выигрывает автоматически и почему впечатляющий ReplayForge уступает из-за внешних зависимостей.

## Выбор: VariantLab

VariantLab — лучший вариант для этой трансформации по пяти причинам:

1. Он меняет фундаментальную модель продукта: `одна timeline` становится `master + детерминированное семейство вариантов`.
2. Его самая трудная часть одновременно является самой видимой: variant matrix, synchronized previews, inheritance, diagnostics и job queue демонстрируются в одном end-to-end сценарии.
3. Он максимально использует сильные стороны текущего editor/media-ядра, но создаёт оправданный путь миграции бизнес-логики в Rust.
4. Portfolio-grade версия возможна local-first и не зависит от игрового API, ML-модели или полноценного native recorder.
5. У него ясный B2B use case и измеримая ценность: меньше ручных дубликатов, быстрее campaign pack, меньше ошибок формата и бренда.

### Жёсткие ограничения первой версии

Эти границы являются частью продуктового решения, а не списком пожеланий:

- один MasterSequence на campaign family;
- максимум 12 CreativeSet rows, 24 явно составленных DeliveryProfile columns и 100 включённых VariantCell;
- CreativeSet меняет typed hook/product/headline/CTA/logo slots, DeliveryProfile — format/locale layout rules;
- master-изменения наследуются всегда; cell exception разрешён только для crop/transform/text-fit именованного slot, максимум в 20 cells;
- replacement не меняет timing, а DeliveryProfile — timing, FPS или audio mix;
- никакого произвольного scripting, формул, циклических зависимостей и вложенных masters;
- matrix не материализует Cartesian product и хранит typed patches, а не полные копии scene graph;
- один активный full-quality preview; остальные preview адаптивные и планируются по видимости;
- local-first campaign flow и local job executor раньше cloud render;
- совместное редактирование в реальном времени, generative AI, полноценный DAM и marketplace templates не входят в beta;
- server codecs выбираются только после отдельного license/patent решения;
- ни один batch job не считается завершённым до persisted result manifest.

Если эти ограничения нельзя сохранить, нужно уменьшать число rows/profiles/cells, а не расширять архитектуру до универсального rules engine.

### Название и товарные знаки

`VariantLab` — рабочее кодовое имя для спецификации и портфолио. До публичного запуска необходимы отдельная проверка товарного знака, домена и конфликтующих продуктов. Новый продукт не должен называться VariantLab, использовать его логотип или создавать впечатление официального продолжения. Допустимая формулировка происхождения и полный набор сторонних notices должны быть зафиксированы до релиза; корневой `LICENSE` и сведения об исходной open-source основе сохраняются.

Этот выбор фиксирует направление, но не разрешает реализацию. Scope, acceptance criteria и non-goals находятся в [TRANSFORMATION_SPEC.md](./TRANSFORMATION_SPEC.md); изменения модулей и границ — в [ARCHITECTURE.md](./ARCHITECTURE.md); последовательность только вертикальными пользовательскими сценариями — в [PLAN.md](../PLAN.md).
