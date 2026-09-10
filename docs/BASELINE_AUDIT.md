# Upstream editor — baseline-аудит

**Дата фиксации:** 2026-08-27  
**Ветка:** `main`  
**Коммит:** `cf5e79e919144200294fb9fed22a222592a0aeea`  
**Область:** существующий upstream editor до продуктовой трансформации  
**Статус решения:** **GO для проектирования и foundation-работ; NO-GO для production-релиза и коммерческого распространения текущего baseline**

Этот документ фиксирует состояние исходного проекта, а не целевую архитектуру. Во время аудита исходный код приложения не изменялся. Корневой `LICENSE` и сведения об VariantLab являются обязательной частью дальнейшей производной работы.

## 1. Резюме для принятия решения

Upstream editor — не пустой UI-макет, а содержательное local-first ядро браузерного видеоредактора: есть сцены, многодорожечный timeline, клипы нескольких типов, playback, snapping, group move/trim, keyframes, masks, bookmarks, аудиомикширование, импорт локальных файлов, WebCodecs/Mediabunny-предпросмотр и экспорт, а также Rust/WASM-композитор. На этом ядре можно строить самостоятельный профессиональный продукт.

Однако текущий baseline нельзя считать production-ready:

- dev-сервер запустился и четыре HTTP-маршрута вернули `200`, но production build падает на несовместимых типах двух версий Next.js;
- из 191 теста 182 прошли и 9 упали; дополнительно зафиксированы 3 ошибки загрузки модулей;
- lint возвращает 112 ошибок и 21 предупреждение;
- браузерные взаимодействия не были выполнены: инструмент управления браузером упал до навигации из-за инфраструктурной ошибки sandbox;
- полный Docker-стек не поднят: загрузка образов зависла, контейнеры не были созданы;
- undo/redo и selection не ограничены жизненным циклом проекта/сцены, что создаёт риск межсценовой порчи данных;
- autosave может потерять признак dirty после неуспешной записи и скрывает ошибку от вызывающего кода;
- preview, snapshot и export используют один глобальный WASM compositor без явной координации владения;
- экспорт буферизует итоговый файл и аудио целиком в памяти браузера;
- нет durable background jobs, server-side media workers, proxy pipeline, журнала восстановления и E2E/a11y-набора;
- перед коммерческим релизом необходима отдельная очистка лицензий, атрибуций, бренда, Freesound-источников и codec policy.

Итоговая позиция:

| Решение | Вердикт | Условие |
|---|---:|---|
| Использовать editor/media-ядро как основу трансформации | GO | Сохранить сильные interaction/render primitives, но закрыть data-safety и renderer ownership до расширения модели |
| Начинать UX-прототипирование нового продукта | GO | Не выдавать статически найденные функции за проверенные в браузере |
| Выпускать текущий web build пользователям | NO-GO | Нужны зелёные install/build/test/lint и browser smoke |
| Доверять autosave как гарантии сохранности | NO-GO | Нужны журнал, retry, last-known-good и failure-state UI |
| Запускать параллельный/batch export | NO-GO | Нужны изолированные render surfaces, лимиты памяти и durable job model |
| Коммерчески распространять под новым брендом | NO-GO | Нужны trademark separation, third-party notices, Freesound provenance и legal review codec/LGPL obligations |

## 2. Методика и статусы доказательств

Аудит сочетает чтение кода и конфигурации, локальные команды установки/сборки/тестирования, HTTP smoke и попытку запуска инфраструктуры. Каждое утверждение относится к одному из статусов:

| Маркер | Значение |
|---|---|
| **[RUNTIME]** | Команда или HTTP-запрос реально выполнены в этой среде; результат зафиксирован ниже |
| **[STATIC]** | Возможность или дефект подтверждены чтением исходного кода/конфигурации, но не полным пользовательским прогоном |
| **[BLOCKED]** | Проверка начата, но не завершена из-за среды, сети или browser tooling; это не доказательство ни работоспособности, ни поломки приложения |

Проверялись:

- monorepo-конфигурация, Next.js/React shell, route handlers и зависимости;
- PostgreSQL/Drizzle, Redis/Upstash и Docker Compose;
- EditorCore, timeline, commands/history, scenes, selection, playback, keyboard actions;
- импорт, metadata, preview, WebAudio, renderer, Rust/WASM, экспорт и локальное хранение;
- UI/UX, responsiveness, accessibility и профессиональные монтажные сценарии;
- тесты, CI, autosave/recovery, error handling, security и технический долг;
- MIT-лицензия, VariantLab brand policy и сторонние компоненты/ассеты.

Ограничения доказательств:

- **[BLOCKED]** автоматизированный browser control и computer-use дважды завершились до открытия страницы с `windows sandbox failed: helper_unknown_error: apply deny-read ACLs`;
- поэтому ни один drag-and-drop, trim, keyboard shortcut, playback, autosave/reload или export flow не отмечен как browser-verified;
- **[BLOCKED]** Docker image pulls зависли; DB migration, Better Auth и Redis rate limiting не прошли runtime-проверку;
- внешние codec/patent и trademark выводы являются engineering/compliance-воротами, а не юридическим заключением.

## 3. Снимок репозитория и воспроизводимость

### 3.1. Исходная среда

**[RUNTIME]** На старте были доступны Node.js, npm и Docker. Bun, Cargo/Rust, `wasm-pack`, локальный `.env` и `node_modules` отсутствовали. Корневой `package.json` декларирует `bun@1.2.18`; workspace включает `apps/*` и `packages/*`, но каталога `packages/` в baseline нет, хотя скрипты ссылаются на `@variantlab/tools`.

Архитектурное правило в корневом `AGENTS.md` требует переносить всю platform-agnostic бизнес-логику в `rust/`, оставляя приложения UI-shell. Фактическое состояние пока переходное: значительная часть редактора, команд, timeline, media и storage остаётся в TypeScript внутри `apps/web/src/`.

### 3.2. Выполненные команды

