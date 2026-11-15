'use strict';

(() => {
    const form = document.getElementById('loginForm');
    const errorEl = document.getElementById('loginError');
    const button = document.getElementById('loginBtn');

    function showError(message) {
        errorEl.textContent = message;
        errorEl.classList.remove('hidden');
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errorEl.classList.add('hidden');
        button.disabled = true;

        try {
            const response = await fetch('/api/login', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: document.getElementById('username').value,
                    password: document.getElementById('password').value
                })
            });

            if (response.ok) {
                window.location.replace('/');
                return;
            }

            const data = await response.json().catch(() => ({}));
            showError(data.error || 'Login failed');
        } catch (error) {
            showError('Connection error');
        } finally {
            button.disabled = false;
        }
    });
})();
