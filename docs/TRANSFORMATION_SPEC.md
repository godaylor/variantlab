# VariantLab — спецификация продуктовой трансформации

> Статус: принятое направление, реализация не начата  
> Дата: 2026-08-27  
> Рабочее имя: **VariantLab** (codename до проверки товарного знака)  
> Основа: OpenCut Classic, MIT; исходные уведомления и атрибуция сохраняются

## 1. Решение

OpenCut Classic преобразуется не в ещё один универсальный видеоредактор, а в **Creative Operations Studio** для performance-маркетинговых команд, DTC-брендов и агентств.

VariantLab позволяет собрать один master-креатив, определить контролируемые переменные — формат, hook, locale, media slot, CTA — и получить согласованное семейство рекламных вариантов. Пользователь видит наследование, точечные overrides, ошибки safe zone и прогресс пакетного экспорта в одном рабочем пространстве.

Почему выбрано это направление, а не esports- или screen-demo-продукт, зафиксировано в [PRODUCT_OPTIONS.md](./PRODUCT_OPTIONS.md). Текущее техническое состояние основы — в [BASELINE_AUDIT.md](./BASELINE_AUDIT.md), целевая система — в [ARCHITECTURE.md](./ARCHITECTURE.md), порядок поставки — в [../PLAN.md](../PLAN.md).

## 2. Проблема и коммерческий use case

Сегодня команда часто копирует один ролик в десятки файлов и вручную повторяет правки для разных рекламных площадок, языков и офферов. Это создаёт четыре дорогостоящие проблемы:

1. изменения master-креатива расходятся между копиями;
2. вертикальный crop, локализованный текст и safe zones проверяются вручную;
3. невозможно быстро понять, какой вариант устарел или содержит override;
4. пакетный экспорт непрозрачен: одна ошибка заставляет перезапускать всю серию.

VariantLab продаёт не монтаж как таковой, а **контролируемое производство вариаций**: меньше повторной работы, меньше ошибок размещения и предсказуемая выдача campaign pack.

### Основные роли

- **Creative operator** создаёт master, объявляет slots, CreativeSets и DeliveryProfiles, корректирует crop и запускает экспорт.
- **Performance marketer** задаёт hooks, CTA, locales и проверяет готовую матрицу.
- **Reviewer / brand owner** просматривает варианты, диагностику и статус deliverables без риска случайно изменить master.
- **Workspace admin** управляет brand kits, лимитами, участниками и политикой хранения в подключённой версии продукта.

### Jobs to be done

- «Из одного утверждённого ролика выпустить набор 16:9, 1:1 и 9:16 без расхождения контента».
- «Заменить hook, CTA и locale сразу во всей матрице и понять, какие варианты требуют внимания».
- «До рендера найти текст за safe zone, отсутствующий asset и неподдерживаемый codec».
- «Поставить до 8 local или 50 connected deliverables в очередь, безопасно продолжить после reload и повторить только неудачные задачи».

## 3. Чем продукт отличается от OpenCut

OpenCut остаётся технической основой и явно указывается в attribution, но VariantLab меняет саму модель работы:

| OpenCut Classic | VariantLab |
|---|---|
| один независимый project/scene timeline | master revision и производное семейство variants |
| ручное дублирование результатов | CreativeSet rows, DeliveryProfile columns, slots и allowlisted overrides |
| один preview | синхронизированная preview wall для разных форматов |
| один browser export | durable batch job с частичным retry и deliverable manifest |
| общая монтажная проверка | brand/safe-zone/text-fit/asset diagnostics |
| локальный редактор общего назначения | специализированный creative-operations workflow и workspace-модель |

Новый бренд не использует имя или логотип OpenCut как собственный знак и не подразумевает endorsement.

## 4. Продуктовые принципы

1. **Master-first.** Общая правка делается один раз и наследуется, пока пользователь явно не создаст разрешённый override.
2. **Производное состояние детерминировано.** Variant не хранит скрытую копию timeline; он разрешается из master revision, выбранных options и небольшого patch set.
3. **Ограничения видимы.** Наследование, override, stale state, safe zone и export readiness никогда не кодируются только цветом или неявным поведением.
4. **Local-first, connected when needed.** Первый полезный workflow работает без аккаунта и сети; cloud добавляет handoff, durable jobs и совместное использование, а не отбирает владение локальными данными.
5. **Keyboard and pointer parity.** Любая операция DnD имеет клавиатурный путь; timeline и matrix не требуют точного pointer-жеста.
6. **Performance is a feature.** Видимая интерактивность имеет бюджеты, а деградация качества preview контролируема и объяснима.
7. **Rust is the logic boundary.** Бизнес-правила, resolver, команды, history, job contracts и media planning не дублируются в React.

