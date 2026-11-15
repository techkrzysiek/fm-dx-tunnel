# FM-DX-Tunnel FRP Server
# Automatically downloads frp from GitHub releases and generates config from ENV

FROM alpine:3

ARG FRP_VERSION=0.72.0
# SHA-256 of the release archives, from frp_sha256_checksums.txt of that release.
# The build fails if the download does not match - update these together with FRP_VERSION.
ARG FRP_SHA256_AMD64=daf719b32ca2778770bb92955e231a07414d754378b9af328aa2642862479804
ARG FRP_SHA256_ARM64=02180b857480302fd934e9ddbd50fe2f73229f99062f88756abc6de9df5e95cf
ARG FRP_SHA256_ARM=d0531b20c7fef4c7d2efb281931e62f0612bb7f0de62d200fa9020fd58d319ca
ARG TARGETARCH

# Install required packages
RUN apk add --no-cache \
    curl \
    tar \
    ca-certificates \
    tzdata

# Download frp for the target architecture, verify its checksum and install it
RUN case "${TARGETARCH:-$(apk --print-arch)}" in \
        amd64|x86_64) FRP_ARCH="amd64"; FRP_SHA256="${FRP_SHA256_AMD64}" ;; \
        arm64|aarch64) FRP_ARCH="arm64"; FRP_SHA256="${FRP_SHA256_ARM64}" ;; \
        arm|armv7|armhf) FRP_ARCH="arm"; FRP_SHA256="${FRP_SHA256_ARM}" ;; \
        *) echo "Unsupported architecture: ${TARGETARCH:-$(apk --print-arch)}" >&2; exit 1 ;; \
    esac && \
    echo "Downloading frp v${FRP_VERSION} for linux_${FRP_ARCH}..." && \
    curl -fSL "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_${FRP_ARCH}.tar.gz" -o /tmp/frp.tar.gz && \
    echo "${FRP_SHA256}  /tmp/frp.tar.gz" | sha256sum -c - && \
    tar -xzf /tmp/frp.tar.gz -C /tmp && \
    mv /tmp/frp_${FRP_VERSION}_linux_${FRP_ARCH}/frps /usr/local/bin/frps && \
    chmod +x /usr/local/bin/frps && \
    rm -rf /tmp/frp* && \
    frps --version

# Create non-root user
RUN addgroup -g 1000 frp && adduser -u 1000 -G frp -s /bin/sh -D frp

# Create config directories with proper permissions
RUN mkdir -p /etc/frp /config && chown -R frp:frp /etc/frp /config

# Copy entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Environment variables with defaults
ENV TUNNEL_DOMAIN=example.com \
    FRP_BIND_PORT=7000 \
    FRP_VHOST_HTTP_PORT=7001 \
    FRP_KCP_BIND_PORT=7000 \
    FRP_BACKEND_ADDR=fm-dx-tunnel-backend:7002 \
    FRP_BACKEND_PATH=/handler \
    FRP_TLS_FORCE=true \
    FRP_CUSTOM_404_PAGE=""

EXPOSE 7000 7000/udp 7001

# Run as non-root user
USER frp

ENTRYPOINT ["/entrypoint.sh"]

