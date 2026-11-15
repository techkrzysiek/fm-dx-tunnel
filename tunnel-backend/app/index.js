'use strict';

const express = require('express');
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');
const morgan = require('morgan');

// ============================================
// Helpers
// ============================================

// Make any value safe for a single log line: no control characters, bounded length.
function clean(value, max = 160) {
    let s;
    if (typeof value === 'string') {
        s = value;
    } else {
        try {
            s = JSON.stringify(value);
        } catch (e) {
            s = undefined;
        }
        if (s === undefined) s = String(value);
    }
    s = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '?');
    return s.length > max ? s.slice(0, max) + '...' : s;
}

// JSON dump for debug logs with secrets masked.
const REDACTED_KEYS = new Set(['token', 'privilege_key', 'http_pwd', 'sk', 'password']);
function redactedJson(obj) {
    try {
        return JSON.stringify(obj, (key, value) => (REDACTED_KEYS.has(key) && value ? '***' : value), 2);
    } catch (e) {
        return '[unserializable]';
    }
}

// Constant-time string comparison (hashing first hides the length difference).
function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

function envInt(name, fallback, min, max) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
        console.warn(`[CONFIG] Ignoring invalid ${name}=${clean(raw, 32)}, using ${fallback}`);
        return fallback;
    }
    return n;
}

// Counts failures per key in a fixed window. Used for tunnel logins and panel logins.
class FailureLimiter {
    constructor(maxFailures, windowMs, maxKeys = 50000) {
        this.maxFailures = maxFailures;
        this.windowMs = windowMs;
        this.maxKeys = maxKeys;
        this.entries = new Map();
    }

    blocked(key) {
        if (this.maxFailures <= 0) return false;
        const entry = this.entries.get(key);
        if (!entry) return false;
        if (Date.now() >= entry.resetAt) {
            this.entries.delete(key);
            return false;
        }
        return entry.count >= this.maxFailures;
    }

    fail(key) {
        if (this.maxFailures <= 0) return;
        const now = Date.now();
        let entry = this.entries.get(key);
        if (!entry || now >= entry.resetAt) {
            if (this.entries.size >= this.maxKeys) this.prune(now);
            // Table still full: stop tracking new keys instead of growing without bound.
            if (this.entries.size >= this.maxKeys) return;
            entry = { count: 0, resetAt: now + this.windowMs };
            this.entries.set(key, entry);
        }
        entry.count++;
    }

    reset(key) {
        this.entries.delete(key);
    }

    prune(now = Date.now()) {
        for (const [key, entry] of this.entries) {
            if (now >= entry.resetAt) this.entries.delete(key);
        }
    }
}

// Log a message at most once per minute per key.
const throttledLogTimes = new Map();
function logThrottled(key, message) {
    const now = Date.now();
    const last = throttledLogTimes.get(key);
    if (last && now - last < 60000) return;
    if (throttledLogTimes.size > 5000) throttledLogTimes.clear();
    throttledLogTimes.set(key, now);
    console.log(message);
}

// ============================================
// Configuration
// ============================================

const configPath = process.env.CONFIG_PATH || './config.yaml';
let config;

// Login activity per user (in memory, persisted to config)
let loginActivity = Object.create(null);

// Content of our own last save, so the file watcher can skip it
let lastWrittenContent = null;
let atomicSaveWarned = false;

// Users live in a prototype-less object and are only read through getUser(),
// so names like "__proto__" or "constructor" are plain keys.
function normalizeConfig(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('config root must be a mapping');
    }
    const users = Object.create(null);
    if (raw.users !== undefined && raw.users !== null) {
        if (typeof raw.users !== 'object' || Array.isArray(raw.users)) {
            throw new Error('"users" must be a mapping');
        }
        for (const name of Object.keys(raw.users)) {
            const entry = raw.users[name];
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                console.warn(`[CONFIG] Skipping user '${clean(name)}': entry is not a mapping`);
                continue;
            }
            if (typeof entry.token !== 'string' || entry.token === '') {
                console.warn(`[CONFIG] User '${clean(name)}' has no usable token (must be a quoted string) - login disabled for this user`);
            }
            users[name] = entry;
        }
    }
    raw.users = users;
    return raw;
}

function getUser(name) {
    if (typeof name !== 'string' || !config || !config.users) return undefined;
    return Object.hasOwn(config.users, name) ? config.users[name] : undefined;
}

function userNames() {
    return Object.keys((config && config.users) || {});
}

function userSubdomain(name) {
    const entry = getUser(name);
    if (!entry) return undefined;
    return typeof entry.subdomain === 'string' && entry.subdomain ? entry.subdomain : name;
}

