// AgriEID — LivestockPro Cloud Sync
// Connects to the LivestockPro REST API (same backend as the Flutter Lite app).
// Handles auth, push/pull of sessions + records, medical batches, ADG history,
// and face recognition for animal ID.

const LP_AUTH_KEY = 'agrieid_lp_auth';
const LP_BATCHES_KEY = 'agrieid_medical_batches';
const LP_LAST_SYNC_KEY = 'agrieid_lp_last_sync';
const LP_FARM_UUID_KEY = 'agrieid_lp_farm_uuid';
const LP_RECORDS_KEY = 'agrieid_lp_records';
const LP_RECORD_HISTORY_KEY = 'agrieid_lp_record_history';
const LP_BREEDS_KEY = 'agrieid_lp_breeds';
const LP_BATCH_PRODUCTS_KEY = 'agrieid_lp_batch_products';
const LP_PRODUCTS_KEY = 'agrieid_lp_products';

const KG_TO_LB = 2.20462;

export class LivestockProSync extends EventTarget {
    constructor() {
        super();
        this._token = null;
        this._refreshToken = null;
        this._user = null;
        this._online = navigator.onLine;
        this._syncing = false;

        // Default to production — can be overridden
        this._baseUrl = 'https://www.livestockpro.app/api/';

        window.addEventListener('online', () => {
            this._online = true;
            this._emit('status', { online: true });
        });
        window.addEventListener('offline', () => {
            this._online = false;
            this._emit('status', { online: false });
        });
    }

    // ── Configuration ────────────────────────────────────────
    setBaseUrl(url) {
        this._baseUrl = url.replace(/\/$/, '') + '/';
    }

    useStage() {
        this._baseUrl = 'https://stage.livestockpro.app/api/';
    }

    useProd() {
        this._baseUrl = 'https://www.livestockpro.app/api/';
    }

    // ── Authentication ───────────────────────────────────────
    loadAuth() {
        try {
            const raw = localStorage.getItem(LP_AUTH_KEY);
            if (!raw) return null;
            const auth = JSON.parse(raw);
            this._token = auth.token;
            this._refreshToken = auth.refreshToken;
            this._user = auth.user;
            return auth;
        } catch (_) {
            return null;
        }
    }

    _saveAuth(token, refreshToken, user) {
        // Strip "Bearer " prefix if present — _fetch() adds it back
        this._token = token?.replace(/^Bearer\s+/i, '') || token;
        this._refreshToken = refreshToken;
        this._user = user;
        localStorage.setItem(LP_AUTH_KEY, JSON.stringify({
            token, refreshToken, user,
        }));
    }

    _clearAuth() {
        this._token = null;
        this._refreshToken = null;
        this._user = null;
        localStorage.removeItem(LP_AUTH_KEY);
        this._wipeSyncState();
    }

    _wipeSyncState() {
        localStorage.removeItem(LP_LAST_SYNC_KEY);
        localStorage.removeItem(LP_FARM_UUID_KEY);
        localStorage.removeItem(LP_BATCHES_KEY);
        localStorage.removeItem(LP_RECORDS_KEY);
        localStorage.removeItem(LP_RECORD_HISTORY_KEY);
        localStorage.removeItem(LP_BREEDS_KEY);
        localStorage.removeItem(LP_BATCH_PRODUCTS_KEY);
        localStorage.removeItem(LP_PRODUCTS_KEY);
        localStorage.removeItem('agrieid_sessions');
    }

    isLoggedIn() {
        if (!this._token) this.loadAuth();
        return !!this._token;
    }

    getUser() {
        if (!this._user) this.loadAuth();
        return this._user;
    }

    getFarmUuid() {
        return localStorage.getItem(LP_FARM_UUID_KEY) || '';
    }

    setFarmUuid(uuid) {
        localStorage.setItem(LP_FARM_UUID_KEY, uuid);
    }