## 5. Golden path

1. Пользователь создаёт campaign и импортирует master video, audio, images и brand kit.
2. Собирает и проверяет master timeline привычными trim, split, text, keyframe, mask и shortcut-операциями.
3. Помечает элементы как именованные slots: `hook_video`, `headline`, `cta`, `product_shot`.
4. Добавляет два CreativeSet (`Hook A / B`) и шесть явно созданных DeliveryProfile (`16:9 / 1:1 / 9:16 × EN / DE`).
5. Явно включает 12 VariantCell; VariantLab заранее показывает объём работы и не материализует остальной Cartesian product.
6. Пользователь открывает Preview Wall: видимые форматы проигрываются от одного transport clock.
7. Диагностика находит переполнение текста, выход CTA за safe zone и отсутствующий немецкий asset.
8. Пользователь с клавиатуры переходит к проблемным ячейкам, исправляет slot value или допустимый crop override.
9. Готовые deliverables отправляются в очередь. Каждый имеет progress, cancel, retry и понятный error reason.
10. После перезапуска приложение восстанавливает master, variants, историю незавершённой работы и состояние очереди; успешно созданные файлы не рендерятся повторно.

## 6. Доменная модель

### 6.1 Термины

- **Campaign** — рабочий контейнер с одним master, brand kit, profiles, cells и deliverables.
- **BrandKit** — versioned декларативный набор logo/font/color tokens, minimum text size, custom safe regions и duration rules с provenance; это не исполняемый template.
- **MasterSequence / Master revision** — единственная каноническая последовательность и её неизменяемая версия.
- **Scene** — упорядоченный монтажный сегмент внутри MasterSequence; это не независимый master и не родитель variants. Inclusion/order принадлежат MasterSequence и одинаковы для всех cells данной revision; DeliveryProfile/Cell не могут менять sequence duration. Active scene в UI не влияет на deliverable.
- **CreativeSet** — строка матрицы с типизированными заменами slot values, например Hook A или Hook B.
- **FormatProfile / LocaleProfile** — переиспользуемые настройки формата и locale.
- **DeliveryProfile** — явно созданная колонка матрицы, объединяющая format и locale rules.
- **Slot** — именованная точка подстановки media/text/configuration в master.
- **VariantCell** — стабильная пара `(creative_set_id, delivery_profile_id)`; не копия timeline.
- **Cell exception** — малый типизированный crop/transform/text-fit override для именованного slot.
- **Resolved variant** — детерминированный read-only результат `MasterSequence + CreativeSet + DeliveryProfile + CellException`.
- **Diagnostic** — адресуемая проблема с severity, source и предлагаемым действием.
- **Deliverable** — VariantCell плюс export preset, naming rule и destination.
- **Render job** — идемпотентная попытка получить deliverable из зафиксированной revision.

### 6.2 Ограничения первой версии

- Ровно один MasterSequence на Campaign; он содержит одну или несколько упорядоченных Scene.
- До 12 CreativeSet, включая default/master row.
- До 6 FormatProfile и 12 LocaleProfile; пользователь явно составляет из них не более 24 DeliveryProfile.
- До 100 включённых VariantCell. Полный Cartesian product автоматически не создаётся.
- До 20 cells могут иметь layout exception и помечаются как detached.
- Local batch v1 содержит до 8 cells, connected batch — до 50.
- CreativeSet меняет только media/text slots: hook, product shot, headline, CTA и logo.
- DeliveryProfile меняет canvas, safe areas, locale, caption preset, font fallback и layout constraints, но не timing, fps и audio mix.

Разрешённые cell exceptions:

- crop и transform именованного visual slot;
- text-fit mode именованного text slot.

Media/text replacements принадлежат CreativeSet, а locale/layout tokens — DeliveryProfile. Они не маскируются под свободный cell override.

В первой версии запрещены:

- произвольные insert/delete/split/ripple операции только в одной cell;
- изменение длительности replacement asset вне объявленного slot duration policy;
- nested variants, multiple parents, custom axes и наследование cell от cell;
- произвольный код и пользовательские expressions в template;
- неявное превращение override в master change.