| Проверка | Статус | Фактический результат | Интерпретация |
|---|---:|---|---|
| `docker compose build web` | **[RUNTIME] FAIL** | `oven/bun:alpine` разрешился в Bun `1.4.0`; шаг `bun install` завершился 21 ошибкой integrity/extract tarball | Часть ошибок могла быть сетевой, но unpinned base image и отсутствие `--frozen-lockfile` делают Docker build невоспроизводимым; см. `apps/web/Dockerfile` |
| `npx --yes bun@1.2.18 --version` | **[RUNTIME] PASS** | `1.2.18` | Заявленную версию Bun можно получить без глобальной установки |
| `npx --yes bun@1.2.18 install --frozen-lockfile` | **[RUNTIME] PASS** | 966 пакетов, 53.52 s | Lockfile устанавливается на заявленном Bun; это текущая рабочая точка локального setup |
| `npx --yes bun@1.2.18 test` | **[RUNTIME] FAIL** | 191 тест: 182 pass, 9 fail, 3 module errors, 386 `expect()` | Suite реально существует, но baseline красный |
| `npx --yes bun@1.2.18 run lint:web` | **[RUNTIME] FAIL** | 133 проблем: 112 errors, 21 warnings | Lint не является release gate в текущем состоянии |
| `npx --yes bun@1.2.18 run build:web` | **[RUNTIME] FAIL** | Next compilation завершилась за 7.3 s; TypeScript упал в `apps/web/next.config.ts:54` | Production bundle не выпускается |
| `next dev` с непустыми placeholder env | **[RUNTIME] PASS** | Next `16.1.3`, Ready примерно за 1070 ms | Dev shell стартует без работающих внешних сервисов при синтаксически валидных env |
| HTTP `GET /` | **[RUNTIME] PASS** | `200`, 116748 bytes, title `VariantLab` | SSR landing route отвечает |
| HTTP `GET /projects` | **[RUNTIME] PASS** | `200`, 91258 bytes, title `VariantLab` | SSR project route отвечает; CRUD не проверен |
| HTTP `GET /api/health` | **[RUNTIME] PASS** | `200`, body length 2 (`OK`) | Проверяет только статический handler, не DB/Redis/storage |
| HTTP `GET /editor/baseline-audit` | **[RUNTIME] PASS** | `200`, 66397 bytes, title `VariantLab` | Route shell отвечает; интерактивный editor не проверен |
| Проверка headers на `next dev` | **[RUNTIME] OBSERVED** | Отсутствовали CSP, HSTS, `X-Frame-Options`, `Permissions-Policy`, COOP и COEP | Это dev-server observation, не verdict production deployment; явная header policy также не найдена статически |
| Browser interaction smoke | **[BLOCKED]** | sandbox helper error до навигации | Нельзя утверждать, что UI-сценарии реально выполнены |
| `docker compose up -d db redis serverless-redis-http` | **[BLOCKED]** | `redis:7-alpine` скачан; слои Postgres/serverless proxy зависли; выполнение остановлено; контейнеры не созданы | Полный backend setup не проверен; сетевой блок не считается дефектом кода |

Первые 9 упавших тестов включают timeline placement с инициализацией `ZERO_MEDIA_TIME`. Три ошибки загрузки модулей зафиксированы для:

- `variantlab-wasm`: `__wbindgen_start is not a function`;
- registry параметров: обращение к `DEFAULTS` до инициализации;
- actions: отсутствующий экспорт `isActionWithOptionalArgs`.

Production build падает из-за двух версий Next.js в одном lock graph: web workspace использует `next@16.1.3`, корень разрешился в `next@16.2.4`; обёртки `withContentCollections`/`withBotId` дают несовместимые типы `NextConfig`, включая `adapterPath`. В `bun.lock` также разрешён `@opennextjs/cloudflare@1.19.4`, чьи peer-границы требуют Next `<16` либо `>=16.2.3`, то есть не принимают web `16.1.3`.

### 3.3. Что считать воспроизводимым baseline

Сейчас воспроизводим только ограниченный dev baseline:

1. получить Bun `1.2.18`;
2. выполнить frozen install;
3. задать все обязательные строки из `apps/web/src/env/web.ts`, включая Marble и Freesound placeholders;
4. запустить Next dev;
5. получить HTTP `200` на перечисленных маршрутах.

Не воспроизводимы как зелёные проверки: Docker production build, production TypeScript build, lint, полный test suite, DB migrations, Redis flow, browser E2E и export flow.

## 4. Фактическая архитектура

### 4.1. Системный контур

| Слой | Baseline | Доказательство | Вывод |
|---|---|---|---|
| Web UI | Next.js App Router + React 19, Tailwind/Radix, Zustand для отдельных UI stores | `apps/web/package.json`, `apps/web/src/app/`, `apps/web/src/components/` | Основной и фактически единственный зрелый клиент |
| Editor domain | Singleton `EditorCore` с менеджерами command/timeline/playback/scenes/project/media/renderer/save/audio/selection/clipboard/diagnostics | `apps/web/src/core/index.ts`, `apps/web/src/core/managers/*` | Бизнес-логика пока сосредоточена в TypeScript UI-приложении, вопреки целевому правилу `rust/` |
| React subscription | `useEditor(selector)` подписывает каждый selector сразу на девять менеджеров через `useSyncExternalStore` | `apps/web/src/editor/use-editor.ts` | API удобен, но invalidation слишком широкая |
| Server surface | Next route handlers: Better Auth, feedback, Freesound proxy, health | `apps/web/src/app/api/auth/[...all]/route.ts`, `api/feedback/route.ts`, `api/sounds/search/route.ts`, `api/health/route.ts` | Отдельного application backend нет |
| Project/media data | IndexedDB для project/metadata, OPFS для media blobs | `apps/web/src/services/storage/service.ts`, `indexeddb-adapter.ts`, `opfs-adapter.ts` | Продукт local-first; сервер не является source of truth для монтажных проектов |
| PostgreSQL | Better Auth entities и feedback | `apps/web/src/db/schema.ts` | Проекты, сцены, клипы и media в Postgres не хранятся |
| Redis | Upstash rate limit/Better Auth support; в Compose — Redis + HTTP bridge | `apps/web/src/auth/rate-limit.ts`, `apps/web/src/auth/server.ts`, `docker-compose.yml` | Очередей и background-job semantics нет |
| Browser workers | Один module Web Worker для Transformers.js/Whisper | `apps/web/src/services/transcription/service.ts`, `worker.ts` | Транскрипция вынесена с main thread, остальные тяжёлые этапы — нет |
| Rust/WASM | time, bridge, gpu, effects, masks, compositor и `rust/wasm` bindings | `rust/crates/*`, `rust/wasm/*` | Сильное render/time основание, но не единый domain source of truth |
| Web WASM consumption | Published `variantlab-wasm@0.2.10` | `apps/web/package.json`, `.github/CONTRIBUTING.md` | Fresh clone не связывает web с локальным `rust/wasm`; CI build local WASM не доказывает его использование web build |
| Desktop | GPUI-окно с заголовком `VariantLab` | `apps/desktop/src/main.rs` | Desktop — stub, не функциональный редактор |

