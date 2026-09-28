# CI-only replacement for withdrawn upstream registry images. Keep the exact
# existing releases; production Sites storage remains R2.
FROM golang:1.24.6-alpine3.22 AS build-base
RUN apk add --no-cache git ca-certificates
ENV CGO_ENABLED=0 GOTOOLCHAIN=local GOMAXPROCS=2

FROM build-base AS server-build
WORKDIR /source
RUN git init && git remote add origin https://github.com/minio/minio.git \
    && git fetch --depth 1 origin 7ced9663e6a791fef9dc6be798ff24cda9c730ac \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = 7ced9663e6a791fef9dc6be798ff24cda9c730ac \
    && go build -mod=readonly -p 2 -trimpath -buildvcs=false -o /out/minio .

FROM build-base AS client-build
WORKDIR /source
RUN git init && git remote add origin https://github.com/minio/mc.git \
    && git fetch --depth 1 origin ee72571936f15b0e65dc8b4a231a4dd445e5ccb6 \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = ee72571936f15b0e65dc8b4a231a4dd445e5ccb6 \
    && go build -mod=readonly -p 2 -trimpath -buildvcs=false -o /out/mc .

FROM alpine:3.22.1 AS server
RUN apk add --no-cache ca-certificates curl
COPY --from=server-build /out/minio /usr/local/bin/minio
COPY --from=server-build /source /usr/share/variantlab-fixture-source
LABEL org.opencontainers.image.source="https://github.com/minio/minio" \
      org.opencontainers.image.revision="7ced9663e6a791fef9dc6be798ff24cda9c730ac" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
ENTRYPOINT ["minio"]

FROM alpine:3.22.1 AS client
RUN apk add --no-cache ca-certificates
COPY --from=client-build /out/mc /usr/local/bin/mc
COPY --from=client-build /source /usr/share/variantlab-fixture-source
LABEL org.opencontainers.image.source="https://github.com/minio/mc" \
      org.opencontainers.image.revision="ee72571936f15b0e65dc8b4a231a4dd445e5ccb6" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
ENTRYPOINT ["mc"]
