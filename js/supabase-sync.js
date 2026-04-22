// AgriEID — Supabase Cloud Sync with Offline Queue + Auth
// Records are always saved locally first (localStorage).
// When online, pending records are synced to Supabase.
// User authenticates via email/password for secure access.

const SUPABASE_CONFIG_KEY = 'agrieid_supabase_config';
const SYNC_QUEUE_KEY = 'agrieid_sync_queue';
const AUTH_TOKEN_KEY = 'agrieid_auth_token';

// Default Supabase project (ae-weighapp)
const DEFAULT_SUPABASE_URL = 'https://ulysnzsvuaakntlsetxg.supabase.co';
const DEFAULT_SUPABASE_KEY = 'sb_publishable_z_RYe6guuq3Pc9P6f0PYXA_B54Lwmrm';

export class SupabaseSync extends EventTarget {
    constructor() {
        super();
        this._client = null;
        this._config = null;
        this._syncInterval = null;
        this._syncing = false;
        this._online = navigator.onLine;
        this._authToken = null;
        this._authUser = null;

        // Listen for online/offline events
        window.addEventListener('online', () => {
            this._online = true;
            this._emit('status', { online: true });
            this.syncPending();
        });
        window.addEventListener('offline', () => {
            this._online = false;
            this._emit('status', { online: false });
        });
    }

    // ── Configuration ────────────────────────────────────────
    loadConfig() {
        try {
            const raw = localStorage.getItem(SUPABASE_CONFIG_KEY);
            if (raw) {
                this._config = JSON.parse(raw);
                return this._config;
            }
        } catch (_) {}
        // Fall back to default config
        if (DEFAULT_SUPABASE_URL && DEFAULT_SUPABASE_KEY) {
            this._config = { url: DEFAULT_SUPABASE_URL, anonKey: DEFAULT_SUPABASE_KEY };
            return this._config;
        }
        return null;
    }

    saveConfig(url, anonKey) {
        this._config = { url: url.replace(/\/$/, ''), anonKey };
        localStorage.setItem(SUPABASE_CONFIG_KEY, JSON.stringify(this._config));
        this._client = null;
        return this._config;
    }

    isConfigured() {
        if (!this._config) this.loadConfig();
        return !!(this._config?.url && this._config?.anonKey);
    }

    // ── Authentication ───────────────────────────────────────
    loadAuthToken() {
        try {
            const raw = localStorage.getItem(AUTH_TOKEN_KEY);
            if (raw) {
                const auth = JSON.parse(raw);
                // Check if token is expired
                if (auth.expires_at && Date.now() / 1000 > auth.expires_at) {
                    // Token expired — try to refresh
                    if (auth.refresh_token) {
                        this._refreshToken(auth.refresh_token).catch(() => {
                            this._clearAuth();
                        });
                    } else {
                        this._clearAuth();
                    }
                    return null;
                }
                this._authToken = auth.access_token;
                this._authUser = auth.user;
                return auth;
            }
        } catch (_) {}
        return null;
    }

    _saveAuthToken(data) {
        this._authToken = data.access_token;
        this._authUser = data.user;
        localStorage.setItem(AUTH_TOKEN_KEY, JSON.stringify({
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            expires_at: data.expires_at,
            user: data.user,
        }));
    }

    _clearAuth() {
        this._authToken = null;
        this._authUser = null;
        localStorage.removeItem(AUTH_TOKEN_KEY);
    }

    isLoggedIn() {
        if (!this._authToken) this.loadAuthToken();
        return !!this._authToken;
    }

    getUser() {
        if (!this._authUser) this.loadAuthToken();
        return this._authUser;
    }

    async login(email, password) {
        if (!this.isConfigured()) this.loadConfig();
        if (!this._config) throw new Error('Cloud not configured');

        const response = await fetch(`${this._config.url}/auth/v1/token?grant_type=password`, {
            method: 'POST',
            headers: {
                'apikey': this._config.anonKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ email, password }),
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error_description || err.msg || `Login failed (${response.status})`);
        }