Это продуктовый контракт, а не временное UI-ограничение. Расширение allowlist требует ADR, миграции формата и теста детерминизма.

### 6.3 Семантика наследования

- Master edit создаёт новую revision и инвалидирует только затронутые resolved nodes/cache entries.
- Cell без exception немедленно наследует изменение.
- Master slot с живыми replacements/exceptions нельзя удалить, пока пользователь явно не выполнит `Remap` или `Drop references`; silent orphaning запрещён.
- Cell exception всегда показывает источник и предоставляет `Reset` и `Promote to master`, если promotion семантически допустим.
- Undo/redo выполняется в зафиксированном `campaignId + historyScope(MasterSequence | CreativeSet | DeliveryProfile | VariantCell) + sceneId` и никогда не применяется к активному объекту «по совпадению».

## 7. Объём production-like beta

### 7.1 Master editor

Сохраняются сильные части ядра: media import, tracks/clips, trim/split, snapping, selection, text, keyframes, masks, waveform, J/K/L, undo/redo и preview. Перед надстройкой обязательны scope-safe history, recoverable save и восстановление renderer после ошибки.

### 7.2 Variant Builder

- создание и переименование CreativeSets, Format/Locale profiles и явно составленных DeliveryProfiles;
- объявление text/media slots из выбранного элемента;
- matrix cardinality/cost preview до явного включения cells;
- предупреждение о combinatorial explosion и жёсткие versioned limits из domain model;
- стабильные cell IDs и детерминированные имена;
- inheritance/override/stale/error status в каждой ячейке.

### 7.3 Preview Wall — signature experience

- 16:9, 1:1 и 9:16 preview tiles запускаются одним transport;
- одна активная tile рендерится в полной preview quality, остальные видимые — в адаптивном качестве;
- регистрационные линии связывают один slot между форматами;
- hover/focus показывает source: master, option или override;
- double-click/Enter переводит выбранную tile в focused editor;
- виртуализация исключает рендер невидимых ячеек;
- сравнение не зависит только от цвета и работает при reduced motion.

### 7.4 Slots и overrides

- DnD asset на slot или matrix selection;
- клавиатурная команда `Assign to slot…` как полный эквивалент DnD;
- bulk apply к выбранной строке/колонке/набору variants;
- atomic transaction: либо меняются все выбранные variants, либо ни один;
- понятный diff master ↔ resolved variant;
- reset/promotion с preview последствий до commit.

### 7.5 Brand и preflight diagnostics

- platform safe zones и пользовательские brand-safe regions;
- text overflow, minimum readable size и missing glyphs;
- missing/unavailable asset, unsupported codec и invalid duration policy;
- resolution/bitrate/aspect export warnings;
- diagnostics rail, фильтры severity и переход к точному slot/variant;
- запрет batch export только для ошибок, реально делающих результат некорректным; warnings можно подтвердить.

### 7.6 Deliverables и Job Center

- naming templates без произвольного исполняемого кода;
- выбор export preset/destination;
- enqueue как атомарный snapshot revision + render plan;
- canonical статусы `queued / preparing / running / pausing / paused / cancelling / succeeded / failed / cancelled`;
- progress phase и оценка, а не фиктивный общий процент;
- cancel, retry failed only и resume после reload;
- deduplication по idempotency key;
- manifest с variant/options/revision/preset/checksum/attribution metadata.

### 7.7 Save, recovery и handoff

- постоянный статус `Saving… / Saved / Offline / Retry / Recovery available`;
- append-only local journal и периодические checkpoints;
- failed write не очищает dirty state;
- восстановление последней подтверждённой версии и replay валидного журнала;
- explicit local export/import campaign bundle;
- подключённый workspace, cloud revision и review/approval входят в позднюю beta, но локальный workflow от них не зависит.

## 8. Interaction contract

### Timeline

- Pointer gestures сохраняют transient preview state и создают одну command transaction при commit.
- Shift временно отключает snapping; Escape отменяет незавершённую операцию без history entry.
- Clip, track, trim handle, keyframe и playhead доступны из tab/roving-tabindex модели.
- Не допускаются вложенные интерактивные элементы и `div`-кнопки.
- Большие timelines виртуализируются без потери selection, drag target и accessibility semantics.