### 4.2. Backend, database и Redis

**[STATIC]** Server-side код является вспомогательным, а не media backend:

- Better Auth экспортирован через catch-all handler, но явного завершённого пользовательского sign-in flow в UI не найдено;
- feedback пишет в Postgres через Drizzle;
- Freesound route валидирует запрос, применяет rate limit и проксирует API;
- health route всегда возвращает `OK` и не проверяет Postgres/Redis, поэтому Compose healthcheck может быть зелёным при недоступных зависимостях.

Обнаружен schema/migration drift:

- `apps/web/drizzle.config.ts` указывает несуществующий путь `./src/lib/db/schema.ts`, тогда как схема находится в `apps/web/src/db/schema.ts`;
- `apps/web/migrations/0000_brainy_saracen.sql` создаёт auth-таблицы и `waitlist`, но не `feedback`;
- актуальная TypeScript-схема содержит `feedback`, но не `waitlist`;
- auth-таблицы вызывают `.enableRLS()`, однако policies в репозитории не найдены; `feedback` не включает RLS.

Redis не является очередью: `apps/web/src/auth/rate-limit.ts` использует один sliding-window limiter. Нет job payload, lease, idempotency key, retry/dead-letter, progress channel или durable source of truth.

### 4.3. Зависимости и version drift

Значимые фактически разрешённые версии из `bun.lock`:

- Next root `16.2.4`, Next web `16.1.3`;
- React/React DOM `19.2.5` в lock graph;
- Better Auth `1.6.9`;
- Mediabunny `1.41.0`;
- Transformers.js `3.8.1`;
- Drizzle ORM `0.44.7`;
- Zustand `5.0.12`;
- SoundTouchJS `0.3.0`;
- VariantLab WASM `0.2.10`.

Диапазоны в `package.json` и итоговый lock не всегда совпадают с ожидаемой минорной версией. Для media-продукта это особенно рискованно: codec capability, WebCodecs behavior и Next adapter compatibility должны проверяться на фиксированном наборе версий и браузеров.

## 5. Editor architecture

### 5.1. Модель и состояние

**[STATIC]** `EditorCore` — process-wide singleton. Он создаёт менеджеры один раз, регистрирует effects/masks/transcription diagnostics и запускает `SaveManager`. React-компоненты получают либо весь instance, либо selector через `apps/web/src/editor/use-editor.ts`.

Timeline-модель (`apps/web/src/timeline/types.ts`) различает main video, overlay и audio tracks. Элементы включают video, image, audio, text, sticker, graphic и effect. Сцены живут в проекте; активная сцена определяется `ScenesManager`.

Положительные свойства:

- команды инкапсулируют execute/undo и позволяют одной pointer-жестовой операции стать одной history transaction;
- timeline и preview имеют специализированные controllers вместо распределённой по JSX арифметики;
- media time и frame-rate типы постепенно вынесены в `variantlab-wasm`/`rust/crates/time`;
- selection выделен в `SelectionManager` с snapshot/restore;
- playback имеет отдельный manager и high-frequency update channel;
- renderer строит scene graph, а не рисует напрямую из React tree.

Архитектурные ограничения:

- singleton затрудняет несколько открытых проектов/редакторов и тестовую изоляцию;
- почти все `useEditor(selector)` подписываются на все девять managers, поэтому узкое изменение может пересчитать несвязанные selectors;
- managers используют широкие `notify()` без typed change-set или lane priority;
- domain state и UI state не имеют формально сгенерированного Rust↔TS контракта.

### 5.2. Timeline и профессиональные interactions

В исходниках реализованы, но не browser-verified:

- **[STATIC]** multi-select и box select: `apps/web/src/selection/*`, `timeline/hooks/element/use-element-selection.ts`;
- **[STATIC]** group move между совместимыми tracks со snapping: `timeline/group-move/*`;
- **[STATIC]** group trim/resize с frame rounding и отключением snap через Shift: `timeline/group-resize/*`, `timeline/controllers/resize-controller.ts`;
- **[STATIC]** split, delete, duplicate, paste и ripple adjustment: `commands/timeline/element/*`, `core/managers/commands.ts`, `ripple/*`;
- **[STATIC]** DnD внешних файлов, внутренних assets и effects: `timeline/hooks/use-timeline-drag-drop.ts`, `timeline/controllers/drag-drop-controller.ts`, assets `draggable-item.tsx`;
- **[STATIC]** waveform, volume line, mute/visibility, source-audio separation и retime: `timeline/components/audio-waveform.tsx`, `audio-volume-line.tsx`, `audio-separation/*`, `retime/*`;
- **[STATIC]** bookmarks с time/duration/note/color и drag/snap: `timeline/bookmarks/*`;
- **[STATIC]** keyframe lanes, box selection, drag и cubic Bézier graph: `timeline/hooks/element/use-keyframe-*`, `timeline/components/graph-editor/*`;
- **[STATIC]** preview hit-testing, move/snap, scale, rotation, inline text и masks: `preview/controllers/*`, `preview/components/text-edit-overlay.tsx`, `masks/*`.

