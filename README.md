# FM-DX-Tunnel

> ⚠️ **Warning:** This code was mostly written by AI. Use at your own risk and review the code before deploying in production. Always follow security best practices and keep your systems updated.

Self-hosted tunnel server for [fm-dx-webserver](https://github.com/NoobishSVK/fm-dx-webserver) instances. Allows users to expose their local FM-DX receivers through subdomains on your domain.

Built on [frp](https://github.com/fatedier/frp) reverse proxy with a custom authentication backend.

Made by [FMDX.pro](https://fmdx.pro) for [FMDX.org](https://fmdx.org) fm-dx-webserver project.

## Features

- 🔐 Token-based user authentication
- 🌐 Per-user subdomain allocation (HTTP tunnels on the user's own subdomain only)
- 📊 Web panel for token management, protected by a login
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
# The config holds the tokens, so keep it private to that user
sudo chown -R 1000:1000 config-tunnel
sudo chmod 600 config-tunnel/config.yaml
```

### 2. Edit configuration

Edit `.env`:
```env
TUNNEL_DOMAIN=your-domain.com
PANEL_USER=admin
PANEL_PASSWORD=choose-a-long-password
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

The CI workflow rebuilds the images every week to include base image security updates, so pulling regularly is worth it.

When updating from a version without the panel login:

- Set `PANEL_PASSWORD` in `.env`. Without it the panel still asks for a login and the password for that run is printed in `docker compose logs fm-dx-tunnel-backend`.
- Tunnel clients must connect with TLS (frpc does so by default since v0.50). See `FRP_TLS_FORCE` below.
- Users can only open an HTTP tunnel on their own subdomain. Custom domains and other proxy types (tcp, udp, stcp, ...) are rejected.

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

Access the management panel at `http://127.0.0.1:7002/` and log in with `PANEL_USER` / `PANEL_PASSWORD` from `.env`.

Features:
- View all user tokens
- Add/edit/delete users
- Check tunnel status
- Monitor fm-dx-webserver connectivity

The login is a second layer, not a reason to expose port 7002: keep the panel behind a reverse proxy with TLS (see [Production Deployment](#production-deployment)). Sessions last 12 hours and are dropped when the backend restarts. After 10 failed logins the client has to wait 10 minutes.

### Removing a user or changing a token

Deleting a user or changing their token takes effect right away for new visitors: the tunnel stops serving within one more request. Connections that are already open (for example a running audio stream) last until they close. The client's control connection itself stays open until that client disconnects, and until then it keeps the subdomain reserved. A client that logs in with the new token gets its tunnel as soon as the old one is gone (frpc retries every 30 seconds). To throw out a client that refuses to leave, restart the frps container:

```bash
docker compose restart fm-dx-tunnel-frps
```

## API Endpoints

All `/api/*` endpoints except `/api/login` need the session cookie set by a successful login.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/login` | POST | Log in (`{"username": "...", "password": "..."}`) |
| `/api/logout` | POST | Log out |
| `/api/tokens` | GET | List all users |
| `/api/tokens` | POST | Add new user |
| `/api/tokens/:user` | PUT | Update user |
| `/api/tokens/:user` | DELETE | Delete user |
| `/api/tunnel-status` | GET | Check all tunnel statuses |
| `/api/tunnel-status/:subdomain` | GET | Check specific tunnel (configured subdomains only) |
| `/api/status` | GET | Backend status (user count, debug mode) |
| `/health` | GET | Health check (no login needed) |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TUNNEL_DOMAIN` | `example.com` | Main domain for subdomains |
| `PANEL_USER` | `admin` | Web panel login name |
| `PANEL_PASSWORD` | *(random per start)* | Web panel password. If empty, a random one is generated on every start and printed in the backend log |
| `FRP_BIND_PORT` | `7000` | frp server bind port |
| `FRP_VHOST_HTTP_PORT` | `7001` | HTTP vhost port |
| `FRP_KCP_BIND_PORT` | `7000` | KCP protocol port (UDP) |
| `FRP_CUSTOM_404_PAGE` | *(empty)* | Path to custom 404 page (e.g., `/config/404.html`) |
| `FRP_TLS_FORCE` | `true` | Refuse tunnel clients that do not use TLS (the token is part of the login message) |
| `LOGIN_MAX_FAILURES` | `10` | Wrong tokens allowed per user and client IP before further tunnel logins are rejected (`0` = no limit) |
| `LOGIN_FAILURE_WINDOW` | `600` | How long, in seconds, those failures are counted and the block lasts |

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

Host the panel on a **different domain** than the tunnels. Every tunnel is a website run by one of your users, and a site on `something.your-domain.com` can set cookies for all of `your-domain.com`. A panel on its own domain is out of their reach.

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

# Management panel (optional) - on its own domain, not under your-domain.com
panel.other-domain.com {
    # The panel has its own login. basic_auth in front of it is an optional extra layer.
    basic_auth {
        admin $2a$14$your_bcrypt_hash_here
    }

    # /handler is the frps plugin endpoint, it is not part of the panel
    @handler path /handler /handler/*
    respond @handler 404

    reverse_proxy 172.17.0.1:7002
}
```

The backend also refuses `/handler` requests that arrive through a reverse proxy (it looks for the `X-Forwarded-*` headers proxies add), so the rule above is a second line of defence.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=techkrzysiek/fm-dx-tunnel&type=date&legend=top-left)](https://www.star-history.com/#techkrzysiek/fm-dx-tunnel&type=date&legend=top-left)
