# FM-DX-Tunnel

> ⚠️ **Warning:** This code was mostly written by AI. Use at your own risk and review the code before deploying in production. Always follow security best practices and keep your systems updated.

Self-hosted tunnel server for [fm-dx-webserver](https://github.com/NoobishSVK/fm-dx-webserver) instances. Allows users to expose their local FM-DX receivers through subdomains on your domain.

Built on [frp](https://github.com/fatedier/frp) reverse proxy with a custom authentication backend.

Made by [FMDX.pro](https://fmdx.pro) for [FMDX.org](https://fmdx.org) fm-dx-webserver project.

## Features

- 🔐 Token-based user authentication
- 🌐 Per-user subdomain allocation
- 📊 Web panel for token management
- 🔍 Tunnel status monitoring
- 🐳 Docker-based deployment

## Quick Start

### 1. Clone and configure

```bash
git clone https://github.com/techkrzysiek/fm-dx-tunnel.git
cd fm-dx-tunnel

# Copy example files
cp .example.env .env
cp docker-compose.example.yml docker-compose.yml
cp config-tunnel/config.yaml.example config-tunnel/config.yaml

# Set ownership (containers run as non-root user UID 1000)
sudo chown 1000:1000 config-tunnel/config.yaml
```

### 2. Edit configuration

Edit `.env`:
```env
TUNNEL_DOMAIN=your-domain.com
```

Edit `config-tunnel/config.yaml` to add users:
```yaml
users:
  username:
    token: "secret-token-here"
    subdomain: "username"
```
You can also add users via webpanel.

### 3. Start services

```bash
docker compose up -d
```

### Development (build locally)

To build images locally instead of using pre-built ones:

```bash
docker compose -f docker-compose.dev.yml up -d --build
```

### Updating

To update to the latest version:

```bash
docker compose pull
docker compose up -d
```

### 4. Configure DNS

Point both `your-domain.com` and `*.your-domain.com` to your server's IP address:
- `A` record: `your-domain.com` → `your-server-ip`
- `A` record: `*.your-domain.com` → `your-server-ip` (wildcard)

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                              Your Server                                  │
│                                                                          │
│  ┌─────────────────┐       ┌─────────────────┐       ┌────────────────┐  │
│  │  Caddy (:443)   │       │  frps (:7000)   │◄─────►│ tunnel-backend │  │
│  │                 │       │                 │       │    (:7002)     │  │
│  │  - TLS/SSL      │       │  - FRP server   │       │                │  │
│  │  - Wildcard     │◄─────►│  - HTTP vhost   │       │ - Auth API     │  │
│  │    certificate  │ :7001 │  - KCP (UDP)    │       │ - Web panel    │  │
│  └────────┬────────┘       └────────┬────────┘       └────────────────┘  │
│           │ :443                    │ :7000                              │
└───────────┼─────────────────────────┼────────────────────────────────────┘
            │                         │
    ┌───────▼─────────────────────────▼───────┐
    │              Internet                    │
    │                                          │
    │  https://user.your-domain.com            │
    │              │                           │
    │              ▼                           │
    │     fm-dx-webserver (user's PC)          │
    └──────────────────────────────────────────┘
```

## Client Configuration

Users connect with [fm-dx-webserver](https://github.com/NoobishSVK/fm-dx-webserver).

## Web Panel

Access the management panel at `http://127.0.0.1:7002/` (warning: no authentication system!).

Features:
- View all user tokens
- Add/edit/delete users
- Check tunnel status
- Monitor fm-dx-webserver connectivity

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/tokens` | GET | List all users |
| `/api/tokens` | POST | Add new user |
| `/api/tokens/:user` | PUT | Update user |
| `/api/tokens/:user` | DELETE | Delete user |
| `/api/tunnel-status` | GET | Check all tunnel statuses |
| `/api/tunnel-status/:subdomain` | GET | Check specific tunnel |
| `/health` | GET | Health check |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TUNNEL_DOMAIN` | `example.com` | Main domain for subdomains |
| `FRP_BIND_PORT` | `7000` | frp server bind port |
| `FRP_VHOST_HTTP_PORT` | `7001` | HTTP vhost port |
| `FRP_KCP_BIND_PORT` | `7000` | KCP protocol port (UDP) |
| `FRP_CUSTOM_404_PAGE` | *(empty)* | Path to custom 404 page (e.g., `/config/404.html`) |

## Custom 404 Page

You can customize the 404 page shown when a tunnel is not connected:

1. Edit `config-frps/404.html` with your custom HTML
2. Set in `.env`:
   ```env
   FRP_CUSTOM_404_PAGE=/config/404.html
   ```
3. Restart the frps container

## Ports

| Port | Protocol | Description |
|------|----------|-------------|
| 7000 | TCP | frp client connections |
| 7000 | UDP | KCP protocol (optional, faster, UDP) |
| 7001 | TCP | HTTP vhost (internal, put behind reverse proxy) |
| 7002 | TCP | Backend web panel (internal) |

## Production Deployment

For production, put port 7001 behind a reverse proxy with:
- SSL/TLS termination
- Wildcard certificate for `*.your-domain.com`

Example Caddy config:
```caddyfile
# Tunnel subdomains (wildcard)
*.your-domain.com {
    tls {
        dns <your-dns-provider> <your-api-key>
    }

    reverse_proxy 172.17.0.1:7001 {
        stream_close_delay 10m
    }
}

# Management panel (optional, with basic auth)
panel.your-domain.com {
    tls {
        dns <your-dns-provider> <your-api-key>
    }

    basic_auth {
        admin $2a$14$your_bcrypt_hash_here
    }

    reverse_proxy 172.17.0.1:7002
}
```

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=techkrzysiek/fm-dx-tunnel&type=date&legend=top-left)](https://www.star-history.com/#techkrzysiek/fm-dx-tunnel&type=date&legend=top-left)