Пробелы professional workflow:

- track names фактически не формируют полноценную профессиональную иерархию; нет законченных rename/reorder/lock/solo/group workflows;
- в editor chrome не найдено явных undo/redo buttons, хотя shortcuts/actions существуют;
- replace media, freeze frame и часть adjustment/transition UI представлены disabled/placeholder состояниями;
- drop media поверх существующего клипа не формирует законченный replace flow;
- guides частично присутствуют в коде, но не составляют надёжный safe-area/brand validation workflow;
- duplicate может создавать новый верхний track вместо ожидаемого контекстного размещения;
- canvas не даёт эквивалент timeline multi-select/box-select во всех сценариях;
- cross-element keyframe drag не имеет ясно ограниченной семантики.

### 5.3. Playback

**[STATIC]** `PlaybackManager` использует `performance.now()` и `requestAnimationFrame`, а `AudioManager` — WebAudio look-ahead scheduling. Playhead/timecode имеют imperative/high-frequency обновление, что является правильным направлением для 30/60 fps UI.

Риски:

- video и audio опираются на разные clock paths; drift correction и единый authoritative media clock не доказаны;
- часть UI читает coarse `currentTime` через обычную manager notification, поэтому frame-dependent property/mask/bookmark UI может визуально отставать или замерзать во время playback, когда playhead продолжает двигаться;
- preview рендерит в native canvas size и video source resolution, без формального preview proxy/resolution ladder;
- dropped-frame policy, frame deadline budget и browser/device capability matrix не заданы.

### 5.4. Undo/redo, history и selection

**P0 [STATIC] — межсценовая/межпроектная история.** `CommandManager` хранит глобальные `history`/`redoStack`. Метод `clear()` существует, но вызовы очистки при `ScenesManager.switchToScene`, `ProjectManager.loadProject`, `closeProject` или смене active project не найдены. Timeline snapshot-команды (`apps/web/src/commands/timeline/tracks-snapshot.ts` и element commands) работают через текущий editor scope. Сценарий риска: изменить сцену A → перейти в B → Undo; старая команда может примениться к текущей активной сцене/проекту.

**P0 [STATIC] — stale selection.** `ScenesManager.switchToScene`, `initializeScenes` и `ProjectManager.loadProject/closeProject` не вызывают `editor.selection.clearSelection()`. Element/keyframe/mask refs предыдущего scope могут остаться активными.

Дополнительные проблемы history:

- нет лимита по числу записей или памяти;
- часть команд сохраняет целые `SceneTracks` before/after snapshots, поэтому длинная сессия и большие timeline могут удерживать значительные графы;
- `execute()` добавляет запись даже для семантически no-op команды, если сама команда не предотвращает это;
- coalescing для повторяющихся keyboard/property edits не задан как общий контракт;
- command entry не несёт обязательных `projectId/sceneId` и precondition revision.

Положительный baseline: history восстанавливает selection snapshot для команд с явным selection override, а gesture controllers позволяют commit-ить drag/trim одной командой.

### 5.5. Keyboard interactions

**[STATIC]** Система actions/keybindings (`apps/web/src/actions/*`) поддерживает централизованный registry, пользовательское переназначение, persistence/migrations, конфликт-детекцию и editor actions. Найдены transport-oriented shortcuts, включая J/K/L, split/delete/duplicate и навигационные команды.

Но keyboard parity неполная:

- timeline clips исключены из нормального tab order (`tabIndex=-1` в representative clip UI);
- resize/volume/transform/mask handles не имеют эквивалентных keyboard operations;
- ruler объявляет slider-like semantics без полной клавиатурной реализации;
- canvas/timeline selection требует pointer для ключевых операций;
- нет browser-E2E теста, подтверждающего focus path, конфликт shortcuts с текстовым вводом и работу на Windows/macOS layouts.

## 6. Media pipeline

### 6.1. Импорт и metadata

**[STATIC]** Импорт доступен из file picker, drag-and-drop и image paste через `media/use-file-upload.ts`, `use-paste-media.ts` и `media/processing.ts`. Для video metadata/codec/decode capability используется Mediabunny (`media/mediabunny.ts`); генерируются thumbnails. Файл затем сохраняется в OPFS, metadata — в IndexedDB.

Риски:

- первичная классификация опирается на `File.type`; обязательного magic-byte/container probe до регистрации asset нет;
- нет системных hard limits на размер, duration, dimensions, track count или decompression/resource abuse;
- `processMediaAssets` может продолжить UI success/progress flow, даже если `MediaManager.addMediaAsset()` вернул `null`; broken asset и optimistic success расходятся;
- `fps` и `hasAudio` вычисляются в `media/processing.ts`, но `StorageService.saveMediaAsset()` их не сериализует, а `loadMediaAsset()` не восстанавливает;
- proxy/transcode generation отсутствует; дальнейшая работа идёт по оригиналу.

### 6.2. Preview и audio

**[STATIC]** Video frames читает `VideoCache` поверх Mediabunny/WebCodecs; кэш содержит sink pool. Scene graph строится в `services/renderer/scene-builder.ts`, visual nodes — в `services/renderer/nodes/*`. `CanvasRenderer` передаёт frame descriptors в глобальный `wasmCompositor`, который использует Rust/WASM wgpu/WebGPU с fallback path. Audio смешивается/планируется через WebAudio.

**P0 [STATIC] — общее render surface.** `apps/web/src/services/renderer/compositor/wasm-compositor.ts` экспортирует один `wasmCompositor` с одним canvas, mutable size и cache. Preview, snapshot/thumbnail и export создают разные `CanvasRenderer`, но явного lock, lease или отдельных compositor instances/surfaces нет. Одновременный resize/render/syncTextures способен смешать размеры, textures или кадры.

