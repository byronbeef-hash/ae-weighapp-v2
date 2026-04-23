// Runs the real LivestockProSync client through Node with a minimal browser
// shim (localStorage + EventTarget + navigator.onLine). Proves that the
// actual client code — not just the API — produces viewable data.
// Run: node tests/client.test.mjs

// ── Browser shim ────────────────────────────────────────────
const store = new Map();
globalThis.localStorage = {
    getItem: (k) => store.has(k) ? store.get(k) : null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
    get length() { return store.size; },
};
globalThis.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
};
globalThis.document = {
    querySelector: () => null,
};
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true, writable: true });
globalThis.crypto ??= (await import('node:crypto')).webcrypto;

const { LivestockProSync } = await import('../js/livestockpro-sync.js');

let pass = 0, fail = 0;
const assert = (cond, label, extra = '') => {
    if (cond) { console.log(`  PASS  ${label}`); pass++; }
    else { console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`); fail++; }
};

console.log('\n── LivestockProSync client test (Node + shim) ──\n');

// [1] Fresh login + pull
console.log('[1] Fresh login + pullData');
const lp = new LivestockProSync();
const loginRes = await lp.login('aedemo', 'demo@123');
assert(!!loginRes?.user, 'login returned user');
assert(lp.isLoggedIn(), 'isLoggedIn() true');
assert(!!lp.getFarmUuid(), 'farmUuid stored');

const pull1 = await lp.pullData();
console.log(`     stats: newSessions=${pull1.newSessions} newRecords=${pull1.newRecords} registerAnimals=${pull1.registerAnimals} registerHistory=${pull1.registerHistory}`);
assert(pull1.newSessions > 0, 'session pull returned sessions');
assert(pull1.newRecords > 0, 'session pull returned activities');
assert(pull1.registerAnimals >= 30, 'full register pulled (~36 animals)', `got ${pull1.registerAnimals}`);
assert(pull1.registerHistory >= 100, 'record history pulled (~179)', `got ${pull1.registerHistory}`);

// [2] Data is viewable via client accessors
console.log('\n[2] Cloud data viewable via client accessors');
const records = lp.getCloudRecords();
const history = lp.getCloudRecordHistory();
assert(records.length >= 30, 'getCloudRecords() returns animals');
assert(history.length >= 100, 'getCloudRecordHistory() returns history');
// Filter active animals (LP register includes soft-deleted and no-EID rows)
const active = records.filter(r => r.record_status === 1 && !r.deleted_at && r.eid);
assert(active.length > 0, `active animals (active=${active.length}, total=${records.length})`);
assert(active.every(r => r.uuid), 'every active animal has uuid');
const activeEids = new Set(active.map(r => r.eid));
assert(activeEids.size === active.length, 'active EIDs are unique');
console.log(`     ${active.length} active / ${records.length} total animals, ${history.length} history events`);
console.log(`     first 3 EIDs: ${records.slice(0,3).map(r => r.eid).join(', ')}`);

// [2b] Profile + medical accessors populated
console.log('\n[2b] Profile + medical accessors');
const breeds = lp.getCloudBreeds();
const mBatches = lp.getCloudMedicalBatches();
const bProducts = lp.getCloudBatchProducts();
const mProducts = lp.getCloudProducts();
assert(breeds.length > 0, 'getCloudBreeds() returns breeds');
assert(mBatches.length > 0, 'getCloudMedicalBatches() returns batches');
assert(bProducts.length > 0, 'getCloudBatchProducts() returns batch products');
assert(mProducts.length > 0, 'getCloudProducts() returns products');
console.log(`     breeds=${breeds.length} batches=${mBatches.length} batchProducts=${bProducts.length} products=${mProducts.length}`);

// Verify at least some animals have profile fields the UI needs
const withDob = records.filter(r => r.date_of_birth).length;
const withSex = records.filter(r => r.sex).length;
const withImage = records.filter(r => r.image && !String(r.image).includes('livestock_default_photo')).length;
const withBatch = records.filter(r => r.medical_batch_uuid).length;
assert(withSex > 0 || withDob > 0 || withBatch > 0, 'records carry profile fields (sex/dob/batch)', `sex=${withSex} dob=${withDob} batch=${withBatch}`);
console.log(`     profile coverage: dob=${withDob} sex=${withSex} image=${withImage} medical_batch=${withBatch}`);

// [3] Stale-date resilience: seed stale state, re-login, verify wipe
console.log('\n[3] Stale last_sync_date from previous user is wiped on login');
localStorage.setItem('agrieid_lp_last_sync', new Date().toISOString());
localStorage.setItem('agrieid_sessions', JSON.stringify([{id:'ghost',records:[]}]));
const lp2 = new LivestockProSync();
await lp2.login('aedemo', 'demo@123');
assert(!localStorage.getItem('agrieid_lp_last_sync'), 'stale last_sync wiped');
const pull2 = await lp2.pullData();
assert(pull2.registerAnimals >= 30, 'register pull works after wipe');
console.log(`     post-wipe pull: ${pull2.registerAnimals} animals`);

// [4] Logout clears everything
console.log('\n[4] Logout clears all cached cloud data');
await lp2.logout();
assert(!lp2.isLoggedIn(), 'isLoggedIn() false');
assert(lp2.getCloudRecords().length === 0, 'getCloudRecords() empty after logout');
assert(lp2.getCloudRecordHistory().length === 0, 'getCloudRecordHistory() empty after logout');
assert(!localStorage.getItem('agrieid_lp_last_sync'), 'last_sync cleared');

console.log(`\n── Result: ${pass} passed, ${fail} failed ──\n`);
process.exit(fail > 0 ? 1 : 0);