        const data = await response.json();
        this._saveAuthToken(data);
        this._emit('auth', { loggedIn: true, user: data.user });
        return data;
    }

    async logout() {
        if (this._authToken && this.isConfigured()) {
            try {
                await fetch(`${this._config.url}/auth/v1/logout`, {
                    method: 'POST',
                    headers: {
                        'apikey': this._config.anonKey,
                        'Authorization': `Bearer ${this._authToken}`,
                    },
                });
            } catch (_) {
                // Logout API call failed — clear locally anyway
            }
        }
        this._clearAuth();
        this.stopAutoSync();
        this._emit('auth', { loggedIn: false, user: null });
    }

    async _refreshToken(refreshToken) {
        if (!this.isConfigured()) return;

        const response = await fetch(`${this._config.url}/auth/v1/token?grant_type=refresh_token`, {
            method: 'POST',
            headers: {
                'apikey': this._config.anonKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ refresh_token: refreshToken }),
        });

        if (!response.ok) {
            this._clearAuth();
            this._emit('auth', { loggedIn: false, user: null });
            throw new Error('Token refresh failed');
        }

        const data = await response.json();
        this._saveAuthToken(data);
        return data;
    }

    // ── Supabase REST Client (no SDK needed) ─────────────────
    _headers() {
        const token = this._authToken || this._config.anonKey;
        return {
            'apikey': this._config.anonKey,
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation',
        };
    }

    async _request(method, table, options = {}) {
        if (!this.isConfigured()) throw new Error('Supabase not configured');

        let url = `${this._config.url}/rest/v1/${table}`;

        // Add query params
        if (options.query) {
            const params = new URLSearchParams(options.query);
            url += `?${params}`;
        }

        const fetchOptions = {
            method,
            headers: this._headers(),
        };

        if (options.body) {
            fetchOptions.body = JSON.stringify(options.body);
        }

        // For upserts
        if (options.upsert) {
            fetchOptions.headers['Prefer'] = 'return=representation,resolution=merge-duplicates';
        }

        const response = await fetch(url, fetchOptions);

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Supabase ${method} ${table}: ${response.status} — ${errText}`);
        }

        const text = await response.text();
        return text ? JSON.parse(text) : null;
    }

    // ── Sync Queue ───────────────────────────────────────────
    _getQueue() {
        try {
            const raw = localStorage.getItem(SYNC_QUEUE_KEY);
            return raw ? JSON.parse(raw) : [];
        } catch (_) {
            return [];
        }
    }

    _saveQueue(queue) {
        localStorage.setItem(SYNC_QUEUE_KEY, JSON.stringify(queue));
    }

    queueRecord(action, table, data) {
        const queue = this._getQueue();
        queue.push({
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            action,    // 'upsert_session' | 'upsert_record' | 'delete_record'
            table,
            data,
            createdAt: new Date().toISOString(),
            retries: 0,
        });
        this._saveQueue(queue);
        this._emit('queue', { pending: queue.length });

        // Try to sync immediately if online
        if (this._online && this.isConfigured()) {
            this.syncPending();
        }
    }

    getPendingCount() {
        return this._getQueue().length;
    }

    // ── Sync Engine ──────────────────────────────────────────
    async syncPending() {
        if (this._syncing || !this._online || !this.isConfigured()) return;
        this._syncing = true;
        this._emit('syncStart');

        const queue = this._getQueue();
        const completed = [];
        let errors = 0;

        for (const item of queue) {
            try {
                switch (item.action) {
                    case 'upsert_session':
                        await this._request('POST', 'sessions', {
                            body: item.data,
                            upsert: true,
                        });
                        break;

                    case 'upsert_record':
                        await this._request('POST', 'records', {
                            body: item.data,
                            upsert: true,
                        });
                        break;

                    case 'delete_record':
                        await this._request('DELETE', 'records', {
                            query: { local_id: `eq.${item.data.local_id}` },
                        });
                        break;

                    default:
                        console.warn('[Sync] Unknown action:', item.action);
                }
                completed.push(item.id);
            } catch (err) {
                console.error('[Sync] Failed:', item.action, err.message);
                item.retries++;
                errors++;
                // Drop items that have failed too many times
                if (item.retries > 10) {
                    console.warn('[Sync] Dropping item after 10 retries:', item);
                    completed.push(item.id);
                }
            }
        }

        // Remove completed items from queue
        const remaining = queue.filter((q) => !completed.includes(q.id));
        this._saveQueue(remaining);

        this._syncing = false;
        this._emit('syncComplete', {
            synced: completed.length,
            remaining: remaining.length,
            errors,
        });
        this._emit('queue', { pending: remaining.length });
    }

    // ── Push All Local Data to Cloud ─────────────────────────
    async pushAll() {
        if (!this.isConfigured() || !this._online) {
            throw new Error('Not connected');
        }

        // Get all sessions and records from localStorage
        const sessionsRaw = localStorage.getItem('agrieid_sessions');
        const sessions = sessionsRaw ? JSON.parse(sessionsRaw) : [];
        let totalPushed = 0;

        for (const session of sessions) {
            // Push session
            const sessionData = {
                local_id: session.id,
                name: session.name || '',
                mob: session.mob || '',
                paddock: session.paddock || '',
                expected_count: session.expected || null,
                device_id: this._getDeviceId(),
                created_at: session.created || new Date().toISOString(),
            };
            try {
                await this._request('POST', 'sessions', { body: sessionData, upsert: true });
            } catch (err) {
                console.warn('[Push] Session failed:', err.message);
            }

            // Push all records in session
            const records = session.records || [];
            for (const record of records) {
                const recordData = {
                    local_id: record.id || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                    session_local_id: session.id,
                    eid: record.eid || '',
                    vid: record.vid || '',
                    weight: record.weight || null,
                    unit: record.unit || 'kg',
                    notes: record.notes || '',
                    date: record.date || new Date().toISOString().split('T')[0],
                    device_id: this._getDeviceId(),
                    created_at: record.timestamp || new Date().toISOString(),
                };
                try {
                    await this._request('POST', 'records', { body: recordData, upsert: true });
                    totalPushed++;
                } catch (err) {
                    console.warn('[Push] Record failed:', err.message);
                }
            }
        }

        // Also push any items in the pending queue
        await this.syncPending();

        return { sessions: sessions.length, records: totalPushed };
    }

    // ── Pull Data from Cloud ─────────────────────────────────
    async pullData() {
        if (!this.isConfigured() || !this._online) {
            throw new Error('Not connected');
        }

        // Fetch sessions from cloud
        const cloudSessions = await this._request('GET', 'sessions', {
            query: { select: '*', order: 'created_at.desc', limit: '100' },
        }) || [];

        // Fetch records from cloud
        const cloudRecords = await this._request('GET', 'records', {
            query: { select: '*', order: 'created_at.desc', limit: '5000' },
        }) || [];

        // Merge with local data
        const localSessionsRaw = localStorage.getItem('agrieid_sessions');
        const localSessions = localSessionsRaw ? JSON.parse(localSessionsRaw) : [];
        const localSessionMap = new Map(localSessions.map(s => [s.id, s]));

        let newSessions = 0;
        let newRecords = 0;

        for (const cs of cloudSessions) {
            const localId = cs.local_id;
            if (!localSessionMap.has(localId)) {
                // New session from cloud — add locally
                const newSession = {
                    id: localId,
                    name: cs.name || '',
                    mob: cs.mob || '',
                    paddock: cs.paddock || '',
                    expected: cs.expected_count || null,
                    created: cs.created_at,
                    records: [],
                };
                localSessions.push(newSession);
                localSessionMap.set(localId, newSession);
                newSessions++;
            }
        }

        // Merge records into sessions
        for (const cr of cloudRecords) {
            const sessionId = cr.session_local_id;
            const session = localSessionMap.get(sessionId);
            if (!session) continue;

            // Check if record already exists locally
            const existing = (session.records || []).find(r => r.id === cr.local_id);
            if (!existing) {
                // Add cloud record to local session
                if (!session.records) session.records = [];
                session.records.push({
                    id: cr.local_id,
                    eid: cr.eid || '',
                    vid: cr.vid || '',
                    weight: cr.weight || null,
                    unit: cr.unit || 'kg',
                    notes: cr.notes || '',
                    date: cr.date || '',
                    timestamp: cr.created_at,
                });
                newRecords++;
            }
        }

        // Save merged data
        localStorage.setItem('agrieid_sessions', JSON.stringify(localSessions));

        return { newSessions, newRecords, totalCloudSessions: cloudSessions.length, totalCloudRecords: cloudRecords.length };
    }

    // ── High-level API (called from app.js) ──────────────────

    // Sync a session to Supabase
    syncSession(session) {
        if (!this.isConfigured()) return;

        const data = {
            local_id: session.id,
            name: session.name || '',
            mob: session.mob || '',
            paddock: session.paddock || '',
            expected_count: session.expected || null,
            device_id: this._getDeviceId(),
            created_at: session.created || new Date().toISOString(),
        };
        this.queueRecord('upsert_session', 'sessions', data);
    }

    // Sync a record to Supabase
    syncRecord(record, sessionId) {
        if (!this.isConfigured()) return;

        const data = {
            local_id: record.id || `${Date.now()}`,
            session_local_id: sessionId,
            eid: record.eid || '',
            vid: record.vid || '',
            weight: record.weight || null,
            unit: record.unit || 'kg',
            notes: record.notes || '',
            date: record.date || new Date().toISOString().split('T')[0],
            device_id: this._getDeviceId(),
            created_at: record.timestamp || new Date().toISOString(),
        };
        this.queueRecord('upsert_record', 'records', data);
    }

    // Delete a record from Supabase
    deleteRecord(localId) {
        if (!this.isConfigured()) return;
        this.queueRecord('delete_record', 'records', { local_id: localId });
    }

    // ── Connection Test ──────────────────────────────────────
    async testConnection() {
        if (!this.isConfigured()) return { ok: false, error: 'Not configured' };
        try {
            // Try a simple query to check connection
            await this._request('GET', 'sessions', {
                query: { select: 'local_id', limit: '1' },
            });
            return { ok: true };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    }

    // ── Auto-sync Timer ──────────────────────────────────────
    startAutoSync(intervalMs = 30000) {
        this.stopAutoSync();
        this._syncInterval = setInterval(() => {
            if (this._online && this.getPendingCount() > 0) {
                this.syncPending();
            }
        }, intervalMs);
    }

    stopAutoSync() {
        if (this._syncInterval) {
            clearInterval(this._syncInterval);
            this._syncInterval = null;
        }
    }

    // ── Helpers ──────────────────────────────────────────────
    _getDeviceId() {
        let deviceId = localStorage.getItem('agrieid_device_id');
        if (!deviceId) {
            deviceId = `dev_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
            localStorage.setItem('agrieid_device_id', deviceId);
        }
        return deviceId;
    }

    _emit(type, detail = {}) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
    }
}