function loadConfig() {
    try {
        const content = fs.readFileSync(configPath, 'utf8');
        const newConfig = normalizeConfig(yaml.load(content));
        config = newConfig;

        // Load login activity from config
        for (const user of userNames()) {
            const entry = config.users[user];
            if (entry.lastLogin) {
                loginActivity[user] = {
                    lastLogin: entry.lastLogin,
                    lastIp: entry.lastIp
                };
            }
        }

        console.log('[CONFIG] Loaded configuration from', configPath);
        console.log('[CONFIG] Loaded', userNames().length, 'users');
        return true;
    } catch (e) {
        console.error('[CONFIG] Error loading config:', e.message);
        return false;
    }
}

// The config holds tokens: write to a temp file and rename, so a crash mid-write
// cannot leave a truncated file, and keep it readable by the owner only.
function writeConfigFile(content) {
    const tmpPath = path.join(path.dirname(configPath), `.${path.basename(configPath)}.${process.pid}.tmp`);
    try {
        fs.writeFileSync(tmpPath, content, { mode: 0o600 });
        fs.renameSync(tmpPath, configPath);
        return;
    } catch (e) {
        try {
            fs.unlinkSync(tmpPath);
        } catch (ignored) {
            // nothing to clean up
        }
        if (!atomicSaveWarned) {
            atomicSaveWarned = true;
            console.warn(`[CONFIG] Atomic save not possible (${e.code || e.message}); writing in place instead.`);
            console.warn('[CONFIG] For atomic saves mount the config directory (not just the file) and make it writable for the container user.');
        }
    }
    fs.writeFileSync(configPath, content, { mode: 0o600 });
    try {
        fs.chmodSync(configPath, 0o600);
    } catch (ignored) {
        // not the owner - leave the mode as it is
    }
}

function saveConfig() {
    try {
        // Merge login activity into config before saving
        for (const user of userNames()) {
            if (loginActivity[user]) {
                config.users[user].lastLogin = loginActivity[user].lastLogin;
                config.users[user].lastIp = loginActivity[user].lastIp;
            }
        }

        const content = yaml.dump(config, {
            indent: 2,
            lineWidth: -1,
            noRefs: true
        });
        lastWrittenContent = content;
        writeConfigFile(content);
        console.log('[CONFIG] Saved configuration to', configPath);
        return true;
    } catch (e) {
        console.error('[CONFIG] Error saving config:', e.message);
        return false;
    }
}

function updateLoginActivity(user, ip) {
    loginActivity[user] = {
        lastLogin: new Date().toISOString(),
        lastIp: ip
    };
    // Save to config file
    saveConfig();
}

// Initial config load
if (!loadConfig()) {
    process.exit(1);
}

// Track config reload time
let lastConfigReload = new Date();

// Watch for config file changes. Polling survives atomic replaces (ours and editors')
// and single-file bind mounts, which inode-based watching does not.
const CONFIG_POLL_MS = 2000;

function watchConfig() {
    try {
        fs.watchFile(configPath, { interval: CONFIG_POLL_MS }, (curr, prev) => {
            if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size && curr.ino === prev.ino) return;
            let content;
            try {
                content = fs.readFileSync(configPath, 'utf8');
            } catch (e) {
                console.error('[CONFIG] Could not read changed config file:', e.message);
                return;
            }
            if (content === lastWrittenContent) return; // our own save
            console.log('[CONFIG] Detected change in config file, reloading...');
            if (loadConfig()) {
                lastConfigReload = new Date();
                console.log('[CONFIG] Configuration reloaded successfully');
            } else {
                console.error('[CONFIG] Failed to reload config, keeping previous configuration');
            }
        });
        console.log('[CONFIG] Watching for config file changes:', configPath);
    } catch (e) {
        console.error('[CONFIG] Could not watch config file:', e.message);
    }
}

watchConfig();

const PORT = config.server?.port || 7002;
const HANDLER_PATH = config.server?.path || '/handler';
const TUNNEL_DOMAIN = process.env.TUNNEL_DOMAIN || 'example.com';

// Dynamic debug check
function isDebug() {
    return config.debug || false;
}

// Custom debug logger
function debugLog(...args) {
    if (isDebug()) {
        console.log('[DEBUG]', new Date().toISOString(), ...args);
    }
}

// ============================================
// Tunnel authentication (frps server plugin)
// ============================================

