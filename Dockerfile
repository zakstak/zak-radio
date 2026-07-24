FROM alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1 AS verified

WORKDIR /package
COPY . .
RUN test "$(sha256sum PACKAGE.SHA256SUMS | cut -d' ' -f1)" = "$(cat RELEASE)" && \
    ! find . -type l -print -quit | grep -q . && \
    ! find . ! -type f ! -type d -print -quit | grep -q . && \
    sha256sum -c PACKAGE.SHA256SUMS && \
    find . -type f \
      ! -path ./RELEASE \
      ! -path ./PACKAGE.SHA256SUMS \
      ! -path ./.zak-radio-apphost-package \
      -print0 | sort -z | xargs -0 sha256sum > /tmp/actual && \
    cmp PACKAGE.SHA256SUMS /tmp/actual

FROM golang:1.26.5-alpine@sha256:0178a641fbb4858c5f1b48e34bdaabe0350a330a1b1149aabd498d0699ff5fb2 AS server

WORKDIR /src
COPY --from=verified /package/go.mod /package/go.sum ./
COPY --from=verified /package/vendor ./vendor
COPY --from=verified /package/internal ./internal
COPY --from=verified /package/cmd ./cmd
COPY --from=verified /package/RELEASE /package/RELEASE
RUN CGO_ENABLED=0 GOOS=linux go build -mod=vendor -trimpath \
    -ldflags="-s -w -X zak-radio-apphost/internal/application.releaseIdentity=$(cat /package/RELEASE)" \
    -o /out/zak-radio ./cmd/zak-radio

FROM scratch

COPY --from=server /out/zak-radio /zak-radio
COPY --from=verified /package/static /static

ENV ZAK_RADIO_METADATA_ROOT=/data/zak-radio \
    ZAK_RADIO_ARCHIVE=/data/zak-radio/music-library \
    ZAK_RADIO_DB=/data/zak-radio/station.sqlite3 \
    ZAK_RADIO_READER_LIBRARY=/data/zak-radio/reader-library \
    ZAK_RADIO_STATIC=/static \
    ZAK_RADIO_CLIENT_IPV6_PREFIX=64 \
    ZAK_RADIO_DROP_PRIVILEGES=1

EXPOSE 8787

USER 65532:65532

ENTRYPOINT ["/zak-radio"]
CMD ["--host", "0.0.0.0", "--port", "8787"]
