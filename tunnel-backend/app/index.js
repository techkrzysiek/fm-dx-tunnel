const express = require('express');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const morgan = require('morgan');

// Load configuration
const configPath = process.env.CONFIG_PATH || './config.yaml';
let config;

// Track login activity (in memory, persisted to config)
let loginActivity = {};

function loadConfig() {
    try {
        const newConfig = yaml.load(fs.readFileSync(configPath, 'utf8'));
        config = newConfig;
        
        // Load login activity from config
        if (config.users) {
            for (const user in config.users) {
                if (config.users[user].lastLogin) {
                    loginActivity[user] = {
                        lastLogin: config.users[user].lastLogin,
                        lastIp: config.users[user].lastIp
                    };
                }
            }
        }
        
        console.log('[CONFIG] Loaded configuration from', configPath);
        console.log('[CONFIG] Loaded', Object.keys(config.users || {}).length, 'users');
        return true;
    } catch (e) {
        console.error('[CONFIG] Error loading config:', e.message);
        return false;
    }
}

function adminAuth(req, res, next) {
    const authHeader = req.headers['authorization'];
    const adminUser = config.admin?.username;
    const adminPass = config.admin?.password;

    if (!adminUser || !adminPass) {
        return next();
    }

    if (!authHeader) {
        res.set('WWW-Authenticate', 'Basic realm="admin"');
        return res.status(401).send('Authentication required.');
    }

    const base64Credentials = authHeader.split(' ')[1];
    const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
    const [username, password] = credentials.split(':');

    if (username === adminUser && password === adminPass) {
        return next();
    }

    res.set('WWW-Authenticate', 'Basic realm="admin"');
    return res.status(401).send('Invalid credentials.');
}

