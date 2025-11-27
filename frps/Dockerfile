# FM-DX-Tunnel FRP Server
# Automatically downloads frp from GitHub releases and generates config from ENV

FROM alpine:3

ARG FRP_VERSION=0.65.0
ARG TARGETARCH

# Install required packages
RUN apk add --no-cache \
    curl \
    tar \
    ca-certificates \
    tzdata

# Download and install frp based on architecture
RUN case "${TARGETARCH}" in \
        "amd64") FRP_ARCH="amd64" ;; \
        "arm64") FRP_ARCH="arm64" ;; \
        "arm") FRP_ARCH="arm" ;; \
        *) FRP_ARCH="amd64" ;; \
    esac && \
    echo "Downloading frp v${FRP_VERSION} for linux_${FRP_ARCH}..." && \
    curl -fSL "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_${FRP_ARCH}.tar.gz" -o /tmp/frp.tar.gz && \
    tar -xzf /tmp/frp.tar.gz -C /tmp && \
    mv /tmp/frp_${FRP_VERSION}_linux_${FRP_ARCH}/frps /usr/local/bin/frps && \
    chmod +x /usr/local/bin/frps && \
    rm -rf /tmp/frp* && \
    frps --version

# Create non-root user
RUN addgroup -g 1000 frp && adduser -u 1000 -G frp -s /bin/sh -D frp

# Create config directory with proper permissions
RUN mkdir -p /etc/frp && chown -R frp:frp /etc/frp

# Copy entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Environment variables with defaults
ENV TUNNEL_DOMAIN=example.com \
    FRP_BIND_PORT=7000 \
    FRP_VHOST_HTTP_PORT=7001 \
    FRP_KCP_BIND_PORT=7000 \
    FRP_BACKEND_ADDR=fm-dx-tunnel-backend:7002 \
    FRP_BACKEND_PATH=/handler

EXPOSE 7000 7000/udp 7001

# Run as non-root user
USER frp

ENTRYPOINT ["/entrypoint.sh"]