### Variant Matrix

- Arrow keys перемещают focus по ячейкам; Home/End и Ctrl/Cmd+Arrow работают по строке/колонке.
- Space включает selection, Enter открывает focused variant, Escape возвращает к предыдущему уровню.
- Bulk actions сообщают количество затрагиваемых variants до commit.
- Каждое действие доступно через command palette и имеет отображаемый/remappable shortcut.
- Character shortcuts не срабатывают в input, textarea, contentEditable и screen-reader interaction mode.

### Undo/redo

- History scoped по campaign/master или конкретному variant override context.
- View-only действия, selection и playback не засоряют history.
- No-op command не создаёт entry и не запускает autosave.
- Compound operation имеет одно пользовательское имя: «Apply hook B to 6 variants».
- History ограничена memory budget, использует coalescing и checkpoint boundary; старые entries безопасно сворачиваются.

## 9. Визуальная система

Направление — **creative production control board**, а не типовой тёмный SaaS и не копия broadcast console.

- Signature element: **Variant Prism** — Preview Wall с синхронными регистрационными направляющими между одним и тем же slot в разных форматах.
- Aesthetic risk: crop marks, registration rails и proofing annotations становятся функциональным языком интерфейса, а не декором.
- Базовая палитра: Carbon `#101419`, Slate `#1B2430`, Mist `#E8EEF2`, Signal Cobalt `#5B6CFF`, Registration Magenta `#D95C9E`, Approval Amber `#F0B44D`. Контраст каждой пары проверяется до реализации.
- Типографическая гипотеза: Archivo для плотных variant labels, Instrument Sans для UI, IBM Plex Mono для timecode/job telemetry. До включения проверяются лицензии и bundle impact.
- Поверхности спокойные; акцентный цвет показывает действие или provenance. Не используются декоративные gradients, glassmorphism и чрезмерные pill-контейнеры.
- Анимация объясняет наследование, invalidation и перемещение job; при `prefers-reduced-motion` смысл сохраняется статическими связями и текстом.

### Responsive modes

- **≥1280 px:** полный studio layout — assets, focused preview, inspector, timeline, matrix/job drawer.
- **1024–1279 px:** focused editing, collapsible panels и одна primary preview; matrix открывается отдельным workspace.
- **<1024 px:** review/approval, diagnostics и job monitoring. Точные timeline-жесты не маскируются под «поддержку mobile editing».
- Режим вычисляется реактивно через container/media queries, а не одноразовый `window.innerWidth`.

## 10. Accessibility requirements

- WCAG 2.2 AA как release gate для всех golden-path экранов.
- Visible focus, skip targets и логичный focus return после dialogs/panels.
- Accessible name и state (`aria-pressed`, `aria-selected`, `aria-valuetext`) для каждого icon control.
- Никакой семантики только цветом; provenance и diagnostic severity имеют текст/иконку.
- Pointer target минимум 24×24 CSS px, основной toolbar — 36–44 px; touch/review mode — 44 px.
- Timeline и matrix используют документированную keyboard model и screen-reader summary для больших виртуализированных наборов.
- Drag-and-drop всегда имеет menu/command alternative.
- Autosave, job completion и ошибки сообщаются через ненавязчивые live regions без спама на каждый progress tick.
- Canvas handles имеют клавиатурные nudge/resize/rotate команды с coarse/fine step.

## 11. Performance budgets

Числа подтверждаются на зафиксированных reference hardware и media corpus; до этого они являются целями, а не заявлением о текущем состоянии.

| Сценарий | Budget beta |
|---|---:|
| pointer-to-paint при drag/trim, p95 | ≤16.7 ms |
| React commit во время continuous gesture, p95 | ≤8 ms |
| локальный durable journal receipt, p95 | ≤100 ms |
| видимый `Saved` после спокойного состояния, p95 | ≤250 ms после debounce/write |
| warm open: 5,000 elements / 48 cells | ≤2 s до интерактивности |
| timeline pan/zoom: 10,000 clips | 60 Hz target; release floor ≥55 FPS, без long task >50 ms |
| focused 1080p/30 preview | ≥29 fps, dropped frames <1% на reference device |
| Preview Wall | максимум одна full-quality tile; только видимые tiles декодируются |
| job progress staleness | <1 s локально, <2 s connected |