function saveConfig() {
    try {
        // Merge login activity into config before saving
        if (config.users) {
            for (const user in config.users) {
                if (loginActivity[user]) {
                    config.users[user].lastLogin = loginActivity[user].lastLogin;
                    config.users[user].lastIp = loginActivity[user].lastIp;
                }
            }
        }
        
        fs.writeFileSync(configPath, yaml.dump(config, { 
            indent: 2,
            lineWidth: -1,
            noRefs: true
        }));
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

// Watch for config file changes
let reloadTimeout = null;
const RELOAD_DEBOUNCE_MS = 1000;

function watchConfig() {
    try {
        fs.watch(configPath, (eventType, filename) => {
            // Debounce to prevent multiple reloads on rapid changes
            if (reloadTimeout) {
                clearTimeout(reloadTimeout);
            }
            
            reloadTimeout = setTimeout(() => {
                console.log('[CONFIG] Detected change in config file, reloading...');
                if (loadConfig()) {
                    lastConfigReload = new Date();
                    console.log('[CONFIG] Configuration reloaded successfully');
                } else {
                    console.error('[CONFIG] Failed to reload config, keeping previous configuration');
                }
            }, RELOAD_DEBOUNCE_MS);
        });
        console.log('[CONFIG] Watching for config file changes:', configPath);
    } catch (e) {
        console.error('[CONFIG] Could not watch config file:', e.message);
    }
}

// Track config reload time
let lastConfigReload = new Date();

watchConfig();

const app = express();
const PORT = config.server?.port || 7002;
const PATH = config.server?.path || '/handler';

// Dynamic debug check
function isDebug() {
    return config.debug || false;
}

// Middleware
app.use(express.json());
app.use(['/api', '/debug'], adminAuth);
app.use(express.static(path.join(__dirname, 'public')));

// Debug logging with morgan (always enabled, filtered by isDebug)
app.use((req, res, next) => {
    if (isDebug()) {
        morgan('dev')(req, res, next);
    } else {
        next();
    }
});

// Custom debug logger
function debugLog(...args) {
    if (isDebug()) {
        console.log('[DEBUG]', new Date().toISOString(), ...args);
    }
}

// Validate user credentials
function validateUser(user, token) {
    const userConfig = config.users?.[user];
    if (!userConfig) {
        debugLog(`User '${user}' not found in config`);
        return false;
    }
    
    if (userConfig.token !== token) {
        debugLog(`Invalid token for user '${user}'`);
        return false;
    }
    
    debugLog(`User '${user}' authenticated successfully`);
    return true;
}

// Validate subdomain for user
function validateSubdomain(user, subdomain) {
    const userConfig = config.users?.[user];
    if (!userConfig) {
        debugLog(`User '${user}' not found for subdomain check`);
        return false;
    }
    
    const allowedSubdomain = userConfig.subdomain || user;
    
    // Check if subdomain matches
    if (allowedSubdomain === subdomain) {
        debugLog(`Subdomain '${subdomain}' allowed for user '${user}'`);
        return true;
    }
    
    debugLog(`Subdomain '${subdomain}' not allowed for user '${user}'. Allowed: ${allowedSubdomain}`);
    return false;
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
    const { user, metas, client_address } = content;
    const token = metas?.token;
    
    console.log(`[LOGIN] User: ${user}, IP: ${client_address}, ReqID: ${reqId}`);
    debugLog('Login content:', JSON.stringify(content, null, 2));
    
    if (!user) {
        console.log(`[LOGIN] REJECTED - Missing user`);
        return rejectResponse('missing user');
    }
    
    if (!token) {
        console.log(`[LOGIN] REJECTED - Missing token for user: ${user}`);
        return rejectResponse('missing token');
    }
    
    if (!validateUser(user, token)) {
        console.log(`[LOGIN] REJECTED - Invalid credentials for user: ${user}`);
        return rejectResponse('invalid credentials');
    }
    
    // Track login activity
    const ip = client_address ? client_address.split(':')[0] : 'unknown';
    updateLoginActivity(user, ip);
    
    console.log(`[LOGIN] ACCEPTED - User: ${user}`);
    return allowResponse();
}

// Handle NewProxy operation
function handleNewProxy(content, reqId) {
    const { user: userInfo, proxy_name, proxy_type, subdomain, custom_domains } = content;
    const user = userInfo?.user;
    
    console.log(`[NEW_PROXY] User: ${user}, Proxy: ${proxy_name}, Type: ${proxy_type}, ReqID: ${reqId}`);
    debugLog('NewProxy content:', JSON.stringify(content, null, 2));
    
    if (!user) {
        console.log(`[NEW_PROXY] REJECTED - Missing user info`);
        return rejectResponse('missing user info');
    }
    
    // Validate subdomain if present (for http/https proxies)
    if (subdomain) {
        if (!validateSubdomain(user, subdomain)) {
            console.log(`[NEW_PROXY] REJECTED - Subdomain '${subdomain}' not allowed for user: ${user}`);
            return rejectResponse(`subdomain '${subdomain}' not allowed for this user`);
        }
    }
    
    // Validate custom domains if present
    if (custom_domains && Array.isArray(custom_domains)) {
        for (const domain of custom_domains) {
            // Extract subdomain from custom domain if needed
            debugLog(`Custom domain: ${domain}`);
        }
    }
    
    console.log(`[NEW_PROXY] ACCEPTED - User: ${user}, Proxy: ${proxy_name}`);
    return allowResponse();
}

// Handle CloseProxy operation
function handleCloseProxy(content, reqId) {
    const { user: userInfo, proxy_name } = content;
    const user = userInfo?.user;
    
    console.log(`[CLOSE_PROXY] User: ${user}, Proxy: ${proxy_name}, ReqID: ${reqId}`);
    debugLog('CloseProxy content:', JSON.stringify(content, null, 2));
    
    return allowResponse();
}

// Handle Ping operation
function handlePing(content, reqId) {
    const { user: userInfo } = content;
    const user = userInfo?.user;
    
    debugLog(`[PING] User: ${user}, ReqID: ${reqId}`);
    
    return allowResponse();
}

// Handle NewWorkConn operation
function handleNewWorkConn(content, reqId) {
    const { user: userInfo, run_id } = content;
    const user = userInfo?.user;
    
    debugLog(`[NEW_WORK_CONN] User: ${user}, RunID: ${run_id}, ReqID: ${reqId}`);
    
    return allowResponse();
}

// Handle NewUserConn operation
function handleNewUserConn(content, reqId) {
    const { user: userInfo, proxy_name, proxy_type, remote_addr } = content;
    const user = userInfo?.user;
    
    console.log(`[NEW_USER_CONN] User: ${user}, Proxy: ${proxy_name}, RemoteAddr: ${remote_addr}, ReqID: ${reqId}`);
    debugLog('NewUserConn content:', JSON.stringify(content, null, 2));
    
    return allowResponse();
}

// Main handler endpoint
app.post(PATH, (req, res) => {
    const reqId = req.headers['x-frp-reqid'] || 'unknown';
    const { version, op, content } = req.body;
    
    debugLog(`=== Incoming request ===`);
    debugLog(`Version: ${version}, Operation: ${op}, ReqID: ${reqId}`);
    debugLog('Full body:', JSON.stringify(req.body, null, 2));
    
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
            console.log(`[HANDLER] Unknown operation: ${op}`);
            response = rejectResponse(`unknown operation: ${op}`);
    }
    
    debugLog('Response:', JSON.stringify(response, null, 2));
    res.json(response);
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        debug: isDebug(),
        users: Object.keys(config.users || {}).length,
        lastConfigReload: lastConfigReload.toISOString()
    });
});