**P1 [STATIC] — preview может навсегда остановиться после ошибки.** В `apps/web/src/preview/components/index.tsx` `renderingRef.current` сбрасывается только внутри `.then()`. Нет `.catch()`/`.finally()`: один rejected render оставляет guard в `true`.

**P1 [STATIC] — VideoCache отменяет параллельные запросы к одному source.** `VideoCache.getFrameAt()` увеличивает generation по `mediaId`; более новый запрос делает предыдущий stale. Если один source участвует в нескольких визуальных ветках одного кадра или одновременно нужен preview/export, ранний consumer может получить предыдущий/null frame.

Другие performance/reliability риски:

- waveform готовится через full-file decode и хранится в памяти, без worker chunking/streaming;
- audio invalidation может пересобирать scheduling graph на edit и давать audible gap;
- compositor и media caches не имеют формального byte budget/LRU/memory-pressure response;
- project thumbnail создаётся как full-size PNG/data URL на main thread;
- нет preview proxy, adaptive resolution или backpressure по декодеру.

### 6.3. Export

**[STATIC]** `RendererManager.exportProject()` строит активную сцену и использует `SceneExporter`. Доступны:

- MP4 с AVC/H.264 и AAC (с fallback аудиокодека);
- WebM с VP9 и Opus;
- quality presets Mediabunny;
- включение timeline audio;
- progress callback и cancel flag;
- browser download результата.

Границы текущего экспорта:

- экспортируется только `getActiveScene().tracks`, а не композиция всех project scenes;
- `BufferTarget` удерживает весь encoded output в памяти до формирования Blob/download;
- timeline audio заранее создаётся как полный stereo `AudioBuffer`, что увеличивает пиковую память;
- cancel не прерывает предэкспортную подготовку audio;
- codec preflight не формализован до начала дорогого рендера;
- `Math.floor(duration / ticksPerFrame)` может отбросить trailing partial frame;
- нет resume/checkpoint, render manifest, retry, idempotency или проверки output integrity;
- нет server-side/offline worker export; закрытие вкладки уничтожает работу.

### 6.4. Хранение, autosave и recovery

**[STATIC]** `StorageService` хранит проекты в IndexedDB (`video-editor-projects`), media blobs в project-specific OPFS и metadata в отдельном IndexedDB. Есть versioned project migrations и quota helpers. Это хорошая local-first база.

**P0 [STATIC] — autosave может скрыть потерю записи.** `SaveManager.saveNow()` устанавливает `hasPendingSave=false` до `await saveCurrentProject()`. `ProjectManager.saveCurrentProject()` ловит ошибку и только пишет `console.error`, не rethrow. Поэтому `SaveManager` считает операцию завершённой, dirty guard может стать false, retry не планируется, а `beforeunload` больше не защищает несохранённые изменения.

**P0 [STATIC] — migration runner несовместим с adapter API.** `services/storage/migrations/runner.ts` вызывает `new IndexedDBAdapter(dbName, storeName, version)` и `set(key, value)`, тогда как `indexeddb-adapter.ts` принимает object options и `set({ key, value })`. Это прямой contract drift в критическом пути открытия старых проектов.

Не хватает:

- append-only command journal/WAL;
- atomic snapshot + acknowledged revision;
- last-known-good checkpoint и rollback после corruption;
- retry/backoff и пользовательского состояния `pending/saving/saved/error`;
- `pagehide`/`visibilitychange` flush; есть только dirty `beforeunload` в `editor-provider.tsx`;
- crash replay и recovery UI;
- теста quota exceeded, partial OPFS write, IndexedDB abort, migration interruption и reload после crash.

### 6.5. Background processing и transcription

Только transcription вынесена в `new Worker(...worker.ts)`. Transformers.js загружает Whisper-модели по строковым Hugging Face IDs из `transcription/models.ts`.

**[STATIC]** Риски service/worker protocol:

- `Float32Array` отправляется без transfer list и может копироваться;
- cancel отправляет сообщение, но тяжёлая модель/вычисление не имеют доказанного cooperative abort на каждом этапе;
- нет `worker.onerror`, timeout, request ID или изоляции нескольких concurrent requests;
- listeners добавляются для запросов без видимого общего cleanup-контракта;
- отсутствуют durable progress, retry и model revision pinning;
- создаваемые AudioContext/resources не имеют доказанного полного lifecycle cleanup.

Server-side workers, queues и object storage отсутствуют. В текущем baseline «background job» означает только живущий внутри вкладки Web Worker.

## 7. UI/UX, responsiveness и accessibility

### 7.1. Сильные стороны

**[STATIC]** Editor shell визуально и структурно уже ближе к NLE, чем к CRUD-приложению:

- resizable panels, preview viewport, properties и timeline;
- direct manipulation на clips, keyframes, masks и canvas elements;
- zoom, snap indicators, waveforms, bookmarks и graph editor;
- контекстные меню, shortcut dialog и panel stores;
- imperative playhead снижает давление React renders на playback path.

Это сильная база для сложного React/frontend portfolio product: присутствуют pointer geometry, DnD, temporal state, canvas/WebGPU bridge, history и high-frequency UI.

### 7.2. Professional UX gaps

**[STATIC]** Редактор пока выглядит как широкий desktop workspace, но workflow не доведён до уровня профессионального production tool:

- нет ясной информационной архитектуры tracks с именами, lock/solo/group/reorder;
- ряд важных операций скрыт только в shortcuts/context menus;
- undo/redo не имеют заметного status/toolbar affordance;
- save state не виден как надёжная machine state;
- export не показывает capability preflight, estimate, storage/memory warning и resumable queue;
- нет полноценной media relink/replace/proxy/offline workflow;
- нет review/approval, provenance и delivery manifest;
- onboarding прямо маркирует продукт как beta, а несколько панелей/команд остаются placeholder/disabled.

### 7.3. Responsiveness

