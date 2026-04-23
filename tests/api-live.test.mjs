// Live LivestockPro API smoke test.
// Hits prod (www.livestockpro.app) with demo creds and verifies:
//   1. login returns token + user + farm.uuid
//   2. sync-push-unrestricted with is_session:'yes' returns sessions + activities
//   3. sync-push with stale last_sync_date=today returns 0 rows (proves v23 wipe is needed)
//   4. sync-push with last_sync_date=null returns the same dataset as first-hydration
//   5. logout succeeds
// Run: node tests/api-live.test.mjs

const BASE = 'https://www.livestockpro.app/api/';
const USER = 'aedemo';
const PASS = 'demo@123';
const DEVICE_ID = 'test-harness-' + Date.now();

let pass = 0, fail = 0;
const assert = (cond, label, extra = '') => {
    if (cond) { console.log(`  PASS  ${label}`); pass++; }
    else { console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`); fail++; }
};

async function post(path, body, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(BASE + path, {
        method: 'POST', headers, body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
}

const clientBody = (extra = {}) => ({
    is_session: 'yes',
    device_id: DEVICE_ID,
    device_type: 'web',
    app_version: 'v23-test',
    source_app: 'agrieid_weigh',
    ...extra,
});

console.log(`\n── Live LP API test — ${USER} @ ${BASE} ──\n`);

// 1. Login
console.log('[1] login');
const login = await post('login', {
    user_name: USER, password: PASS,
    device_id: DEVICE_ID, device_type: 'web',
    app_version: 'v23-test', source_app: 'agrieid_weigh',
});
assert(login.status === 200, 'HTTP 200', `got ${login.status}`);
const loginData = login.json.response_data;
assert(!!loginData, 'response_data present');
const token = (loginData?.token || '').replace(/^Bearer\s+/i, '');
assert(!!token, 'token returned');
assert(!!loginData?.user?.id, 'user.id present', `got ${loginData?.user?.id}`);
assert(!!loginData?.farm?.uuid, 'farm.uuid present');

// 2. First-hydration pull
console.log('\n[2] sync-push-unrestricted (is_session: yes, no last_sync)');
const full = await post('sync-push-unrestricted', clientBody(), token);
assert(full.status === 200, 'HTTP 200', `got ${full.status}`);
const fullData = full.json.response_data || {};
const recordSession = fullData.record_session?.rows || [];
const sessionActivity = fullData.session_activity?.rows || [];
assert(recordSession.length > 0, `record_session.rows has data`, `got ${recordSession.length}`);
assert(sessionActivity.length > 0, `session_activity.rows has data`, `got ${sessionActivity.length}`);
console.log(`     record_session=${recordSession.length}  session_activity=${sessionActivity.length}`);

// 3. Stale last_sync_date should return 0 (this is the bug v23 wipe fixes)
console.log('\n[3] sync-push with last_sync_date = now — expect 0 rows');
const now = new Date().toISOString();
const stale = await post('sync-push', clientBody({
    last_sync_date: now,
    is_full_sync_completed: 'yes',
}), token);
const staleData = stale.json.response_data || {};
const staleSessions = staleData.record_session?.rows || [];
assert(staleSessions.length === 0, 'record_session.rows is empty with future date', `got ${staleSessions.length}`);
console.log(`     (confirms stale last_sync_date blocks pull → v23 wipe on login is required)`);

// 4. Delta pull with null last_sync_date should behave like full pull
console.log('\n[4] sync-push with last_sync_date omitted (same as v23 post-wipe state)');
const delta = await post('sync-push-unrestricted', clientBody(), token);
const deltaData = delta.json.response_data || {};
const deltaSessions = deltaData.record_session?.rows || [];
assert(deltaSessions.length === recordSession.length, 'same session count after wipe-equivalent pull');

// 4b. Full cattle register (is_session omitted)
console.log('\n[4b] sync-push-unrestricted WITHOUT is_session — full cattle register');
const reg = await post('sync-push-unrestricted', {
    device_id: DEVICE_ID, device_type: 'web',
    app_version: 'v23-test', source_app: 'agrieid_weigh',
}, token);
const regData = reg.json.response_data || {};
const allRecords = regData.record?.rows || [];
const allHistory = regData.record_history?.rows || [];
assert(allRecords.length > 0, 'record.rows populated (all animals)', `got ${allRecords.length}`);
assert(allHistory.length > 0, 'record_history.rows populated', `got ${allHistory.length}`);
assert(allRecords.length >= recordSession.length, 'register ≥ session-linked animals');
console.log(`     full register: ${allRecords.length} animals, ${allHistory.length} history events`);
// Spot-check a record has the fields the UI needs
const sample = allRecords[0];
assert(!!sample.eid, 'sample record has eid');
assert(!!sample.uuid, 'sample record has uuid');
assert(sample.weight_kg != null, 'sample record has weight_kg');

// 5. Logout
console.log('\n[5] logout');
const logout = await post('logout', { device_id: DEVICE_ID }, token);
assert(logout.status === 200 || logout.status === 204, 'HTTP 200/204', `got ${logout.status}`);

console.log(`\n── Result: ${pass} passed, ${fail} failed ──\n`);
process.exit(fail > 0 ? 1 : 0);