Обязательны bounded LRU caches, backpressure, transferable buffers, proxy tiers, отмена устаревших задач, memory-pressure telemetry и отсутствие full-result buffering для больших exports.

## 12. Надёжность и безопасность

### Надёжность

- Save state machine сохраняет dirty/error до подтверждённого durable write.
- Project/scene/variant switch не может применить history или selection из другого scope.
- Preview и export используют отдельные render surfaces/ownership; ошибка кадра не замораживает следующий render.
- Job state хранится durable; progress cache не является source of truth.
- Каждый job идемпотентен, retry не создаёт дубликат deliverable.
- Миграции storage forward-only, тестируются на реальных snapshots и никогда молча не отбрасывают неизвестные поля.

### Security/privacy

- Локальные media не загружаются без явного действия пользователя.
- File type проверяется по содержимому; действуют limits для размера, duration, dimensions и декодирования.
- Connected mode использует tenant-scoped authorization, RLS, short-lived signed URLs и server-side secret isolation.
- Upload и render workers рассматривают media как недоверенные данные и работают с resource/time limits.
- CSP, HSTS, frame-ancestors, Permissions-Policy и корректная proxy/IP policy входят в deployment gate.
- Templates/naming rules не исполняют пользовательский код; filenames нормализуются.
- Telemetry не содержит raw media, transcript или creative text по умолчанию.

## 13. Success metrics

### Пользовательские

- median time от master до первого трёхформатного preview;
- количество готовых variants на operator-hour;
- доля diagnostics, исправленных до export;
- доля повторных master edits, корректно унаследованных без ручной работы;
- batch success rate и доля retry только неудачных items;
- crash/reload recovery success rate.

### Технические

- save failure и recovery telemetry;
- input latency, dropped frames, long tasks и cache pressure;
- resolver cache hit rate и invalidation fan-out;
- job queue latency, retry count и orphaned jobs;
- accessibility regression count;
- browser/build/test/license gates pass rate.

### Beta exit target

На reference campaign пользователь должен без обходных действий:

1. импортировать master assets;
2. смонтировать и безопасно восстановить проект после reload;
3. явно включить 12 cells из двух CreativeSets и шести DeliveryProfiles;
4. исправить минимум три типа diagnostics;
5. синхронно просмотреть форматы;
6. экспортировать campaign pack с manifest;
7. повторить только намеренно сломанную job;
8. выполнить основной workflow pointer- и keyboard-путём.

## 14. Не входит в первую beta

- unrestricted per-variant timeline branching;
- real-time multi-user co-editing и CRDT;
- AI generation как обязательная часть workflow;
- arbitrary third-party plugin runtime;
- native mobile editor;
- автоматическая media buying/publishing интеграция;
- гарантированно bit-identical encoded output между разными codec implementations;
- desktop GPUI parity до стабилизации Rust contracts.

## 15. Главные риски и границы решения

| Риск | Контроль |
|---|---|
| variant inheritance поглощает проект | фиксированная hierarchy, лимиты rows/profiles/cells и ADR на расширение |
| preview wall перегружает decoder/GPU | virtualization, visible-only decode, quality tiers, bounded caches |
| browser export исчерпывает память | streaming sinks, capability preflight, remote fallback для тяжёлых jobs |
| Rust migration удваивает логику | contract tests и удаление TS-дубликата в том же vertical slice |
| cloud scope задерживает wow-demo | local-first matrix, diagnostics и local Job Center поставляются раньше connected mode |
| коммерческое использование media/codec нарушает права | provenance manifest, THIRD_PARTY notices, codec/legal ADR, безопасные defaults |
| продукт выглядит как reskin OpenCut | variant graph, Preview Wall, diagnostics и job workflow являются первичными navigation objects |

## 16. Обязательные решения до implementation

До первого изменения исходников должны быть приняты короткие ADR:

1. versioned Rust ↔ TypeScript contract/schema generation;
2. patch allowlist и referenced-slot remap/drop semantics;
3. OPFS/IndexedDB journal and checkpoint format;
4. render surface ownership и browser/server parity boundary;
5. codec/provider policy и license obligations;
6. reference hardware/media corpus и измерительная методика;
7. brand name/trademark clearance и third-party attribution format.

Эта спецификация определяет продуктовый контракт. Любая техническая оптимизация, меняющая наследование, recoverability или keyboard parity, требует обновления документа и тестируемого migration path.