// ============================================
// API Endpoints for Token Management
// ============================================

// Get all tokens
app.get('/api/tokens', (req, res) => {
    const users = Object.keys(config.users || {}).map(user => ({
        user,
        token: config.users[user].token,
        subdomain: config.users[user].subdomain || user,
        lastLogin: loginActivity[user]?.lastLogin || null,
        lastIp: loginActivity[user]?.lastIp || null
    }));
    res.json({ users });
});

// Add new token
app.post('/api/tokens', (req, res) => {
    const { username, token } = req.body;
    
    if (!username || !token) {
        return res.status(400).json({ error: 'Username and token are required' });
    }
    
    // Validate username format
    if (!/^[a-z0-9-]+$/.test(username)) {
        return res.status(400).json({ error: 'Username must contain only lowercase letters, numbers and hyphens' });
    }
    
    // Validate token length
    if (token.length < 8 || token.length > 32) {
        return res.status(400).json({ error: 'Token must be 8-32 characters' });
    }
    
    // Check if user already exists
    if (config.users && config.users[username]) {
        return res.status(409).json({ error: 'User already exists' });
    }
    
    // Add user
    if (!config.users) {
        config.users = {};
    }
    
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
    const { token } = req.body;
    
    if (!config.users || !config.users[username]) {
        return res.status(404).json({ error: 'User not found' });
    }
    
    if (token) {
        if (token.length < 8 || token.length > 32) {
            return res.status(400).json({ error: 'Token must be 8-32 characters' });
        }
        config.users[username].token = token;
    }
    
    if (saveConfig()) {
        console.log(`[API] Updated user: ${username}`);
        res.json({ success: true, message: 'Token updated successfully' });
    } else {
        res.status(500).json({ error: 'Failed to save configuration' });
    }
});

// Delete token
app.delete('/api/tokens/:username', (req, res) => {
    const { username } = req.params;
    
    if (!config.users || !config.users[username]) {
        return res.status(404).json({ error: 'User not found' });
    }
    
    delete config.users[username];
    delete loginActivity[username];
    
    if (saveConfig()) {
        console.log(`[API] Deleted user: ${username}`);
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
        token += chars.charAt(Math.floor(Math.random() * chars.length));
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

const TUNNEL_DOMAIN = process.env.TUNNEL_DOMAIN || 'example.com';
const TUNNEL_CHECK_TIMEOUT = 5000; // 5 seconds timeout

// Helper function to make HTTP request with timeout
async function fetchWithTimeout(url, timeout = TUNNEL_CHECK_TIMEOUT) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                'Accept': 'application/json, text/html, */*',
                'User-Agent': 'FM-DX-Tunnel/1.0'
            }
        });
        clearTimeout(timeoutId);
        return response;
    } catch (error) {
        clearTimeout(timeoutId);
        throw error;
    }
}

