FROM oven/bun:1.2.18-alpine AS bun-source

FROM node:22.15.1-alpine AS base
COPY --from=bun-source /usr/local/bin/bun /usr/local/bin/bun

FROM base AS builder

WORKDIR /app

ARG NEXT_PUBLIC_MARBLE_API_URL=https://api.marblecms.com
ARG NEXT_PUBLIC_SITE_URL=http://127.0.0.1:32200
ARG NEXT_PUBLIC_VARIANTLAB_M8_TEST_ADAPTER=0

COPY package.json package.json
COPY bun.lock bun.lock
COPY turbo.json turbo.json

COPY apps/web/package.json apps/web/package.json
COPY packages/studio-contract/package.json packages/studio-contract/package.json
COPY rust/wasm/pkg/package.json rust/wasm/pkg/package.json
RUN --mount=type=cache,target=/root/.bun/install/cache \
    sh -c 'attempt=1; while [ "$attempt" -le 3 ]; do bun install --frozen-lockfile && exit 0; rm -rf /app/node_modules; attempt=$((attempt + 1)); done; exit 1'

COPY apps/web/ apps/web/
COPY packages/studio-contract/ packages/studio-contract/
COPY rust/wasm/pkg/ rust/wasm/pkg/

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_MARBLE_API_URL=$NEXT_PUBLIC_MARBLE_API_URL
ENV NEXT_PUBLIC_VARIANTLAB_M8_TEST_ADAPTER=$NEXT_PUBLIC_VARIANTLAB_M8_TEST_ADAPTER

WORKDIR /app/apps/web
# These non-production stubs satisfy build-time validation without accepting or
# persisting credentials through Docker ARG/ENV instructions. Production values
# are injected only when the runner container starts.
RUN DATABASE_URL="postgresql://variantlab:variantlab@localhost:5432/variantlab" \
    BETTER_AUTH_SECRET="variantlab-build-placeholder-32-characters" \
    UPSTASH_REDIS_REST_URL="http://localhost:8079" \
    UPSTASH_REDIS_REST_TOKEN="build-placeholder" \
    MARBLE_WORKSPACE_KEY="build-placeholder" \
    FREESOUND_CLIENT_ID="build-placeholder" \
    FREESOUND_API_KEY="build-placeholder" \
    node /app/node_modules/next/dist/bin/next build

# Production image
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static

RUN chown nextjs:nodejs apps

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "apps/web/server.js"]
