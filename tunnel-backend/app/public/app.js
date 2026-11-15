'use strict';

// FM-DX-Tunnel Manager panel.
//
// Everything that comes from the API or from a tunnel (user names, tokens, tuner
// names, error messages) is written with textContent into cloned <template>s.
// Do not build markup from such values with innerHTML.

(() => {
    // Configuration (loaded from server)
    let TUNNEL_DOMAIN = 'example.com';

    // State
    let currentMessage = '';
    let tunnelStatuses = new Map();
    let usersData = [];

    // Auto-refresh interval (30 seconds)
    const REFRESH_INTERVAL = 30000;

    const HOST_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

    const byId = (id) => document.getElementById(id);

    // Clone a <template> and fill its [data-f="name"] slots with plain text.
    function fromTemplate(id, values = {}) {
        const fragment = byId(id).content.cloneNode(true);
        for (const [name, value] of Object.entries(values)) {
            const slot = fragment.querySelector(`[data-f="${name}"]`);
            if (slot) slot.textContent = value === null || value === undefined ? '' : String(value);
        }
        return fragment;
    }

    // fetch() for the panel API; an expired session sends the browser to the login page.
    async function api(path, options = {}) {
        const response = await fetch(path, { credentials: 'same-origin', ...options });
        if (response.status === 401) {
            window.location.href = '/login';
            throw new Error('Not logged in');
        }
        return response;
    }

    // Load configuration from server
    async function loadConfig() {
        try {
            const response = await api('/api/config');
            const config = await response.json();
            TUNNEL_DOMAIN = config.tunnelDomain || 'example.com';
        } catch (error) {
            console.error('[CONFIG] Failed to load config, using default:', error);
        }
    }

    // Silent refresh (no toast, no spinner change)
    async function silentRefresh() {
        try {
            // Refresh tokens (for last login updates)
            const tokensResponse = await api('/api/tokens');
            const tokensData = await tokensResponse.json();
            usersData = tokensData.users || [];

            // Refresh tunnel status
            const statusResponse = await api('/api/tunnel-status');
            const statusData = await statusResponse.json();
            tunnelStatuses = new Map(Object.entries(statusData.results || {}));

            // Re-render
            renderTokens(usersData);
        } catch (error) {
            console.error('Silent refresh failed:', error);
        }
    }

    // Server status check
    async function checkServerStatus() {
        const dot = byId('serverStatusDot');
        const text = byId('serverStatusText');
        try {
            const response = await api('/api/status');
            const data = await response.json();
            if (data.status === 'ok') {
                dot.className = 'status-dot online';
                text.className = 'text-sm text-slate-400';
                text.textContent = `${data.users} tunnel${data.users !== 1 ? 's' : ''} • ${data.debug ? 'Debug' : 'Production'}`;
            }
        } catch (e) {
            dot.className = 'status-dot offline';
            text.className = 'text-sm text-slate-500';
            text.textContent = 'Connection error';
        }
    }

    // Toast notification
    function showToast(message, type = 'success') {
        const container = byId('toastContainer');
        const fragment = fromTemplate('tplToast', { message });
        const toast = fragment.firstElementChild;
        const kind = type === 'error' ? 'error' : 'success';
        toast.classList.add(kind);
        toast.querySelector(`[data-icon="${kind === 'error' ? 'success' : 'error'}"]`).remove();
        container.appendChild(fragment);

        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(100%)';
            toast.style.transition = 'all 0.3s ease';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    // Clipboard helper
    async function copyToClipboard(text) {
        if (navigator.clipboard && window.isSecureContext) {
            return navigator.clipboard.writeText(text);
        }

        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        textarea.style.top = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();

        return new Promise((resolve, reject) => {
            try {
                document.execCommand('copy');
                resolve();
            } catch (err) {
                reject(err);
            } finally {
                textarea.remove();
            }
        });
    }

    // Generate token from the browser's cryptographic random source
    function generateToken() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        const limit = 256 - (256 % chars.length); // reject the tail so every character is equally likely
        const bytes = new Uint8Array(32);
        let token = '';
        while (token.length < 20) {
            crypto.getRandomValues(bytes);
            for (const byte of bytes) {
                if (byte < limit && token.length < 20) {
                    token += chars.charAt(byte % chars.length);
                }
            }
        }
        byId('token').value = token;
    }

    // Mask token
    function maskToken(token) {
        return '•'.repeat(Math.min(token.length, 20));
    }

    // Load tokens
    async function loadTokens() {
        try {
            const response = await api('/api/tokens');
            const data = await response.json();
            usersData = data.users || [];
            renderTokens(usersData);
            // Auto-fetch tunnel status after loading tokens
            fetchTunnelStatus();
        } catch (error) {
            byId('tokenList').replaceChildren(fromTemplate('tplLoadError'));
            byId('tokenCount').textContent = 'Error';
        }
    }

    // Fetch tunnel status for all users
    async function fetchTunnelStatus() {
        try {
            const response = await api('/api/tunnel-status');
            const data = await response.json();
            tunnelStatuses = new Map(Object.entries(data.results || {}));
            // Re-render with status
            renderTokens(usersData);
        } catch (error) {
            console.error('Failed to fetch tunnel status:', error);
        }
    }

    // Refresh tunnel status (manual button)
    async function refreshTunnelStatus() {
        const icon = byId('refreshIcon');
        icon.classList.add('animate-spin');

        await fetchTunnelStatus();

        setTimeout(() => {
            icon.classList.remove('animate-spin');
        }, 500);

        showToast('Tunnel status refreshed');
    }

    // Render tunnel status cell
    function renderTunnelStatus(user) {
        const status = tunnelStatuses.get(user);

        if (!status) {
            return fromTemplate('tplStatusChecking');
        }

        if (status.status === 'online' && status.type === 'fmdx') {
            // FM-DX Webserver online
            const fullName = String(status.tunerName || '');
            const tunerName = fullName.length > 30 ? fullName.substring(0, 30) + '...' : fullName;
            const fragment = fromTemplate('tplStatusOnline', { tunerName });
            fragment.querySelector('[data-f="tunerName"]').title = fullName;
            const link = fragment.querySelector('[data-link="tunnel"]');
            if (HOST_LABEL_RE.test(String(status.subdomain || ''))) {
                link.href = `https://${status.subdomain}.${TUNNEL_DOMAIN}`;
            }
            return fragment;
        }

        if (status.status === 'warning' && status.type === 'not_fmdx') {
            // Something else is running (not FM-DX)
            return fromTemplate('tplStatusWarning', { title: '⚠️ NOT FM-DX!', message: status.message });
        }

        if (status.status === 'error' && status.type === 'http_error') {
            // HTTP error
            return fromTemplate('tplStatusWarning', { title: '⚠️ HTTP Error', message: status.message });
        }

        if (status.type === 'wildcard') {
            // Wildcard subdomain
            return fromTemplate('tplStatusWildcard');
        }

        if (status.type === 'tunnel_down') {
            // Tunnel is down (frps returns 404 on both / and /static_data)
            return fromTemplate('tplStatusOffline', { title: 'Tunnel Down', message: 'Not connected to server' });
        }

        // Offline / connection error / timeout
        return fromTemplate('tplStatusOffline', { title: 'Offline', message: status.message || 'Not connected' });
    }

    // Render tokens
    function renderTokens(users) {
        const countEl = byId('tokenCount');
        const list = byId('tokenList');

        if (!users || users.length === 0) {
            list.replaceChildren(fromTemplate('tplEmpty'));
            countEl.textContent = '0 tokens';
            return;
        }

        countEl.textContent = `${users.length} token${users.length !== 1 ? 's' : ''}`;

        const rows = document.createDocumentFragment();
        users.forEach((user) => {
            const token = String(user.token || '');
            const fragment = fromTemplate('tplRow', {
                user: user.user,
                tokenMask: maskToken(token),
                token,
                subdomain: user.subdomain || user.user
            });

            // The click handler looks the user up by name; the token never goes into an attribute
            fragment.querySelector('tr').dataset.user = user.user;

            fragment.querySelector('[data-slot="status"]').appendChild(renderTunnelStatus(user.user));
            fragment.querySelector('[data-slot="lastLogin"]').appendChild(
                user.lastLogin
                    ? fromTemplate('tplLastLogin', { when: formatDate(user.lastLogin), ip: user.lastIp || '' })
                    : fromTemplate('tplNeverLogin')
            );

            rows.appendChild(fragment);
        });

        list.replaceChildren(rows);
    }

    // Format date
    function formatDate(isoString) {
        const date = new Date(isoString);
        if (Number.isNaN(date.getTime())) return 'Unknown';
        const now = new Date();
        const diff = now - date;

        if (diff < 60000) return 'Just now';
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
        if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;

        return date.toLocaleDateString('en-GB', {
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    // Copy token
    function copyToken(token) {
        copyToClipboard(token)
            .then(() => showToast('Token copied to clipboard'))
            .catch(() => showToast('Failed to copy', 'error'));
    }

    // Add token
    async function addToken(e) {
        e.preventDefault();
        const username = byId('username').value.toLowerCase().trim();
        const token = byId('token').value.trim();

        try {
            const response = await api('/api/tokens', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, token })
            });

            if (response.ok) {
                showToast(`Token for "${username}" created successfully`);
                byId('addTokenForm').reset();
                loadTokens();
                checkServerStatus();
            } else {
                const data = await response.json().catch(() => ({}));
                showToast(data.error || 'Failed to create token', 'error');
            }
        } catch (error) {
            showToast('Connection error', 'error');
        }
    }

    // Delete token
    async function deleteToken(username) {
        if (!confirm(`Are you sure you want to delete the token for "${username}"?\n\nThis action cannot be undone.`)) return;

        try {
            const response = await api(`/api/tokens/${encodeURIComponent(username)}`, { method: 'DELETE' });

            if (response.ok) {
                showToast(`Token for "${username}" deleted`);
                loadTokens();
                checkServerStatus();
            } else {
                showToast('Failed to delete token', 'error');
            }
        } catch (error) {
            showToast('Connection error', 'error');
        }
    }

    // Show message modal
    function showMessage(username, token) {
        currentMessage = `🔧 Tunnel Configuration for ${username}

1️⃣ Configure in webserver (Extras → Tunnel):
- Enable **Tunnel** checkbox
- Enable **Use a community tunnel** checkbox
- Tunnel Domain:  \`${TUNNEL_DOMAIN}\`
- Username:  \`${username}\`
- Subdomain: \`${username}\`
- Token:     \`${token}\`

2️⃣ Your tunnel URL:
🌐 https://${username}.${TUNNEL_DOMAIN}
`;

        byId('messageContent').textContent = currentMessage;
        byId('messageModal').classList.remove('hidden');
        document.body.style.overflow = 'hidden';
    }

    // Close modal
    function closeModal() {
        byId('messageModal').classList.add('hidden');
        document.body.style.overflow = '';
    }

    // Copy message
    function copyMessage() {
        copyToClipboard(currentMessage)
            .then(() => {
                showToast('Configuration copied to clipboard');
                closeModal();
            })
            .catch(() => showToast('Failed to copy', 'error'));
    }

    // Log out
    async function logout() {
        try {
            await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
        } catch (error) {
            // the session cookie expires on its own
        }
        window.location.href = '/login';
    }

    // Row actions: one listener on the table instead of handlers built into the markup
    function onTokenListClick(e) {
        const target = e.target.closest('[data-action]');
        if (!target) return;
        const row = target.closest('tr[data-user]');
        if (!row) return;
        const user = usersData.find((u) => u.user === row.dataset.user);
        if (!user) return;

        switch (target.dataset.action) {
            case 'copy-token':
                copyToken(String(user.token || ''));
                break;
            case 'info':
                showMessage(user.user, String(user.token || ''));
                break;
            case 'delete':
                deleteToken(user.user);
                break;
        }
    }

    // DOM Ready
    document.addEventListener('DOMContentLoaded', async () => {
        byId('refreshBtn').addEventListener('click', refreshTunnelStatus);
        byId('generateBtn').addEventListener('click', generateToken);
        byId('logoutBtn').addEventListener('click', logout);
        byId('copyMessageBtn').addEventListener('click', copyMessage);
        byId('addTokenForm').addEventListener('submit', addToken);
        byId('tokenList').addEventListener('click', onTokenListClick);
        byId('messageModal').addEventListener('click', (e) => {
            if (e.target.closest('[data-action="close-modal"]')) closeModal();
        });

        // Close modal on Escape
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeModal();
        });

        // Load config first (get tunnel domain from server)
        await loadConfig();

        loadTokens();
        checkServerStatus();

        // Start auto-refresh
        setInterval(() => {
            silentRefresh();
        }, REFRESH_INTERVAL);
    });
})();