    async login(email, password) {
        // Always wipe cached sync state before a fresh login so we don't
        // leak sessions or a stale last_sync_date from any previous account.
        this._wipeSyncState();

        const response = await this._fetch('login', {
            method: 'POST',
            body: {
                user_name: email,
                password,
                device_id: this._getDeviceId(),
                device_type: 'web',
                app_version: this._getAppVersion(),
                source_app: 'agrieid_weigh',
            },
            noAuth: true,
        });

        if (!response.response_data) {
            throw new Error(response.response_message || response.message || 'Login failed');
        }

        const data = response.response_data;
        const token = data.token || data.access_token;
        const refreshToken = data.refresh_token || '';
        // Spec: response_data has a `user` object and `farm` object (singular).
        // Older shapes returned flat fields — keep fallbacks.
        const userObj = data.user || data;
        const farmObj = data.farm || (Array.isArray(data.farms) ? data.farms[0] : null);
        const user = {
            id: userObj.id || userObj.user_id,
            email: userObj.email || email,
            name: userObj.name || userObj.first_name || '',
            farmUuid: farmObj?.uuid || data.farm_uuid || '',
        };

        if (user.farmUuid) {
            this.setFarmUuid(user.farmUuid);
        }

        this._saveAuth(token, refreshToken, user);
        this._emit('auth', { loggedIn: true, user });
        return { token, user };
    }

    async logout() {
        if (this._token) {
            try {
                await this._fetch('logout', { method: 'POST' });
            } catch (_) { /* ignore */ }
        }
        this._clearAuth();
        this._emit('auth', { loggedIn: false, user: null });
    }

    async _tryRefreshToken() {
        if (!this._refreshToken) {
            this._clearAuth();
            this._emit('auth', { loggedIn: false, user: null });
            throw new Error('No refresh token');
        }

        try {
            const response = await this._fetch('refresh-token', {
                method: 'POST',
                body: {
                    refresh_token: this._refreshToken,
                    device_id: this._getDeviceId(),
                },
                noAuth: true,
            });

            const data = response.response_data;
            if (!data?.token && !data?.access_token) throw new Error('Refresh failed');

            const token = data.token || data.access_token;
            const refreshToken = data.refresh_token || this._refreshToken;
            this._saveAuth(token, refreshToken, this._user);
            return token;
        } catch (err) {
            this._clearAuth();
            this._emit('auth', { loggedIn: false, user: null });
            throw err;
        }
    }

    // ── HTTP Client ──────────────────────────────────────────
    async _fetch(endpoint, options = {}) {
        const url = `${this._baseUrl}${endpoint}`;
        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        };

        if (!options.noAuth && this._token) {
            headers['Authorization'] = `Bearer ${this._token}`;
        }

        const fetchOptions = {
            method: options.method || 'POST',
            headers,
        };

        if (options.body) {
            fetchOptions.body = JSON.stringify(options.body);
        }

        const response = await fetch(url, fetchOptions);

        // Handle 401 — try token refresh once
        if (response.status === 401 && !options.noAuth && !options._retried) {
            try {
                await this._tryRefreshToken();
                return this._fetch(endpoint, { ...options, _retried: true });
            } catch (_) {
                throw new Error('Session expired — please log in again');
            }
        }

        if (!response.ok && response.status >= 500) {
            throw new Error(`Server error (${response.status})`);
        }