// Accepted formats for values created through the panel/API.
// Usernames double as subdomains, so they have to be valid DNS labels.
const USERNAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TOKEN_RE = /^[A-Za-z0-9_.~!@#$%^*+=:-]{8,32}$/;

// Failed tunnel logins are counted per client IP + username.
const LOGIN_MAX_FAILURES = envInt('LOGIN_MAX_FAILURES', 10, 0, 100000);
const LOGIN_FAILURE_WINDOW = envInt('LOGIN_FAILURE_WINDOW', 600, 1, 86400);
const tunnelLoginLimiter = new FailureLimiter(LOGIN_MAX_FAILURES, LOGIN_FAILURE_WINDOW * 1000);

// Validate user credentials
function validateUser(user, token) {
    const userConfig = getUser(user);
    const expected = userConfig && typeof userConfig.token === 'string' ? userConfig.token : '';
    // Always run the comparison so a missing user costs the same as a wrong token.
    const matches = safeEqual(expected, typeof token === 'string' ? token : '');
    if (!userConfig) {
        debugLog(`User '${clean(user)}' not found in config`);
        return false;
    }
    if (!expected || typeof token !== 'string' || !token || !matches) {
        debugLog(`Invalid token for user '${clean(user)}'`);
        return false;
    }
    debugLog(`User '${clean(user)}' authenticated successfully`);
    return true;
}

// Validate subdomain for user
function validateSubdomain(user, subdomain) {
    const allowedSubdomain = userSubdomain(user);
    if (allowedSubdomain === undefined) {
        debugLog(`User '${clean(user)}' not found for subdomain check`);
        return false;
    }

    // Check if subdomain matches
    if (allowedSubdomain === subdomain) {
        debugLog(`Subdomain '${clean(subdomain)}' allowed for user '${clean(user)}'`);
        return true;
    }

    debugLog(`Subdomain '${clean(subdomain)}' not allowed for user '${clean(user)}'. Allowed: ${clean(allowedSubdomain)}`);
    return false;
}

// "1.2.3.4:5678" / "[2001:db8::1]:5678" -> address without the port
function clientIp(address) {
    if (typeof address !== 'string' || !address) return 'unknown';
    let host = address;
    if (host.startsWith('[')) {
        const end = host.indexOf(']');
        if (end > 0) host = host.slice(1, end);
    } else if (host.split(':').length === 2) {
        host = host.split(':')[0];
    }
    return net.isIP(host) ? host : clean(host, 64);
}

// Response helpers
function rejectResponse(reason) {
    return {
        reject: true,
        reject_reason: reason
    };
}

function allowResponse() {
    return {
        reject: false,
        unchange: true
    };
}

// Handle Login operation
function handleLogin(content, reqId) {
    const user = content.user;
    const token = content.metas?.token;
    const ip = clientIp(content.client_address);

    console.log(`[LOGIN] User: ${clean(user)}, IP: ${ip}, ReqID: ${reqId}`);
    debugLog('Login content:', redactedJson(content));

    if (typeof user !== 'string' || !user) {
        console.log(`[LOGIN] REJECTED - Missing user`);
        return rejectResponse('missing user');
    }

    if (typeof token !== 'string' || !token) {
        console.log(`[LOGIN] REJECTED - Missing token for user: ${clean(user)}`);
        return rejectResponse('missing token');
    }

    const limiterKey = `${ip}|${user}`;
    if (tunnelLoginLimiter.blocked(limiterKey)) {
        logThrottled(`login-blocked:${limiterKey}`, `[LOGIN] REJECTED - Too many failed attempts for user: ${clean(user)} from ${ip}`);
        return rejectResponse('too many failed attempts, try again later');
    }

    if (!validateUser(user, token)) {
        // Only existing users are tracked: there is no token to guess for the others.
        if (getUser(user)) tunnelLoginLimiter.fail(limiterKey);
        console.log(`[LOGIN] REJECTED - Invalid credentials for user: ${clean(user)}`);
        return rejectResponse('invalid credentials');
    }

    tunnelLoginLimiter.reset(limiterKey);

    // Track login activity
    updateLoginActivity(user, ip);

    console.log(`[LOGIN] ACCEPTED - User: ${clean(user)}`);
    return allowResponse();
}

// Handle NewProxy operation.
// A user may open exactly one kind of proxy: HTTP on their own subdomain.
function handleNewProxy(content, reqId) {
    const { user: userInfo, proxy_name, proxy_type, subdomain, custom_domains } = content;
    const user = userInfo?.user;

    console.log(`[NEW_PROXY] User: ${clean(user)}, Proxy: ${clean(proxy_name)}, Type: ${clean(proxy_type)}, ReqID: ${reqId}`);
    debugLog('NewProxy content:', redactedJson(content));

    if (typeof user !== 'string' || !user) {
        console.log(`[NEW_PROXY] REJECTED - Missing user info`);
        return rejectResponse('missing user info');
    }

    // The session may outlive its token (user deleted or token rotated).
    if (!validateUser(user, userInfo?.metas?.token)) {
        console.log(`[NEW_PROXY] REJECTED - Credentials no longer valid for user: ${clean(user)}`);
        return rejectResponse('credentials are no longer valid');
    }

    if (proxy_type !== 'http') {
        console.log(`[NEW_PROXY] REJECTED - Proxy type '${clean(proxy_type)}' not allowed for user: ${clean(user)}`);
        return rejectResponse('only http proxies are allowed');
    }

    const hasCustomDomains = Array.isArray(custom_domains)
        ? custom_domains.length > 0
        : custom_domains !== undefined && custom_domains !== null && custom_domains !== '';
    if (hasCustomDomains) {
        console.log(`[NEW_PROXY] REJECTED - Custom domains ${clean(custom_domains)} requested by user: ${clean(user)}`);
        return rejectResponse('custom domains are not allowed, use your subdomain');
    }

    if (typeof subdomain !== 'string' || !subdomain) {
        console.log(`[NEW_PROXY] REJECTED - Missing subdomain for user: ${clean(user)}`);
        return rejectResponse('subdomain is required');
    }

    if (!validateSubdomain(user, subdomain)) {
        console.log(`[NEW_PROXY] REJECTED - Subdomain '${clean(subdomain)}' not allowed for user: ${clean(user)}`);
        return rejectResponse(`subdomain '${clean(subdomain, 63)}' not allowed for this user`);
    }

    console.log(`[NEW_PROXY] ACCEPTED - User: ${clean(user)}, Proxy: ${clean(proxy_name)}`);
    return allowResponse();
}

// Handle CloseProxy operation
function handleCloseProxy(content, reqId) {
    const { user: userInfo, proxy_name } = content;
    const user = userInfo?.user;

    console.log(`[CLOSE_PROXY] User: ${clean(user)}, Proxy: ${clean(proxy_name)}, ReqID: ${reqId}`);
    debugLog('CloseProxy content:', redactedJson(content));

    return allowResponse();
}

// Handle Ping operation
function handlePing(content, reqId) {
    const { user: userInfo } = content;
    const user = userInfo?.user;

    debugLog(`[PING] User: ${clean(user)}, ReqID: ${reqId}`);

    return allowResponse();
}

// Handle NewWorkConn operation.
// frps asks before every work connection, i.e. before each new visitor connection
// is handed to the client. Checking the credentials here makes a deleted user or
// a rotated token stop serving traffic without waiting for the client to reconnect.
function handleNewWorkConn(content, reqId) {
    const { user: userInfo, run_id } = content;
    const user = userInfo?.user;

    debugLog(`[NEW_WORK_CONN] User: ${clean(user)}, RunID: ${clean(run_id)}, ReqID: ${reqId}`);

    if (!validateUser(user, userInfo?.metas?.token)) {
        logThrottled(`workconn:${user}`, `[NEW_WORK_CONN] REJECTED - Credentials no longer valid for user: ${clean(user)}`);
        return rejectResponse('credentials are no longer valid');
    }

    return allowResponse();
}

// Handle NewUserConn operation
function handleNewUserConn(content, reqId) {
    const { user: userInfo, proxy_name, remote_addr } = content;
    const user = userInfo?.user;

    console.log(`[NEW_USER_CONN] User: ${clean(user)}, Proxy: ${clean(proxy_name)}, RemoteAddr: ${clean(remote_addr)}, ReqID: ${reqId}`);
    debugLog('NewUserConn content:', redactedJson(content));

    return allowResponse();
}

// ============================================
// Panel authentication
// ============================================

const PANEL_USER = process.env.PANEL_USER || 'admin';
let PANEL_PASSWORD = process.env.PANEL_PASSWORD || '';
let panelPasswordGenerated = false;
if (!PANEL_PASSWORD) {
    // Never run the panel open: without a configured password use a random one for this run.
    PANEL_PASSWORD = crypto.randomBytes(15).toString('base64url');
    panelPasswordGenerated = true;
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_COOKIE = 'fmdx_tunnel_session';
const MAX_SESSIONS = 1000;
const sessions = new Map(); // session id -> { user, expiresAt }

// Failed panel logins: per client (as reported by the reverse proxy) and per direct peer.
const panelClientLimiter = new FailureLimiter(10, 10 * 60 * 1000);
const panelPeerLimiter = new FailureLimiter(100, 10 * 60 * 1000);

function isHttps(req) {
    const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    return req.secure || forwarded === 'https';
}

// Over HTTPS the "__Host-" prefix stops sibling subdomains (the tunnels) from planting this cookie.
function sessionCookieName(req) {
    return isHttps(req) ? `__Host-${SESSION_COOKIE}` : SESSION_COOKIE;
}

function cookieValues(req, name) {
    const header = req.headers.cookie;
    if (typeof header !== 'string') return [];
    const values = [];
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        if (part.slice(0, eq).trim() === name) values.push(part.slice(eq + 1).trim());
    }
    return values;
}

function getSession(req) {
    const now = Date.now();
    for (const id of cookieValues(req, sessionCookieName(req))) {
        const session = sessions.get(id);
        if (!session) continue;
        if (now >= session.expiresAt) {
            sessions.delete(id);
            continue;
        }
        return { id, ...session };
    }
    return null;
}

function setSessionCookie(req, res, id, maxAgeSeconds) {
    const attrs = [
        `${sessionCookieName(req)}=${id}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Strict',
        `Max-Age=${maxAgeSeconds}`
    ];
    if (isHttps(req)) attrs.push('Secure');
    res.setHeader('Set-Cookie', attrs.join('; '));
}

function createSession(req, res) {
    const now = Date.now();
    if (sessions.size >= MAX_SESSIONS) {
        for (const [id, session] of sessions) {
            if (now >= session.expiresAt) sessions.delete(id);
        }
        // Still full: drop the oldest one (Map keeps insertion order).
        if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    }
    const id = crypto.randomBytes(32).toString('base64url');
    sessions.set(id, { user: PANEL_USER, expiresAt: now + SESSION_TTL_MS });
    setSessionCookie(req, res, id, Math.floor(SESSION_TTL_MS / 1000));
}

setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
        if (now >= session.expiresAt) sessions.delete(id);
    }
    tunnelLoginLimiter.prune(now);
    panelClientLimiter.prune(now);
    panelPeerLimiter.prune(now);
}, 60000).unref();

// Browsers label every request with its origin relation. Anything that is not the panel
// itself (other sites, sibling subdomains) has no business calling the API.
function fromForeignSite(req) {
    const site = req.headers['sec-fetch-site'];
    return typeof site === 'string' && site !== 'same-origin' && site !== 'none';
}

function requireAuth(req, res, next) {
    if (fromForeignSite(req)) {
        return res.status(403).json({ error: 'cross-site request refused' });
    }
    const session = getSession(req);
    if (!session) {
        return res.status(401).json({ error: 'authentication required' });
    }
    req.session = session;
    next();
}

// ============================================
// HTTP server
// ============================================

const app = express();
app.disable('x-powered-by');

// Security headers. The panel loads nothing but its own files and the web fonts.
const CONTENT_SECURITY_POLICY = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'"
].join('; ');

app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Browsers ignore this one (and log an error) on plain-HTTP origins
    if (isHttps(req)) res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    next();
});

// Middleware
app.use(express.json({ limit: '100kb' }));

// Debug logging with morgan (always enabled, filtered by isDebug)
app.use((req, res, next) => {
    if (isDebug()) {
        morgan('dev')(req, res, next);
    } else {
        next();
    }
});

// --- frps plugin endpoint (no panel login: frps cannot send credentials) ---

app.post(HANDLER_PATH, (req, res) => {
    // frps talks to this endpoint directly over the compose network. A request that
    // carries proxy headers came in through the panel's reverse proxy - not frps.
    if (req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || req.headers['forwarded'] || req.headers['x-real-ip'] || req.headers['via']) {
        return res.status(404).json({ error: 'not found' });
    }

    const reqId = clean(req.headers['x-frp-reqid'] || 'unknown', 64);
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json(rejectResponse('invalid request'));
    }
    const { version, op } = body;
    const content = body.content && typeof body.content === 'object' && !Array.isArray(body.content) ? body.content : {};

    debugLog(`=== Incoming request ===`);
    debugLog(`Version: ${clean(version)}, Operation: ${clean(op)}, ReqID: ${reqId}`);
    debugLog('Full body:', redactedJson(body));

    let response;

    switch (op) {
        case 'Login':
            response = handleLogin(content, reqId);
            break;
        case 'NewProxy':
            response = handleNewProxy(content, reqId);
            break;
        case 'CloseProxy':
            response = handleCloseProxy(content, reqId);
            break;
        case 'Ping':
            response = handlePing(content, reqId);
            break;
        case 'NewWorkConn':
            response = handleNewWorkConn(content, reqId);
            break;
        case 'NewUserConn':
            response = handleNewUserConn(content, reqId);
            break;
        default:
            console.log(`[HANDLER] Unknown operation: ${clean(op)}`);
            response = rejectResponse('unknown operation');
    }

    debugLog('Response:', JSON.stringify(response, null, 2));
    res.json(response);
});

// Health check endpoint (unauthenticated on purpose, so it says nothing else)
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// --- Panel pages and static files (no secrets in any of them) ---

const publicDir = path.join(__dirname, 'public');

app.get(['/', '/index.html'], (req, res, next) => {
    if (!getSession(req)) return res.redirect('/login');
    next();
});

app.get('/login', (req, res) => {
    if (getSession(req)) return res.redirect('/');
    res.sendFile(path.join(publicDir, 'login.html'));
});

app.use(express.static(publicDir));

// --- Login / logout ---

app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
});

function panelClientAddress(req) {
    const peer = req.socket.remoteAddress || 'unknown';
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
    return { peer, client: net.isIP(forwarded) ? forwarded : peer };
}

app.post('/api/login', (req, res) => {
    if (fromForeignSite(req)) {
        return res.status(403).json({ error: 'cross-site request refused' });
    }

    const { peer, client } = panelClientAddress(req);
    if (panelClientLimiter.blocked(client) || panelPeerLimiter.blocked(peer)) {
        logThrottled(`panel-blocked:${client}`, `[PANEL] Login blocked - too many failed attempts from ${clean(client, 64)}`);
        return res.status(429).json({ error: 'Too many failed attempts, try again later' });
    }

    const { username, password } = req.body || {};
    const userOk = safeEqual(PANEL_USER, typeof username === 'string' ? username : '');
    const passwordOk = safeEqual(PANEL_PASSWORD, typeof password === 'string' ? password : '');

    if (!userOk || !passwordOk || typeof username !== 'string' || typeof password !== 'string') {
        panelClientLimiter.fail(client);
        panelPeerLimiter.fail(peer);
        console.log(`[PANEL] Login FAILED from ${clean(client, 64)}`);
        return res.status(401).json({ error: 'Invalid username or password' });
    }

    panelClientLimiter.reset(client);
    createSession(req, res);
    console.log(`[PANEL] Login OK from ${clean(client, 64)}`);
    res.json({ success: true });
});

app.post('/api/logout', (req, res) => {
    if (fromForeignSite(req)) {
        return res.status(403).json({ error: 'cross-site request refused' });
    }
    const session = getSession(req);
    if (session) sessions.delete(session.id);
    setSessionCookie(req, res, '', 0);
    res.json({ success: true });
});

// Everything below needs a panel session
app.use('/api', requireAuth);
app.use('/debug', requireAuth);

app.get('/api/session', (req, res) => {
    res.json({ user: req.session.user });
});

// Server status for the panel header
app.get('/api/status', (req, res) => {
    res.json({
        status: 'ok',
        debug: isDebug(),
        users: userNames().length,
        lastConfigReload: lastConfigReload.toISOString()
    });
});

// ============================================
// API Endpoints for Token Management
// ============================================

// Get all tokens
app.get('/api/tokens', (req, res) => {
    const users = userNames().map(user => ({
        user,
        token: typeof config.users[user].token === 'string' ? config.users[user].token : '',
        subdomain: userSubdomain(user),
        lastLogin: loginActivity[user]?.lastLogin || null,
        lastIp: loginActivity[user]?.lastIp || null
    }));
    res.json({ users });
});

// Add new token
app.post('/api/tokens', (req, res) => {
    const { username, token } = req.body || {};

    if (typeof username !== 'string' || typeof token !== 'string' || !username || !token) {
        return res.status(400).json({ error: 'Username and token are required' });
    }

    // Validate username format
    if (!USERNAME_RE.test(username)) {
        return res.status(400).json({ error: 'Username must be 1-63 lowercase letters, numbers or hyphens and must not start or end with a hyphen' });
    }

    // Validate token format
    if (!TOKEN_RE.test(token)) {
        return res.status(400).json({ error: 'Token must be 8-32 characters: letters, numbers and _ . ~ ! @ # $ % ^ * + = : -' });
    }

    // Check if user already exists
    if (getUser(username)) {
        return res.status(409).json({ error: 'User already exists' });
    }

    // The new user gets the subdomain of the same name - make sure nobody else holds it
    if (userNames().some(name => userSubdomain(name) === username)) {
        return res.status(409).json({ error: 'Subdomain is already assigned to another user' });
    }

    // Add user
    config.users[username] = {
        token: token,
        subdomain: username
    };

    if (saveConfig()) {
        console.log(`[API] Added new user: ${username}`);
        res.json({ success: true, message: 'Token added successfully' });
    } else {
        res.status(500).json({ error: 'Failed to save configuration' });
    }
});

// Update token
app.put('/api/tokens/:username', (req, res) => {
    const { username } = req.params;
    const { token } = req.body || {};

    const userConfig = getUser(username);
    if (!userConfig) {
        return res.status(404).json({ error: 'User not found' });
    }

    if (typeof token !== 'string' || !TOKEN_RE.test(token)) {
        return res.status(400).json({ error: 'Token must be 8-32 characters: letters, numbers and _ . ~ ! @ # $ % ^ * + = : -' });
    }

    userConfig.token = token;

    if (saveConfig()) {
        console.log(`[API] Updated user: ${clean(username)}`);
        res.json({ success: true, message: 'Token updated successfully' });
    } else {
        res.status(500).json({ error: 'Failed to save configuration' });
    }
});

// Delete token
app.delete('/api/tokens/:username', (req, res) => {
    const { username } = req.params;

    if (!getUser(username)) {
        return res.status(404).json({ error: 'User not found' });
    }

    delete config.users[username];
    delete loginActivity[username];

    if (saveConfig()) {
        console.log(`[API] Deleted user: ${clean(username)}`);
        res.json({ success: true, message: 'Token deleted successfully' });
    } else {
        res.status(500).json({ error: 'Failed to save configuration' });
    }
});

// Generate random token
app.get('/api/generate-token', (req, res) => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let token = '';
    for (let i = 0; i < 20; i++) {
        token += chars.charAt(crypto.randomInt(chars.length));
    }
    res.json({ token });
});

// Get frontend configuration
app.get('/api/config', (req, res) => {
    res.json({
        tunnelDomain: TUNNEL_DOMAIN
    });
});

// ============================================
// Tunnel Status Check Endpoints
// ============================================

const TUNNEL_CHECK_TIMEOUT = 5000; // 5 seconds for the whole request, body included
const TUNNEL_CHECK_MAX_BYTES = 256 * 1024; // /static_data is a small JSON document
const TUNNEL_CHECK_CONCURRENCY = 8;
const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

class BodyTooLargeError extends Error {}

// Read a response body, giving up as soon as it exceeds maxBytes.
async function readBodyCapped(response, maxBytes) {
    if (!response.body) return '';
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body.cancel().catch(() => {});
        throw new BodyTooLargeError();
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new BodyTooLargeError();
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
}

// HTTP request to a tunnel. The far end is a user's machine, so nothing it sends is
// trusted: redirects are not followed, and one timer covers headers and body.
async function fetchTunnel(url, { readBody = false } = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TUNNEL_CHECK_TIMEOUT);

    try {
        const response = await fetch(url, {
            signal: controller.signal,
            redirect: 'manual',
            headers: {
                'Accept': 'application/json, text/html, */*',
                'User-Agent': 'FM-DX-Tunnel/1.0'
            }
        });
        let text = null;
        if (readBody && response.ok) {
            text = await readBodyCapped(response, TUNNEL_CHECK_MAX_BYTES);
        } else if (response.body) {
            await response.body.cancel().catch(() => {});
        }
        return { status: response.status, ok: response.ok, text };
    } finally {
        clearTimeout(timeoutId);
    }
}

function boundedString(value, max) {
    if (typeof value === 'string') return value.slice(0, max);
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return null;
}

// Check single tunnel status
async function checkTunnelStatus(subdomain) {
    if (typeof subdomain !== 'string' || !SUBDOMAIN_RE.test(subdomain)) {
        return {
            status: 'offline',
            type: 'invalid_subdomain',
            message: 'Subdomain is not a valid host name'
        };
    }

    const baseUrl = `https://${subdomain}.${TUNNEL_DOMAIN}`;
    const staticDataUrl = `${baseUrl}/static_data`;
    const rootUrl = baseUrl;

    try {
        // First, check /static_data endpoint
        const response = await fetchTunnel(staticDataUrl, { readBody: true });

        // If /static_data returns 404, check root to determine if tunnel is up but not fm-dx
        if (response.status === 404) {
            debugLog(`[TUNNEL_CHECK] ${subdomain}: /static_data returned 404, checking root...`);

            try {
                const rootResponse = await fetchTunnel(rootUrl);

                if (rootResponse.status === 404) {
                    // Both /static_data and / return 404 - tunnel is down (frps returns 404 for dead tunnels)
                    return {
                        status: 'offline',
                        type: 'tunnel_down',
                        message: 'Tunnel not connected'
                    };
                } else if (rootResponse.ok) {
                    // Root returns 200 but /static_data was 404 - something else is running
                    return {
                        status: 'warning',
                        type: 'not_fmdx',
                        message: 'Not an fm-dx-webserver (no /static_data endpoint)'
                    };
                } else {
                    // Root returns other error - something is there but broken
                    return {
                        status: 'warning',
                        type: 'not_fmdx',
                        message: `Not fm-dx-webserver (root: HTTP ${rootResponse.status})`
                    };
                }
            } catch (rootError) {
                // Can't reach root either - tunnel is down
                return {
                    status: 'offline',
                    type: 'tunnel_down',
                    message: 'Tunnel not connected'
                };
            }
        }

        // fm-dx-webserver answers /static_data directly; a redirect is something else
        if (response.status >= 300 && response.status < 400) {
            return {
                status: 'warning',
                type: 'not_fmdx',
                message: `Not fm-dx-webserver (/static_data redirects, HTTP ${response.status})`
            };
        }

        // Other non-OK status codes
        if (!response.ok) {
            return {
                status: 'error',
                type: 'http_error',
                httpStatus: response.status,
                message: `HTTP ${response.status}`
            };
        }

        // Try to parse as JSON
        let data;
        try {
            data = JSON.parse(response.text);
        } catch (parseError) {
            return {
                status: 'warning',
                type: 'not_fmdx',
                message: 'Response is not valid JSON - not an fm-dx-webserver'
            };
        }

        // Check if it looks like fm-dx-webserver response
        if (data && typeof data.tunerName === 'string') {
            return {
                status: 'online',
                type: 'fmdx',
                tunerName: data.tunerName.slice(0, 200),
                tunerDesc: boundedString(data.tunerDesc, 500),
                qthLatitude: boundedString(data.qthLatitude, 32),
                qthLongitude: boundedString(data.qthLongitude, 32)
            };
        } else {
            // Valid JSON but not fm-dx-webserver format
            return {
                status: 'warning',
                type: 'not_fmdx',
                message: 'Valid JSON but missing tunerName - probably not fm-dx-webserver'
            };
        }

    } catch (error) {
        if (error instanceof BodyTooLargeError) {
            return {
                status: 'warning',
                type: 'not_fmdx',
                message: 'Response too large - not an fm-dx-webserver'
            };
        }

        if (error.name === 'AbortError') {
            return {
                status: 'offline',
                type: 'timeout',
                message: 'Connection timeout'
            };
        }

        return {
            status: 'offline',
            type: 'connection_error',
            message: clean(error.message || 'Connection failed', 200)
        };
    }
}

// Check status for a single user's subdomain
app.get('/api/tunnel-status/:subdomain', async (req, res) => {
    const { subdomain } = req.params;

    // Only subdomains that belong to a configured user are ever contacted
    if (!userNames().some(name => userSubdomain(name) === subdomain)) {
        return res.status(404).json({ error: 'Unknown subdomain' });
    }

    debugLog(`[TUNNEL_CHECK] Checking status for subdomain: ${clean(subdomain)}`);

    const result = await checkTunnelStatus(subdomain);
    result.subdomain = subdomain;
    result.checkedAt = new Date().toISOString();

    debugLog(`[TUNNEL_CHECK] Result for ${clean(subdomain)}:`, JSON.stringify(result));

    res.json(result);
});

async function checkAllTunnels() {
    const users = userNames();
    const results = {};

    debugLog(`[TUNNEL_CHECK] Checking status for ${users.length} users`);

    // Check subdomains in parallel, a few at a time
    let next = 0;
    const worker = async () => {
        while (next < users.length) {
            const user = users[next++];
            const subdomain = userSubdomain(user);
            if (subdomain === undefined) continue; // user removed meanwhile

            const status = await checkTunnelStatus(subdomain);
            status.subdomain = subdomain;
            status.checkedAt = new Date().toISOString();
            results[user] = status;
        }
    };
    await Promise.all(Array.from({ length: Math.min(TUNNEL_CHECK_CONCURRENCY, users.length) }, worker));

    return {
        results,
        checkedAt: new Date().toISOString()
    };
}

// Check status for all users' subdomains.
// Overlapping requests (auto-refresh, several tabs) share one run.
let allTunnelsCheck = null;

app.get('/api/tunnel-status', async (req, res) => {
    if (!allTunnelsCheck) {
        allTunnelsCheck = checkAllTunnels().finally(() => {
            allTunnelsCheck = null;
        });
    }
    res.json(await allTunnelsCheck);
});

// Debug endpoint to view current config (only in debug mode)
app.get('/debug/config', (req, res) => {
    if (!isDebug()) {
        return res.status(403).json({ error: 'debug mode disabled' });
    }
    // Hide tokens in response
    const safeConfig = JSON.parse(JSON.stringify(config));
    if (safeConfig.users) {
        for (const user of Object.keys(safeConfig.users)) {
            safeConfig.users[user].token = '***hidden***';
        }
    }
    res.json(safeConfig);
});

app.get('/debug/users', (req, res) => {
    if (!isDebug()) {
        return res.status(403).json({ error: 'debug mode disabled' });
    }
    const users = userNames().map(user => ({
        user,
        subdomain: userSubdomain(user)
    }));
    res.json(users);
});

// Error handling middleware
app.use((err, req, res, next) => {
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
    const reason = status === 500 ? 'internal server error' : 'bad request';
    console.error('[ERROR]', clean(err.message, 300));
    debugLog('Error stack:', err.stack);
    // "reject" keeps frps failing closed if the plugin endpoint itself errors out
    res.status(status).json({ ...rejectResponse(reason), error: reason });
});

// Start server
app.listen(PORT, () => {
    console.log(`[SERVER] FM-DX-Tunnel started on port ${PORT}`);
    console.log(`[SERVER] Handler path: ${HANDLER_PATH}`);
    console.log(`[SERVER] Tunnel domain: ${TUNNEL_DOMAIN}`);
    console.log(`[SERVER] Web panel: http://localhost:${PORT}/`);
    console.log(`[SERVER] Debug mode: ${isDebug()}`);
    if (panelPasswordGenerated) {
        console.log('[PANEL] PANEL_PASSWORD is not set - generated a password for this run only:');
        console.log(`[PANEL]   user: ${PANEL_USER}   password: ${PANEL_PASSWORD}`);
        console.log('[PANEL] Set PANEL_PASSWORD in .env to choose your own.');
    } else {
        console.log(`[PANEL] Login enabled for user: ${PANEL_USER}`);
        if (PANEL_PASSWORD.length < 12) {
            console.warn('[PANEL] PANEL_PASSWORD is shorter than 12 characters - consider a longer one.');
        }
    }
});
