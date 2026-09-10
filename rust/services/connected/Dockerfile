FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS ffmpeg-builder

ARG FFMPEG_VERSION=7.1.1
RUN apt-get update \
    && apt-get install --yes --no-install-recommends build-essential ca-certificates curl libopus-dev libvpx-dev nasm pkg-config xz-utils \
    && curl --fail --location --silent --show-error "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" -o /tmp/ffmpeg.tar.xz \
    && mkdir /tmp/ffmpeg \
    && tar -xJf /tmp/ffmpeg.tar.xz --strip-components=1 -C /tmp/ffmpeg
WORKDIR /tmp/ffmpeg
RUN ./configure \
      --prefix=/opt/ffmpeg \
      --disable-autodetect \
      --disable-everything \
      --disable-network \
      --disable-debug \
      --disable-doc \
      --disable-gpl \
      --disable-nonfree \
      --disable-programs \
      --enable-ffmpeg \
      --enable-libopus \
      --enable-libvpx \
      --enable-encoder=libopus \
      --enable-encoder=libvpx_vp9 \
      --enable-decoder=opus \
      --enable-decoder=vp8 \
      --enable-decoder=vp9 \
      --enable-decoder=rawvideo \
      --enable-demuxer=rawvideo \
      --enable-demuxer=matroska \
      --enable-muxer=webm \
      --enable-bsf=vp9_superframe \
      --enable-protocol=file       --enable-protocol=pipe \
      --enable-filter=aresample \
      --enable-filter=format \
      --enable-filter=null \
      --enable-filter=scale \
      --enable-filter=crop \
      --enable-filter=overlay \
      --enable-filter=trim \
      --enable-filter=atrim \
      --enable-filter=setpts \
      --enable-filter=asetpts \
      --enable-filter=setsar \
      --enable-filter=fps \
      --enable-filter=concat \
      --enable-filter=color \
      --enable-filter=anullsrc \
      --enable-filter=aformat \
      --enable-filter=apad \
    && make -j2 \
    && make install \
    && /opt/ffmpeg/bin/ffmpeg -buildconf 2>&1 | grep --fixed-strings -- '--disable-gpl' \
    && /opt/ffmpeg/bin/ffmpeg -buildconf 2>&1 | grep --fixed-strings -- '--disable-nonfree' \
    && ! /opt/ffmpeg/bin/ffmpeg -encoders 2>&1 | grep -E '[[:space:]](h264|aac|libx264|libx265|libfdk_aac)[[:space:]]' \
    && ! /opt/ffmpeg/bin/ffmpeg -decoders 2>&1 | grep -E '[[:space:]](h264|aac)[[:space:]]'

FROM rust:1.91.1-bookworm@sha256:c1e5f19e773b7878c3f7a805dd00a495e747acbdc76fb2337a4ebf0418896b33 AS rust-builder
WORKDIR /workspace
COPY Cargo.toml Cargo.lock ./
COPY rust ./rust
COPY assets/fonts ./assets/fonts
COPY apps/desktop ./apps/desktop
RUN --mount=type=cache,id=variantlab-m8-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=variantlab-m8-cargo-target,target=/workspace/target \
    cargo build --locked --jobs 1 --release -p variantlab-connected && cp /workspace/target/release/variantlab-connected /variantlab-connected

FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl libopus0 libvpx7 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 variantlab \
    && mkdir -p /tmp/variantlab-m8 \
    && chown variantlab:variantlab /tmp/variantlab-m8
COPY --from=ffmpeg-builder /opt/ffmpeg /opt/ffmpeg
COPY --from=rust-builder /variantlab-connected /usr/local/bin/variantlab-connected
COPY assets/fonts/inter-4.1/LICENSE.txt /usr/share/licenses/variantlab/Inter-OFL-1.1.txt
ENV PATH="/opt/ffmpeg/bin:${PATH}"
USER variantlab
EXPOSE 8080
ENTRYPOINT ["variantlab-connected"]