        const json = await response.json();
        return json;
    }

    // ── Push Data (device → LivestockPro) ────────────────────
    async pushData() {
        if (!this.isLoggedIn()) throw new Error('Not logged in');
        if (!this._online) throw new Error('Offline');

        const sessionsRaw = localStorage.getItem('agrieid_sessions');
        const sessions = sessionsRaw ? JSON.parse(sessionsRaw) : [];
        const deviceId = this._getDeviceId();
        const appVersion = this._getAppVersion();
        const farmUuid = this.getFarmUuid();

        // Build session rows
        const sessionRows = sessions.map(session => ({
            uuid: session.id,
            name: session.name || 'Session',
            allow_duplicate_records: '0',
            eid: '1',
            visual_tag: '1',
            medical_batch: '1',
            weight: '1',
            notes: '1',
            farm_uuid: farmUuid,
            custom_fields: {},
            session_date: this._formatDate(session.created || new Date().toISOString()),
            created_at: session.created || new Date().toISOString(),
            updated_at: session.created || new Date().toISOString(),
            deleted_at: null,
        }));

        // Build record (session_activity) rows
        const recordRows = [];
        for (const session of sessions) {
            for (const record of (session.records || [])) {
                if (record.lpSynced) continue; // already pushed

                const weightKg = this._toKg(record.weight, record.weightUnit || record.unit || 'kg');
                const weightLb = +(weightKg * KG_TO_LB).toFixed(2);

                recordRows.push({
                    record_group: null,
                    uuid: record.id,
                    scanner_sessions_uuid: session.id,
                    eid: record.eid || '',
                    visual_tag: record.vid || '',
                    replace_eid: '',
                    replace_vid: '',
                    medical_batch_uuid: record.medicalBatchUuid || '',
                    weight_kg: weightKg > 0 ? weightKg.toString() : '',
                    weight_lb: weightLb > 0 ? weightLb.toString() : '',
                    image: '', // photos handled separately if needed
                    notes: record.notes || '',
                    new_born: '0',
                    custom_fields: {},
                    record_date: this._formatDate(record.date || record.timestamp),
                    created_at: record.timestamp || new Date().toISOString(),
                    updated_at: record.timestamp || new Date().toISOString(),
                    farm_uuid: farmUuid,
                    deleted_at: null,
                });
            }
        }

        if (sessionRows.length === 0 && recordRows.length === 0) {
            return { sessions: 0, records: 0 };
        }

        const payload = {
            source_app: 'agrieid_weigh',
            device_id: deviceId,
            device_type: 'web',
            app_version: appVersion,
            record_session: { rows: sessionRows },
            session_activity: { rows: recordRows },
        };

        // Push endpoint is (confusingly) called "sync-pull" in LivestockPro
        const result = await this._fetch('sync-pull', {
            method: 'POST',
            body: payload,
        });

        if (result.response_data !== null && result.response_data !== undefined) {
            // Mark records as synced
            this._markRecordsSynced(sessions, recordRows.map(r => r.uuid));

            // Save last sync date
            localStorage.setItem(LP_LAST_SYNC_KEY,
                new Date().toISOString());

            this._emit('pushComplete', {
                sessions: sessionRows.length,
                records: recordRows.length,
            });

            return { sessions: sessionRows.length, records: recordRows.length };
        } else {
            throw new Error(result.response_message || 'Push failed');
        }
    }

    _markRecordsSynced(sessions, syncedUuids) {
        const uuidSet = new Set(syncedUuids);
        for (const session of sessions) {
            for (const record of (session.records || [])) {
                if (uuidSet.has(record.id)) {
                    record.lpSynced = true;
                }
            }
        }
        localStorage.setItem('agrieid_sessions', JSON.stringify(sessions));
    }

    // ── Pull Data (LivestockPro → device) ────────────────────
    async pullData() {
        if (!this.isLoggedIn()) throw new Error('Not logged in');
        if (!this._online) throw new Error('Offline');

        const lastSync = localStorage.getItem(LP_LAST_SYNC_KEY);
        const deviceId = this._getDeviceId();
        const appVersion = this._getAppVersion();

        const body = {
            is_session: 'yes',
            device_id: deviceId,
            device_type: 'web',
            app_version: appVersion,
            source_app: 'agrieid_weigh',
        };

        if (lastSync) {
            body.last_sync_date = lastSync;
            body.is_full_sync_completed = 'yes';
        }

        // Pull endpoint is (confusingly) called "sync-push" in LivestockPro.
        // On first hydration (no lastSync) use the unrestricted variant so users
        // without an active subscription can still pull their data.
        const endpoint = lastSync ? 'sync-push' : 'sync-push-unrestricted';
        const result = await this._fetch(endpoint, {
            method: 'POST',
            body,
        });

        if (!result.response_data) {
            throw new Error(result.response_message || 'Pull failed');
        }

        const data = result.response_data;
        const stats = { newSessions: 0, newRecords: 0, medicalBatches: 0 };

        // Merge sessions
        const localRaw = localStorage.getItem('agrieid_sessions');
        const localSessions = localRaw ? JSON.parse(localRaw) : [];
        const localMap = new Map(localSessions.map(s => [s.id, s]));

        // Process pulled sessions
        const cloudSessions = data.record_session?.rows || [];
        for (const cs of cloudSessions) {
            const uuid = cs.uuid;
            if (!localMap.has(uuid)) {
                const newSession = {
                    id: uuid,
                    name: cs.name || 'Pulled Session',
                    mob: '',
                    paddock: '',
                    expected: null,
                    created: cs.created_at || new Date().toISOString(),
                    records: [],
                };
                localSessions.push(newSession);
                localMap.set(uuid, newSession);
                stats.newSessions++;
            }
        }

        // Process pulled records (session_activity / livestock_records)
        const cloudRecords = data.session_activity?.rows || data.livestock_records?.rows || [];
        for (const cr of cloudRecords) {
            const sessionUuid = cr.scanner_sessions_uuid;
            const session = localMap.get(sessionUuid);
            if (!session) continue;

            if (!session.records) session.records = [];
            const exists = session.records.some(r => r.id === cr.uuid);
            if (!exists) {
                session.records.push({
                    id: cr.uuid,
                    eid: cr.eid || '',
                    vid: cr.visual_tag || '',
                    weight: parseFloat(cr.weight_kg) || 0,
                    weightUnit: 'kg',
                    unit: 'kg',
                    notes: cr.notes || '',
                    date: cr.record_date || cr.created_at?.split('T')[0] || '',
                    medicalBatchUuid: cr.medical_batch_uuid || '',
                    timestamp: cr.created_at || new Date().toISOString(),
                    lpSynced: true,
                });
                stats.newRecords++;
            }
        }

        localStorage.setItem('agrieid_sessions', JSON.stringify(localSessions));

        // Process medical batches
        const cloudBatches = data.medical_batch?.rows || [];
        if (cloudBatches.length > 0) {
            localStorage.setItem(LP_BATCHES_KEY, JSON.stringify(cloudBatches));
            stats.medicalBatches = cloudBatches.length;
        }

        // Process user info (farm_uuid)
        const users = data.user?.rows || [];
        if (users.length > 0 && users[0].farm_uuid) {
            this.setFarmUuid(users[0].farm_uuid);
        }

        // Pull full cattle register (all animals + full weight history,
        // including records not tied to a scanner session).
        try {
            const regStats = await this._pullCattleRegister(endpoint);
            stats.registerAnimals = regStats.animals;
            stats.registerHistory = regStats.history;
        } catch (err) {
            console.warn('[LP] Cattle register pull failed:', err.message);
            stats.registerAnimals = 0;
            stats.registerHistory = 0;
        }

        // Update last sync date
        localStorage.setItem(LP_LAST_SYNC_KEY, new Date().toISOString());

        this._emit('pullComplete', stats);
        return stats;
    }

    // Pulls the full cattle register (all animals, all history) — separate
    // from the session-centric pull because LP returns different shapes
    // depending on `is_session`. With `is_session` omitted we get the full
    // `record` and `record_history` tables.
    async _pullCattleRegister(endpoint) {
        const body = {
            device_id: this._getDeviceId(),
            device_type: 'web',
            app_version: this._getAppVersion(),
            source_app: 'agrieid_weigh',
        };
        const result = await this._fetch(endpoint, { method: 'POST', body });
        const data = result.response_data || {};
        const records = data.record?.rows || [];
        const history = data.record_history?.rows || [];
        if (records.length) {
            localStorage.setItem(LP_RECORDS_KEY, JSON.stringify(records));
        }
        if (history.length) {
            localStorage.setItem(LP_RECORD_HISTORY_KEY, JSON.stringify(history));
        }
        const breeds = data.breeds?.rows || [];
        if (breeds.length) localStorage.setItem(LP_BREEDS_KEY, JSON.stringify(breeds));
        const batchProducts = data.medical_batch_products?.rows || [];
        if (batchProducts.length) localStorage.setItem(LP_BATCH_PRODUCTS_KEY, JSON.stringify(batchProducts));
        const products = data.products?.rows || [];
        if (products.length) localStorage.setItem(LP_PRODUCTS_KEY, JSON.stringify(products));
        const batches = data.medical_batch?.rows || [];
        if (batches.length) localStorage.setItem(LP_BATCHES_KEY, JSON.stringify(batches));
        return { animals: records.length, history: history.length };
    }

    getCloudRecords() {
        try { return JSON.parse(localStorage.getItem(LP_RECORDS_KEY) || '[]'); }
        catch { return []; }
    }

    getCloudRecordHistory() {
        try { return JSON.parse(localStorage.getItem(LP_RECORD_HISTORY_KEY) || '[]'); }
        catch { return []; }
    }

    getCloudBreeds() {
        try { return JSON.parse(localStorage.getItem(LP_BREEDS_KEY) || '[]'); }
        catch { return []; }
    }

    getCloudMedicalBatches() {
        try { return JSON.parse(localStorage.getItem(LP_BATCHES_KEY) || '[]'); }
        catch { return []; }
    }

    getCloudBatchProducts() {
        try { return JSON.parse(localStorage.getItem(LP_BATCH_PRODUCTS_KEY) || '[]'); }
        catch { return []; }
    }

    getCloudProducts() {
        try { return JSON.parse(localStorage.getItem(LP_PRODUCTS_KEY) || '[]'); }
        catch { return []; }
    }

    // ── Medical Batches ──────────────────────────────────────
    async fetchMedicalBatches() {
        if (!this.isLoggedIn()) throw new Error('Not logged in');

        const result = await this._fetch('scanner-session/sync-pull-medical-batch', {
            method: 'POST',
            body: {},
        });

        const rd = result.response_data;
        const batches = rd?.rows
            || rd?.medical_batch?.rows
            || (Array.isArray(rd) ? rd : []);

        localStorage.setItem(LP_BATCHES_KEY, JSON.stringify(batches));
        this._emit('medicalBatches', { batches });
        return batches;
    }

    getCachedMedicalBatches() {
        try {
            const raw = localStorage.getItem(LP_BATCHES_KEY);
            return raw ? JSON.parse(raw) : [];
        } catch (_) {
            return [];
        }
    }

    // ── ADG / Weight History ─────────────────────────────────
    // The LP API has no direct endpoint for per-session weight history
    // (removed after commit 041e9697). We compute ADG from locally-cached
    // records across all sessions — pullData() must have run at least once.
    async fetchWeightHistory(sessionUuid) {
        const sessionsRaw = localStorage.getItem('agrieid_sessions');
        const sessions = sessionsRaw ? JSON.parse(sessionsRaw) : [];
        const target = sessions.find(s => s.id === sessionUuid);
        if (!target) return null;

        const targetRecords = target.records || [];
        const activityDetails = targetRecords.map(r => {
            const weightKg = this._toKg(r.weight, r.weightUnit || r.unit || 'kg');
            const weightLb = +(weightKg * KG_TO_LB).toFixed(2);
            const { adgKg, adgLb } = this._computeAdg(sessions, target, r);
            return {
                uuid: r.id,
                sessionUuid,
                weightKg,
                weightLb,
                adgKg,
                adgLb,
                weightChanged: null,
            };
        });

        return { sessionId: sessionUuid, activityDetails };
    }

    _computeAdg(sessions, currentSession, currentRecord) {
        const id = currentRecord.eid || currentRecord.vid;
        if (!id) return { adgKg: null, adgLb: null };

        const currentDate = new Date(currentRecord.date || currentRecord.timestamp || currentSession.created);
        if (isNaN(currentDate)) return { adgKg: null, adgLb: null };

        let prev = null;
        for (const s of sessions) {
            for (const r of (s.records || [])) {
                if (r.id === currentRecord.id) continue;
                const rId = r.eid || r.vid;
                if (rId !== id) continue;
                const rDate = new Date(r.date || r.timestamp || s.created);
                if (isNaN(rDate) || rDate >= currentDate) continue;
                if (!prev || rDate > prev.date) prev = { record: r, date: rDate };
            }
        }
        if (!prev) return { adgKg: null, adgLb: null };

        const currKg = this._toKg(currentRecord.weight, currentRecord.weightUnit || currentRecord.unit || 'kg');
        const prevKg = this._toKg(prev.record.weight, prev.record.weightUnit || prev.record.unit || 'kg');
        const days = Math.max(1, Math.round((currentDate - prev.date) / 86400000));
        const adgKg = +((currKg - prevKg) / days).toFixed(3);
        const adgLb = +(adgKg * KG_TO_LB).toFixed(3);
        return { adgKg, adgLb };
    }

    // ── Check Record Existence ───────────────────────────────
    // LP has no direct endpoint; check against locally-cached records.
    async checkRecordExists(eid) {
        if (!eid) return null;
        const sessionsRaw = localStorage.getItem('agrieid_sessions');
        const sessions = sessionsRaw ? JSON.parse(sessionsRaw) : [];
        for (const s of sessions) {
            for (const r of (s.records || [])) {
                if (r.eid === eid) {
                    return {
                        exists: true,
                        uuid: r.id,
                        eid: r.eid,
                        visual_tag: r.vid || '',
                        sessionUuid: s.id,
                    };
                }
            }
        }
        return { exists: false };
    }

    // ── Face Recognition ─────────────────────────────────────
    async recognizeAnimal(base64Image) {
        if (!this.isLoggedIn()) throw new Error('Not logged in');

        // Spec: multipart/form-data with field `gps_image`.
        const blob = this._dataUrlToBlob(base64Image);
        const form = new FormData();
        form.append('gps_image', blob, 'capture.jpg');

        const response = await fetch(`${this._baseUrl}records/facial-recognition`, {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Authorization': `Bearer ${this._token}`,
            },
            body: form,
        });

        if (response.status === 401) {
            try { await this._tryRefreshToken(); } catch (_) {
                throw new Error('Session expired — please log in again');
            }
            return this.recognizeAnimal(base64Image);
        }

        const result = await response.json().catch(() => ({}));

        if (!result.response_data) {
            return { matched: false, message: result.response_message || 'No match found' };
        }

        return {
            matched: true,
            data: result.response_data,
            message: result.response_message || 'Match found',
        };
    }

    _dataUrlToBlob(input) {
        if (input instanceof Blob) return input;
        const str = String(input || '');
        const match = str.match(/^data:([^;]+);base64,(.+)$/);
        const mime = match ? match[1] : 'image/jpeg';
        const b64 = match ? match[2] : str;
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new Blob([bytes], { type: mime });
    }

    // ── Connection Test ──────────────────────────────────────
    async testConnection() {
        try {
            // Simple authed request to check token validity
            const result = await this._fetch('subscription-current', {
                method: 'POST',
                body: {},
            });
            return { ok: true };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    }

    // ── Helpers ──────────────────────────────────────────────
    _getDeviceId() {
        let deviceId = localStorage.getItem('agrieid_device_id');
        if (!deviceId) {
            deviceId = `web_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
            localStorage.setItem('agrieid_device_id', deviceId);
        }
        return deviceId;
    }

    _getAppVersion() {
        // APP_VERSION is declared as a global var in index.html
        try { if (typeof APP_VERSION === 'string' && APP_VERSION) return APP_VERSION; } catch (_) {}
        if (typeof window !== 'undefined' && window.APP_VERSION) return window.APP_VERSION;
        const meta = document.querySelector('meta[name="version"]')?.content;
        return meta || '1.0.0';
    }

    /** Format date as yyyy/MM/dd for LivestockPro */
    _formatDate(dateStr) {
        try {
            const d = new Date(dateStr);
            if (isNaN(d.getTime())) return dateStr;
            const yyyy = d.getFullYear();
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const dd = String(d.getDate()).padStart(2, '0');
            return `${yyyy}/${mm}/${dd}`;
        } catch (_) {
            return dateStr;
        }
    }

    /** Convert weight to kg */
    _toKg(weight, unit) {
        const w = parseFloat(weight) || 0;
        if (unit === 'lb') return +(w / KG_TO_LB).toFixed(2);
        return w;
    }

    _emit(type, detail = {}) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
    }
}