**[STATIC]** `apps/web/src/components/editor/mobile-gate.tsx` один раз читает `window.innerWidth < 1024` при mount. После acknowledgement он пропускает полный editor; resize listener/matchMedia subscription отсутствует.

Следствия:

- editor не является адаптивным в процессе изменения viewport;
- узкие desktop/tablet layouts могут получить переполненный fixed workspace;
- mobile gate — предупреждение, не responsive mode;
- нет отдельного touch/review-only сценария и безопасных touch targets;
- timeline имеет жёсткие layout ограничения, включая максимальную высоту, а не container-query поведение.

### 7.4. Accessibility findings

Полного axe/browser-аудита не было; ниже **[STATIC]** findings по source review:

- mute/visibility controls в track chrome представлены clickable SVG/неполноценными semantic buttons;
- clip container исключён из tab order и содержит вложенные interactive descendants, что усложняет фокус и нарушает модель вложенной интерактивности;
- resize handles имеют pointer semantics, но не keyboard trim;
- несколько icon-only toolbar actions не имеют стабильного accessible name/`aria-label` и state через `aria-pressed`;
- timeline ruler использует slider-like роль/атрибуты, но value и keyboard handlers не отражают реальное управление;
- preview использует application semantics без полного focusable keyboard contract;
- transform/mask handles частично находятся в `aria-hidden` области либо лишены имён и keyboard operation;
- volume line — pointer-driven `div` без slider keyboard semantics;
- editable project name не имеет устойчивой label/focus affordance;
- `outline-none` встречается на custom controls без эквивалентного видимого focus indicator;
- targets размером примерно 16–28 px недостаточны для touch и motor accessibility;
- `prefers-reduced-motion`/reduced-motion policy для animations/transitions не обнаружена.

Accessibility baseline: **NO-GO для заявления WCAG conformity** до semantic-control refactor, keyboard parity, focus order, screen-reader labels, contrast/zoom checks и automated axe + manual assistive-tech проверки.

## 8. Надёжность, ошибки и security

### 8.1. Error handling и recovery

Критические проблемы сохранения и preview описаны выше. Дополнительно:

- import path не всегда связывает toast/progress success с фактом persisted asset;
- export — stateful promise внутри `ProjectManager`; durable state вне вкладки отсутствует;
- `/api/feedback` вызывает `request.json()` вне `try/catch`, поэтому malformed JSON может стать unstructured 500;
- backend flows не имеют централизованных typed errors/correlation IDs;
- observability ограничена `console.*` и локальными render diagnostics; нет product telemetry для save failures, dropped frames, job retries или storage pressure;
- `/api/health` не выявляет отказ DB/Redis.

### 8.2. Security baseline

**[STATIC]** Положительное: route inputs для feedback/Freesound проходят Zod; Freesound и feedback защищены общим rate limiter; Better Auth не реализован самописным crypto-кодом.

Пробелы:

- `checkRateLimit()` использует необработанную строку `x-forwarded-for`; без trusted-proxy policy её можно spoof/размножать;
- при недоступном Redis нет явно заданного fail-open/fail-closed/fallback поведения;
- dev-server HTTP observation не показал CSP, HSTS, frame protection, Permissions Policy, COOP/COEP; **[STATIC]** явная production header policy не найдена, а production deployment не был runtime-проверен;
- в приложении есть remote content/scripts/assets paths, но нет целостной allowlist policy;
- production sourcemaps/observability policy не разделены по sensitivity;
- media import не имеет magic-byte validation, hard resource limits и quarantine/decode sandbox contract;
- нет tenant model/RLS policies для будущих cloud projects/jobs;
- отсутствуют dependency vulnerability scan, SBOM, secret scan и signed artifact/provenance gate в CI.

До cloud/team режима обязательны: trusted proxy parsing, session/tenant authorization на каждом объекте, signed object URLs, RLS policies, job ownership, idempotency, upload limits, CSP/COOP/COEP compatibility testing и audit trail.

## 9. Tests, CI и технический долг

### 9.1. Текущий test baseline

**[RUNTIME]** Найдено и запущено 31 JS/TS test file; Bun выполнил 191 тест. Присутствуют unit tests для timeline placement/update, FPS, animation, masks, keybindings persistence и большого набора storage migrations.

Сильная сторона — тесты покрывают чистые temporal/migration функции. Слабые стороны:

- suite красный: 9 failed + 3 module-load errors;
- нет browser/E2E tests;
- нет visual regression для preview/timeline;
- нет axe/accessibility suite;
- нет media fixture matrix по containers/codecs/variable FPS/audio layouts;
- нет concurrency test preview + thumbnail + export;
- нет recovery test на save failure/crash/migration interruption;
- Rust crates не запускаются как обязательный `cargo test` gate;
- WASM↔TS parity/API contract не тестируются против именно того package, который импортирует web.

### 9.2. CI

`.github/workflows/bun-ci.yml`:

- строит local WASM на Ubuntu/Windows/macOS;
- устанавливает Bun `1.2.18`;
- выполняет web build;
- вместо реальных тестов запускает `echo "No tests implemented yet"` с `continue-on-error: true`;
- не запускает ESLint, Bun tests, Cargo tests, browser E2E, accessibility, license/SBOM или security scans;
- cache key ссылается на `apps/web/bun.lock`, хотя baseline lockfile находится в корне;
- `wasm-pack` устанавливается как `latest`, что ослабляет воспроизводимость.

То есть CI не является достаточным доказательством качества даже при зелёном статусе.

### 9.3. Основной технический долг

1. Несогласованная migration boundary: правило «вся логика в Rust» против фактического TypeScript domain.
2. Двойные версии framework/dependency peer drift.
3. Global singleton/history/compositor с неявным scope и ownership.
4. Whole-tree snapshots и broad subscriptions без budget/virtualization strategy.
5. Local persistence без журнала и recovery protocol.
6. Browser-only export без streaming/durable jobs.
7. DB schema drift и фиктивный health endpoint.
8. Красные build/lint/tests при CI, который это не контролирует.
9. Accessibility и responsive behavior не являются acceptance gates.
10. Нет централизованной third-party provenance/licensing системы.