// Check single tunnel status
async function checkTunnelStatus(subdomain) {
    const baseUrl = `https://${subdomain}.${TUNNEL_DOMAIN}`;
    const staticDataUrl = `${baseUrl}/static_data`;
    const rootUrl = baseUrl;
    
    try {
        // First, check /static_data endpoint
        const response = await fetchWithTimeout(staticDataUrl);
        
        // If /static_data returns 404, check root to determine if tunnel is up but not fm-dx
        if (response.status === 404) {
            debugLog(`[TUNNEL_CHECK] ${subdomain}: /static_data returned 404, checking root...`);
            
            try {
                const rootResponse = await fetchWithTimeout(rootUrl);
                
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
            data = await response.json();
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
                tunerName: data.tunerName,
                tunerDesc: data.tunerDesc || null,
                qthLatitude: data.qthLatitude || null,
                qthLongitude: data.qthLongitude || null
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
            message: error.message || 'Connection failed'
        };
    }
}

// Check status for a single user's subdomain
app.get('/api/tunnel-status/:subdomain', async (req, res) => {
    const { subdomain } = req.params;
    
    debugLog(`[TUNNEL_CHECK] Checking status for subdomain: ${subdomain}`);
    
    const result = await checkTunnelStatus(subdomain);
    result.subdomain = subdomain;
    result.checkedAt = new Date().toISOString();
    
    debugLog(`[TUNNEL_CHECK] Result for ${subdomain}:`, JSON.stringify(result));
    
    res.json(result);
});

// Check status for all users' subdomains
app.get('/api/tunnel-status', async (req, res) => {
    const users = Object.keys(config.users || {});
    const results = {};
    
    debugLog(`[TUNNEL_CHECK] Checking status for ${users.length} users`);
    
    // Check all subdomains in parallel
    const promises = users.map(async (user) => {
        const userSubdomain = config.users[user].subdomain || user;
        
        const status = await checkTunnelStatus(userSubdomain);
        status.subdomain = userSubdomain;
        status.checkedAt = new Date().toISOString();
        results[user] = status;
    });
    
    await Promise.all(promises);
    
    res.json({ 
        results,
        checkedAt: new Date().toISOString()
    });
});

// Debug endpoint to view current config (only in debug mode)
app.get('/debug/config', (req, res) => {
    if (!isDebug()) {
        return res.status(403).json({ error: 'debug mode disabled' });
    }
    // Hide tokens in response
    const safeConfig = JSON.parse(JSON.stringify(config));
    if (safeConfig.users) {
        for (const user in safeConfig.users) {
            safeConfig.users[user].token = '***hidden***';
        }
    }
    res.json(safeConfig);
});

app.get('/debug/users', (req, res) => {
    if (!isDebug()) {
        return res.status(403).json({ error: 'debug mode disabled' });
    }
    const users = Object.keys(config.users || {}).map(user => ({
        user,
        subdomain: config.users[user].subdomain || user
    }));
    res.json(users);
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('[ERROR]', err.message);
    debugLog('Error stack:', err.stack);
    res.status(500).json(rejectResponse('internal server error'));
});

// Start server
app.listen(PORT, () => {
    console.log(`[SERVER] FM-DX-Tunnel started on port ${PORT}`);
    console.log(`[SERVER] Handler path: ${PATH}`);
    console.log(`[SERVER] Tunnel domain: ${TUNNEL_DOMAIN}`);
    console.log(`[SERVER] Web panel: http://localhost:${PORT}/`);
    console.log(`[SERVER] Debug mode: ${isDebug()}`);
});

