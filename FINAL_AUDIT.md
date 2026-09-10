# Закрытие обязательных блокеров M8/M9

**Дата:** 2026-09-10  
**Режим:** точечное закрытие результатов аудита 2026-09-09 без повторного полного аудита  
**Инженерный вердикт:** **GREEN для публикации demo / release candidate**

## Решение

Все локально исправимые обязательные блокеры из предыдущего `FINAL_AUDIT.md` закрыты. M8 достиг exit criteria, а необходимый для Connected beta срез M9 реализован и подтверждён на production build с `VARIANTLAB_M8_TEST_MODE=0`. Исторические RED receipts сохранены как evidence исправлений и не переименованы в GREEN.

GREEN означает готовность исходного release candidate и публичного demo. Он не означает юридическое разрешение рабочего названия, коммерческую codec-лицензию или готовность бесплатного demo-hosting к эксплуатации как production connected backend.

## Закрытые findings

| ID | Результат | Подтверждение |
|---|---|---|
| FA-01 — decoded-video parity | **CLOSED** | Untagged SDR декодируется по зафиксированному BT.601 fallback в Rust до инициализации decoder; moving WebM strict gate: MAE 1.660–2.332, duration delta 0.005 s, размеры 1080×1920 (`m8-m9-release-final-20260910`). ADR-0011. |
| FA-02 — security headers | **CLOSED локально** | Nonce CSP/strict-dynamic, frame-ancestors none, no-store, nosniff, no-referrer, Permissions-Policy, trusted runtime origin и hydration: 5/5 (`m8-security-deploy-candidate-final-20260910`). HSTS остаётся проверкой HTTPS-хоста. |
| FA-03 — release CI | **CLOSED** | GitHub Actions содержит frozen web gates, Rust fmt/clippy/test/contracts/WASM/parity, production connected matrix, three-browser local suite, database preflight, runtime/lock SBOM, source bundle и gitleaks. Нет `continue-on-error`. |
| FA-04 — scale/failures | **CLOSED** | 50 jobs / 50 artifacts; dispatch p95 216.298 ms, RTF p95 1.4457, max concurrency 1, UI long tasks 0 (`m8-scale-hardened-final-20260910`). Redis outage/rebuild, object-store mapping/checksum, cancel, retry-failed-only, duplicate terminal delivery и worker SIGKILL/lease retry подтверждены; crash даёт две закрытые attempts и один artifact. |
| FA-05 — supply chain | **CLOSED технически** | Неиспользуемый BotId удалён. Lock SBOM: 2051 components, 0 missing license metadata. Runtime SBOM: 4946 components по 7 immutable images. Source bundle: 3603 notice files и 4 SHA-256 verified archives; gitleaks — 0 leaks. Legal clearance остаётся внешним решением. |
| FA-06 — RU/EN | **CLOSED для golden path** | RU default, EN switch/reload, localized M4–M9 controls/diagnostics, корректные `lang`/metadata/manifest: production browser gate GREEN. Пользовательский copy, filenames и provider names намеренно не переводятся. |
| FA-07 — caption scale | **CLOSED** | OverlayStream лениво передаёт metadata/frames, активные buffers ограничены 32 overlays / 64 MiB и освобождаются. Stress: 1000 cues, 2500 s, native/WASM sampled hashes equal, cache <1 MiB (`caption-stress-20260910`). ADR-0012. |
| FA-08 — accessibility/performance | **CLOSED для release candidate** | Keyboard paths, visible focus, axe RU/EN, 390 px review mode при 200%, reduced motion и визуальная проверка сохранённых screenshots. M6 corpus: 58.14 FPS, scroll p95 36.5 ms, warm open 1914 ms, DOM 63, 100 cells; M2 10,000 clips: 60 FPS, pointer paint p95 1.2 ms, Rust apply p95 0.4 ms. |
| M9 — continuation/review | **CLOSED для Connected beta** | Bounded Rust outbox, lost-ack replay, writer lease, two-device conflict с сохранённой Recovered branch, corrupt download retry, immutable review revision, expiry/revoke/stale/idempotent decision и anonymous no-upload: `m9-deploy-candidate-final3-20260910`, 1/1. ADR-0013. |

## Финальные проверки

- Rust workspace test, clippy и fmt — GREEN; generated contracts, WASM и text/logo native parity — GREEN.
- Web typecheck и production Next build — GREEN; 220 tests / 544 assertions, 0 failures; ESLint — 0 errors (131 существующее warning-level observations).
- Database preflight — fresh migrations 0001–0006, RLS negative isolation, backup/restore и live no-op upgrade GREEN. Последний backup receipt: `.variantlab-backups/20260910032824722/receipt.json`.
- Exact production image browser checks — M9 1/1 и auth/localization/security 5/5 GREEN.
- Docker worker limits подтверждены: 2 CPU, 2 GiB memory/memory-swap, 128 PIDs, read-only root, tmpfs, all capabilities dropped, no-new-privileges.
- Все локальные listeners и browser targets этой работы находятся в диапазоне `32200–32299`; актуальная production проверка использует `32270`.

## Реальные внешние блокеры

Они не исправляются изменением этого репозитория и не блокируют ограниченный бесплатный demo:

1. Trademark/name clearance для рабочего codename VariantLab.
2. Юридическое решение по коммерческому распространению и обязательствам SoundTouchJS LGPL, Mediabunny MPL, MinIO AGPL, Redis licensing, FFmpeg/codec chain, fonts/models/media. Технические notices, SBOM и source offers подготовлены, но не заменяют counsel approval.
3. Для production Connected beta: отдельные managed Postgres/Redis/object storage, production secrets, HTTPS domain, retention/observability/backup policy и проверка HSTS на конечном домене.
4. Независимая проверка assistive technology и визуальная приемка реальными пользователями перед широкой публичной beta. Локально закрыты keyboard, AX semantics, axe, focus и 200% layouts; это не заявляется как внешнее пользовательское исследование.

## Готовность

Исходный код, CI-конфигурация и бесплатный demo-срез готовы к публикации. Публичный demo должен честно обозначать browser-local режим; connected account/render/sync/review требуют отдельного backend deployment и production configuration.
