# Демонстрация VariantLab

## Локальный production candidate

Актуальный экран: http://127.0.0.1:32270/variantlab. Он работает с `VARIANTLAB_M8_TEST_MODE=0` и локальными Postgres/Redis/MinIO/Rust services только на портах `32200–32299`. Browser data привязаны к origin; переносите кампании только через явный bundle export/import.

1. Создайте кампанию, импортируйте WebM и дождитесь `Saved locally`.
2. Создайте adaptive 9:16, добавьте собственный текст/PNG и привяжите typed slots.
3. Добавьте creative rows и delivery profiles, выберите cells в matrix и сравните их в Preview Wall.
4. Выполните local preflight/export или войдите в connected account и запустите cloud batch. В connected режиме оригиналы загружаются только после явного запуска с видимым списком файлов.
5. Закройте вкладку и откройте её снова: server batch продолжает работу. На другом browser profile войдите в тот же account, найдите campaign/batch и скачайте результат.
6. Для M9 измените campaign offline во втором context, синхронизируйте и проверьте явную Recovered branch. Создайте review link на frozen revision, откройте его анонимно и выполните approve/reject.
7. Переключите RU/EN, проверьте keyboard focus и review layout при 200% zoom.

## Ключевые команды

```powershell
node script/bun.mjs install --frozen-lockfile
node script/bun.mjs run typecheck:web
node script/bun.mjs run lint:web
node script/bun.mjs test apps/web/src
node script/bun.mjs run build:web
node script/rust-toolchain.mjs fmt
node script/rust-toolchain.mjs clippy
node script/rust-toolchain.mjs test
```

Полная CI matrix в `.github/workflows/bun-ci.yml` отдельно запускает strict render parity, 50-cell scale, Redis/object-store chaos, worker recovery, M9 continuation/review, caption stress, performance, browser matrix, database preflight, SBOM/source bundle и secret scan.

## Граница публичного demo

Бесплатный публичный URL представляет browser-local creative workflow. Он не является размещением production Connected backend: account, cloud render, cross-device sync и review требуют Postgres/Redis/object storage/Rust workers и production secrets. Полный connected путь проверен локально на exact production image и доступен через Compose.

Перед коммерческой или широкой Connected beta остаются внешние решения: trademark/name clearance, legal clearance dependency/codec chain, managed infrastructure/domain/TLS/retention/observability, проверка HSTS на конечном домене и независимая assistive-technology/user acceptance. Подробный закрывающий verdict — в `FINAL_AUDIT.md` и `docs/M8_M9_RELEASE_WORK.md`.