## 10. Лицензия, бренд и сторонние компоненты

### 10.1. VariantLab

Корневой `LICENSE` — MIT, copyright `2025-2026 VariantLab`. Разрешены use/copy/modify/distribute/sublicense/sell при обязательном сохранении copyright notice, permission notice и warranty disclaimer во всех копиях или существенных частях.

Обязательные правила трансформации:

- **не удалять и не переписывать корневой `LICENSE`;**
- сохранить заметное указание, что продукт основан на VariantLab, и исходный copyright;
- не утверждать, что новый продукт является официальным VariantLab или одобрен авторами;
- использовать самостоятельные название, logo, app icons, domain и marketing assets.

`apps/web/src/app/brand/page.tsx` прямо разделяет code license и права на имя/logo: MIT не распространяется на VariantLab name/mark. Допустима фактическая формулировка «Built on VariantLab»/«Based on VariantLab» при сохранении атрибуции; использование VariantLab name/logo как коммерческого бренда требует разрешения. Перед финальным названием нужна trademark clearance.

### 10.2. Code dependencies

| Компонент | Использование | Лицензия/риск | Требование до релиза |
|---|---|---|---|
| `soundtouchjs@0.3.0` | Pitch/time stretch в `apps/web/src/retime/audio-stretch.ts` | `package.json` пакета декларирует LGPL-2.1; главный copyleft/compliance risk | Либо заменить на компонент с приемлемой лицензией, либо документировать способ linking/relinking, предоставить notices/license/source obligations после legal review |
| `mediabunny@1.41.0` | Probe, decode, waveform/audio и browser mux/export | MPL-2.0 file-level obligations | Сохранить MPL notices, отследить изменения MPL-covered files, включить source offer/доступ там, где требуется |
| `variantlab-wasm@0.2.10` | Time и compositor bridge | Производная VariantLab MIT codebase | Сохранить MIT attribution; связать source commit и бинарный artifact |
| `@huggingface/transformers` + Whisper models | Локальная транскрипция | Код и model weights имеют отдельные условия; revisions не pinned | Вести model manifest: repo, exact revision/hash, license, size, languages, redistribution/telemetry policy |
| `gradient-parser` derived code | `apps/web/src/gradients/parser.ts` с ссылкой на upstream | Нужна исходная MIT notice/provenance | Добавить в third-party notices и зафиксировать исходный commit/version |

Текущий репозиторий не содержит единого `THIRD_PARTY_LICENSES`, `NOTICE`, SBOM или автоматического license scan. Нужны lockfile-based inventory и allow/deny policy.

### 10.3. Assets, fonts и content sources

Нужен отдельный provenance manifest для:

- `apps/web/public/flags/*` (похоже на flag-icons; сохранить upstream MIT notice);
- Pattern Craft и Syntax UI gradients (`apps/web/src/data/colors/*`), где сейчас есть только ссылки-комментарии;
- bundled/generated font atlas и загружаемых Google Fonts;
- logos, stickers, shape SVG, effect previews, screenshots и platform assets;
- Whisper model weights;
- любых будущих brand kits/templates пользователя.

### 10.4. Freesound

**P0 compliance [STATIC].** `apps/web/src/app/api/sounds/search/route.ts` называет фильтр `commercial_only`, но:

- schema parse не передаёт `commercial_only` из URL в объект валидации, поэтому default может применяться независимо от UI query;
- фильтр включает `Attribution Noncommercial`, что противоречит обещанию «commercially licensed»;
- API получает username/license, и saved-sound storage их сохраняет, но при переносе звука в timeline/export нет доказанного неизменяемого provenance/credits manifest;
- продукт не генерирует обязательные credits и не блокирует несовместимую лицензию на коммерческом deliverable.

До commercial release Freesound integration должна быть выключена либо ограничена CC0/отдельно согласованным коммерческим каталогом. Для attribution-контента нужны author, source URL, exact license/version, asset ID и export-time credits. API terms также требуют отдельной проверки; UI toggle не является юридической гарантией.

### 10.5. Codecs

H.264/AAC, VP9/Opus и возможный будущий FFmpeg/server encoder требуют отдельного codec policy. Техническая доступность WebCodecs не равна праву на коммерческое распространение encoder/decoder. Выбор server-side x264/FFmpeg может создать лицензионную и патентную «одностороннюю дверь»; нужен ADR и legal review по рынкам распространения, способу доставки бинарников и cloud-only/redistribution модели.

## 11. Что действительно работает

### 11.1. Подтверждено runtime

Следующий минимальный baseline доказан выполнением, без расширительных трактовок:

- frozen dependency install на Bun `1.2.18`;
- dev Next server с placeholder env;
- HTTP `200` для landing, projects, health и editor route shell;
- 182 конкретных unit tests;
- Next production source compilation до TypeScript configuration boundary.

Это **не** доказывает создание проекта, persistence, import, playback, editing, export, auth, feedback write или Freesound query в реальном браузере.

### 11.2. Реализовано в коде, но требует browser verification

| Возможность | Статическое доказательство | Минимальная будущая проверка |
|---|---|---|
| Project/scene CRUD и local persistence | `core/managers/project-manager.ts`, `scenes-manager.ts`, `services/storage/service.ts` | create → edit → reload → reopen, включая private mode/quota |
| Multi-track editing, split/trim/move/ripple | `timeline/*`, `commands/timeline/*`, `ripple/*` | frame-exact E2E с undo/redo и switch scene |
| Selection/keyframes/masks/bookmarks | `selection/*`, `animation/*`, `masks/*`, `timeline/bookmarks/*` | pointer + keyboard + screen-reader flows |
| Playback и audio scheduling | `playback-manager.ts`, `audio-manager.ts` | A/V sync, scrub, J/K/L, background/visibility transitions |
| Import image/video/audio | `media/processing.ts`, upload/paste hooks | codec fixture matrix, broken/malicious files, quota failures |
| Preview renderer | `services/renderer/*`, `rust/crates/compositor`, `rust/wasm` | pixel/visual regression, device fallback, rejection recovery |
| MP4/WebM export | `renderer-manager.ts`, `scene-exporter.ts` | codec preflight, long export, cancel, memory, output validation |
| Local Whisper transcription | `services/transcription/*` | model load/cache/offline/cancel/error/large audio |
| Better Auth, feedback, Freesound proxy | `app/api/*`, `auth/*`, `db/*` | Docker-backed integration/E2E and authorization checks |

