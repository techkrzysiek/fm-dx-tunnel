#!/bin/sh
set -e

CONFIG_FILE="/etc/frp/frps.toml"

echo "=== FM-DX-Tunnel FRP Server ==="
echo "Generating configuration..."
echo "  Domain: ${TUNNEL_DOMAIN}"
echo "  Bind Port: ${FRP_BIND_PORT}"
echo "  HTTP Port: ${FRP_VHOST_HTTP_PORT}"
echo "  Backend: ${FRP_BACKEND_ADDR}${FRP_BACKEND_PATH}"
if [ -n "${FRP_CUSTOM_404_PAGE}" ]; then
    echo "  Custom 404: ${FRP_CUSTOM_404_PAGE}"
fi

# Generate frps.toml from environment variables
cat > "${CONFIG_FILE}" <<EOF
bindPort = ${FRP_BIND_PORT}
vhostHTTPPort = ${FRP_VHOST_HTTP_PORT}
kcpBindPort = ${FRP_KCP_BIND_PORT}
subDomainHost = "${TUNNEL_DOMAIN}"
EOF

# Add custom 404 page if configured
if [ -n "${FRP_CUSTOM_404_PAGE}" ]; then
    echo "custom404Page = \"${FRP_CUSTOM_404_PAGE}\"" >> "${CONFIG_FILE}"
fi

# Add HTTP plugins
cat >> "${CONFIG_FILE}" <<EOF

[[httpPlugins]]
name = "controller"
addr = "${FRP_BACKEND_ADDR}"
path = "${FRP_BACKEND_PATH}"
ops = ["Login","NewProxy","CloseProxy"]
EOF

echo "Configuration generated at ${CONFIG_FILE}"
echo "---"
cat "${CONFIG_FILE}"
echo "---"
echo "Starting frps..."

exec /usr/local/bin/frps -c "${CONFIG_FILE}"

