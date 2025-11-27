# FRP Server Plugin

Node.js backend for [frp](https://github.com/fatedier/frp) server plugin authentication.

## Features

- User authentication via `user` and `metas.token`
- Subdomain verification per user
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
npm install
npm run dev  # Debug mode with verbose logging
# or
npm start    # Normal mode
```

### Docker

```bash
docker build -t frp-server-plugin .
docker run -p 7002:7002 -v $(pwd)/config.yaml:/config/config.yaml frp-server-plugin
```

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/handler` | POST | FRP plugin handler |
| `/health` | GET | Health check |
| `/debug/config` | GET | View config (debug mode only) |
| `/debug/users` | GET | View users list (debug mode only) |

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