## 12. Приоритетные риски

### P0 — закрыть до функционального расширения ядра

1. **History scope corruption:** глобальный undo/redo без project/scene identity и lifecycle clearing.
2. **Silent autosave data loss:** dirty сбрасывается до записи, save error поглощается, retry/recovery отсутствуют.
3. **Broken storage migration contract:** runner использует устаревшие constructor/set signatures.
4. **Render ownership race:** один mutable WASM compositor/canvas/cache для preview, thumbnail/snapshot и export.
5. **Release baseline red:** production build, tests и lint не проходят; CI не запускает реальные tests/lint.
6. **Commercial compliance:** Freesound `commercial_only` допускает Noncommercial; SoundTouch LGPL и third-party notices не закрыты; VariantLab trademark separation обязательна.

### P1 — закрыть до beta с реальными пользователями

1. Preview guard не сбрасывается после rejected render.
2. VideoCache generation конфликтует с параллельными consumers одного source.
3. Media import может показать success для не добавленного/persisted asset.
4. `fps`/`hasAudio` теряются при save/load media metadata.
5. Browser export удерживает output/audio целиком, не имеет resume и экспортирует только active scene.
6. Нет preview proxies, cache budgets, virtualization и memory-pressure handling.
7. Transcription protocol без transfer/cancel/error/timeout/concurrency contract.
8. Timeline/canvas не имеют keyboard parity; semantic controls/focus/reduced-motion нарушены.
9. Responsive gate одноразовый и не создаёт usable tablet/mobile mode.
10. DB schema/migration drift, RLS policies отсутствуют, health endpoint фиктивный.
11. Нет E2E/axe/media fixture/concurrency/recovery suites и production observability.

## 13. Go/no-go ворота трансформации

Каждые ворота закрываются не количеством задач, а наблюдаемым доказательством.

### G0 — воспроизводимый foundation

**GO, когда:** одна зафиксированная Bun/Node/container toolchain; `--frozen-lockfile`; единая версия Next; pinned Docker images; валидный `.env.example`; зелёные install/build/lint/unit/Cargo/WASM contract checks на Windows/Linux/macOS.

**NO-GO evidence сейчас:** Docker build, production build, lint и suite красные.

### G1 — сохранность проекта

**GO, когда:** commands обязательны scoped IDs/revision; history очищается или partitioned; selection очищается при scope change; autosave имеет journal, acknowledged snapshot, retry/backoff, last-known-good, save status и crash replay.

**Обязательные тесты:** edit A → switch B → undo; project A → open B → redo; failed IndexedDB/OPFS write; quota exceeded; interrupted migration; reload после crash.

### G2 — детерминированный media/render pipeline

**GO, когда:** preview/export/thumbnail владеют изолированными surfaces/resources; concurrency test воспроизводимо совпадает с serial render; codec preflight выполняется до job; caches имеют byte budgets; import валидирует container и limits.

**Обязательные тесты:** один source в нескольких nodes; preview во время export; resize во время snapshot; device fallback; rejected frame recovery; golden frames.

### G3 — проверенный пользовательский editor flow

**GO, когда:** Playwright/эквивалент проверяет create/import/trim/split/move/undo/redo/save/reload/export; keyboard-only path покрывает transport и editing; axe + manual focus/screen-reader checks проходят; browser matrix включает Chromium, Firefox и WebKit там, где capability поддерживается.

**NO-GO evidence сейчас:** browser tooling был заблокирован, E2E suite отсутствует.

### G4 — performance budget

**GO, когда:** заданы и измеряются бюджеты main-thread frame, React commit, dropped frames, timeline pan/zoom, preview resolution, import latency, autosave acknowledgement, cache memory и export peak memory. Large-project fixtures должны включать тысячи clips/keyframes и несколько вариантов одного source.

### G5 — cloud/background jobs и security

Ворота применяются только при добавлении cloud/team режима.

**GO, когда:** Postgres — durable job/project revision source; Redis используется только как dispatch/progress acceleration; jobs имеют ownership/idempotency/retry/dead-letter/cancel; object storage — signed/tenant-scoped; RLS и route authorization тестируются; health/readiness реально проверяют зависимости; security headers и trusted proxy policy включены.

### G6 — лицензии, бренд и deliverable provenance

**GO, когда:** сохранён VariantLab MIT notice; новый бренд не использует VariantLab marks; опубликованы NOTICE/third-party licenses/SBOM; SoundTouch решение одобрено; Freesound commercial flow исправлен или удалён; asset/font/model manifests заполнены; codec policy и server encoder ADR прошли legal review.

## 14. Baseline acceptance statement

Upstream editor принят как **технически ценный, но небезопасный для прямого production-релиза foundation**.

Мы можем опираться на:

- temporal/timeline primitives;
- command-based interactions;
- scene graph и Rust/WASM compositor;
- local-first IndexedDB/OPFS направление;
- WebCodecs/Mediabunny integration;
- сложный React workspace с preview, properties и timeline.

Мы не должны переносить в новый продукт без исправления:

- глобальные scope-less history/selection/compositor;
- silent autosave failure;
- browser-only memory-unbounded export;
- широкую React invalidation model;
- фиктивные CI/health guarantees;
- неполную keyboard/a11y/responsive модель;
- неоформленную third-party/content provenance.

Любая следующая спецификация или план должна ссылаться на P0/G0–G6 этого аудита и сохранять корневой `LICENSE`, обязательные notices и фактическую формулировку происхождения продукта.
