# FRP Server Plugin

Node.js backend for [frp](https://github.com/fatedier/frp) server plugin authentication.

## Features

- User authentication via `user` and `metas.token`
- Subdomain verification per user (HTTP proxies only, no custom domains)
- Credentials re-checked for every work connection, so removed users stop serving traffic
- Web panel and API behind a login
- YAML configuration
- Debug mode with detailed logging
- Health check endpoint

## Configuration

Edit `config-tunnel/config.yaml`:

```yaml
server:
  port: 7002
  path: /handler

debug: true

users:
  testuser1:
    token: "testtoken1"
    subdomain: "testuser1"
  
  testuser2:
    token: "testtoken2"
    subdomain: "testuser2"
```

## Running

### Local Development

```bash
cd app
npm ci
npm run build:css   # Builds public/app.css (Tailwind), needed once and after style changes
PANEL_PASSWORD=dev-password npm run dev  # Debug mode with verbose logging
# or
PANEL_PASSWORD=dev-password npm start    # Normal mode
```

### Docker

```bash
docker build -t frp-server-plugin .
docker run -p 127.0.0.1:7002:7002 -e PANEL_PASSWORD=choose-a-long-password \
  -v $(pwd)/config:/config frp-server-plugin
```

Mount the directory that holds `config.yaml`, not the file alone: the backend saves by writing a temporary file next to it and renaming it.

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/handler` | POST | FRP plugin handler (called by frps directly, not through a reverse proxy) |
| `/health` | GET | Health check |
| `/debug/config` | GET | View config (debug mode only, login required) |
| `/debug/users` | GET | View users list (debug mode only, login required) |

The panel API (`/api/*`) is described in the main [README](../README.md#api-endpoints).

## FRP Integration

This backend is designed to work with the `frps` container in FM-DX-Tunnel. 
The frps configuration is generated automatically from environment variables.

See the main [README](../README.md) for full deployment instructions.

## API Response Format

### Reject

```json
{
  "reject": true,
  "reject_reason": "invalid credentials"
}
```

### Allow

```json
{
  "reject": false,
  "unchange": true
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CONFIG_PATH` | `./config.yaml` | Path to configuration file |
| `PANEL_USER` | `admin` | Web panel login name |
| `PANEL_PASSWORD` | *(random per start)* | Web panel password |
| `LOGIN_MAX_FAILURES` | `10` | Wrong tokens per user and client IP before tunnel logins are rejected |
| `LOGIN_FAILURE_WINDOW` | `600` | Seconds the failures are counted and the block lasts |

