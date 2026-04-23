// AgriEID - Main Application Controller
// Scales: BLE connection via Web Bluetooth
// EID Reader: BTU Stick paired as HID-KB-UART keyboard in System Bluetooth
//   Press scan → BT connects → press scan again → EID types into input field
import { ScalesManager } from './scales.js?v=19';
import { EIDReaderManager } from './eid-reader.js?v=19';
import { LivestockProSync } from './livestockpro-sync.js?v=19';

// ============================================================
// State
// ============================================================
const state = {
    session: null,
    records: [],
    currentEID: null,
    pendingEID: null,   // Buffered EID from scanner on non-main screens
    lockedWeight: null,
    lockedUnit: null,
    liveWeight: null,
    liveUnit: 'kg',
    isSteady: false,
    scalesConnected: false,
    debugMode: false,
    readerConnected: false,
    readerHIDMode: false,
    readerSPPMode: false, // legacy, kept for compat
    steadyStart: null,
    autoLockSeconds: 0,
    // Auto Weigh mode
    autoWeighActive: false,
    autoWeighPhase: 'idle',  // idle | waiting | weighing | scanning | ready
    autoSave: false,
    autoScan: true,
    autoBeep: true,
    autoWeighThreshold: 5.0,  // kg — below this = empty scales
    autoWeighSteadyTime: 0,   // seconds — 0 = lock on first steady reading
    autoWeighCount: 0,        // records auto-saved this session
    // Display mode: 'combined' | 'eid-only' | 'scales-only'
    displayMode: 'combined',
};

// ============================================================
// BLE Managers
// ============================================================
const scales = new ScalesManager();
const lpSync = new LivestockProSync();

// ============================================================
// Touch device detection — avoid auto-focusing inputs on mobile
// (prevents keyboard from popping up when BLE reader sends tags)
// ============================================================
const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);

/** Focus EID input only on desktop — on touch devices, keyboard would cover the screen */
function focusEidIfDesktop() {
    if (!isTouchDevice) {
        dom.inputEid.focus();
    }
}

// ============================================================
// Scanner Detection
// Tracks rapid keystrokes to distinguish scanner from manual typing.
// HID scanners type 10-16 digits in < 100ms then send Enter.
// ============================================================
const scanner = {
    buffer: '',
    lastKeyTime: 0,
    threshold: 80, // ms between keys — scanner is much faster than typing
};

// ============================================================
// BLE EID Reader (paired on Setup screen, scan polling on main)
// ============================================================
let eidReader = null;

function initEIDReader() {
    if (eidReader) return eidReader;

    eidReader = new EIDReaderManager();

    eidReader.addEventListener('log', (e) => {
        debugLog(`[Reader] ${e.detail.message}`);
    });

    eidReader.addEventListener('connection', (e) => {
        const { connected, name, error, hidMode, sppMode } = e.detail;
        state.readerConnected = connected;
        state.readerHIDMode = !!hidMode;
        state.readerSPPMode = !!sppMode;

        // Update status dots on all screens
        dom.mainReaderDot?.classList.toggle('connected', connected);

        // Update setup screen
        if (connected) {
            const mode = hidMode ? 'IHID' : 'BLE';
            dom.readerDeviceName.textContent = `Connected: ${name || 'EID Reader'} (${mode})`;
            dom.btnDownloadTags.style.display = hidMode ? 'none' : '';
            dom.btnConnectReader.textContent = 'Connected';
            dom.btnConnectReader.disabled = true;
            dom.btnDisconnectReader.style.display = '';
            // Hide pairing hint after successful connection
            const hint = document.getElementById('pairing-hint');
            if (hint) hint.style.display = 'none';
        } else {
            dom.readerDeviceName.textContent = '';
            dom.btnConnectReader.textContent = 'Connect Reader';
            dom.btnConnectReader.disabled = false;
            dom.btnDisconnectReader.style.display = 'none';
            dom.btnDownloadTags.style.display = 'none';
            dom.downloadProgress.style.display = 'none';
        }

        // Update scan button state — don't auto-start, let user choose Scan or Auto
        if (connected) {
            dom.btnScanEid.textContent = 'Scan';
            dom.btnScanEid.classList.remove('scanning');
            dom.btnScanEid.disabled = false;
            dom.btnAutoScanEid.textContent = 'Auto';
            dom.btnAutoScanEid.classList.remove('scanning');
            dom.btnAutoScanEid.disabled = false;
        } else {
            dom.btnScanEid.textContent = 'Scan';
            dom.btnScanEid.classList.remove('scanning');
            dom.btnScanEid.disabled = false;
            dom.btnAutoScanEid.textContent = 'Auto';
            dom.btnAutoScanEid.classList.remove('scanning');
            dom.btnAutoScanEid.disabled = false;
        }
    });

    eidReader.addEventListener('scanning', (e) => {
        const { scanning } = e.detail;
        if (!scanning) {
            // Reset both buttons to idle
            dom.btnScanEid.textContent = 'Scan';
            dom.btnScanEid.classList.remove('scanning');
            dom.btnScanEid.disabled = false;
            dom.btnAutoScanEid.textContent = 'Auto';
            dom.btnAutoScanEid.classList.remove('scanning');
            dom.btnAutoScanEid.disabled = false;
        }
    });

    eidReader.addEventListener('tag', handleBLETag);

    eidReader.addEventListener('listenOnly', (e) => {
        showToast('Press scan button on reader', 'info');
    });

    return eidReader;
}

function handleBLETag(e) {
    const { tagId, tagType } = e.detail;
    debugLog(`BLE Tag received: ${tagId} (${tagType})`);

    const isMainScreen = screens.main.classList.contains('active');

    if (isMainScreen) {
        setCurrentEID(tagId);
        dom.eidSection.classList.add('scanned');
        setTimeout(() => dom.eidSection.classList.remove('scanned'), 1500);

        // Keep poll loop running — reader stays ready for next tag.
        // Plain-text tags arrive via notifications; poll detects stored tag count changes.

        // Focus notes or save button for manual save
        if (state.lockedWeight != null) {
            { if (!isTouchDevice) dom.inputNotes.focus(); };
        }
    } else {
        state.pendingEID = tagId;
        showScanToast(tagId);
    }
}

/**
 * Ensure reader is connected, connecting if needed.
 * @returns {Promise<EIDReaderManager|null>} reader if connected, null if failed
 */
async function ensureReaderConnected() {
    const reader = initEIDReader();
    if (state.readerConnected) return reader;

    // Not connected — try to connect
    dom.btnScanEid.textContent = 'Connecting...';
    dom.btnScanEid.disabled = true;
    dom.btnAutoScanEid.disabled = true;

    try {
        let ok = false;

        // Try silent reconnect first (no picker) if we have a device reference
        if (reader.device) {
            debugLog('Scan: trying silent reconnect...');
            try {
                ok = await reader.reconnect();
            } catch (e) {
                debugLog(`Scan reconnect failed: ${e.message}`);
            }
        }

        // If reconnect failed or no device, show BLE picker as fallback
        if (!ok) {
            debugLog('Scan: opening device picker...');
            ok = await reader.connect();
        }

        if (!ok) {
            showToast('Could not connect to reader', 'warning');
            dom.btnScanEid.textContent = 'Scan';
            dom.btnScanEid.disabled = false;
            dom.btnAutoScanEid.textContent = 'Auto';
            dom.btnAutoScanEid.disabled = false;
            return null;
        }
        return reader;
    } catch (e) {
        debugLog(`Scan connect error: ${e.message}`);
        showToast('Reader connection failed', 'warning');
        dom.btnScanEid.textContent = 'Scan';
        dom.btnScanEid.disabled = false;
        dom.btnAutoScanEid.textContent = 'Auto';
        dom.btnAutoScanEid.disabled = false;
        return null;
    }
}

/**
 * Single scan — triggers one SCAN command. Stops after tag or 10s timeout.
 */
async function handleSingleScan() {
    const reader = await ensureReaderConnected();
    if (!reader) return;

    // If already scanning — stop
    if (reader._scanning) {
        reader.stopScanPolling();
        return;
    }

    // Show active state
    dom.btnScanEid.textContent = 'Scanning...';
    dom.btnScanEid.classList.add('scanning');
    dom.btnAutoScanEid.disabled = true;

    // Single mode: one trigger, stop on tag
    await reader.startScanPolling({ continuous: false, stopOnTag: true });

    // Auto-timeout after 10s if no tag found
    const timeoutId = setTimeout(() => {
        if (reader._scanning) {
            reader.stopScanPolling();
            debugLog('Single scan timed out (10s)');
            showToast('No tag found — try again', 'info');
        }
    }, 10000);

    // Clear timeout if scan stops before 10s (e.g. tag found)
    const onStop = (e) => {
        if (!e.detail.scanning) {
            clearTimeout(timeoutId);
            reader.removeEventListener('scanning', onStop);
        }
    };
    reader.addEventListener('scanning', onStop);
}

/**
 * Continuous (auto) scan — keeps scanning until a tag is detected.
 */
async function handleAutoScan() {
    const reader = await ensureReaderConnected();
    if (!reader) return;

    // If already scanning — stop
    if (reader._scanning) {
        reader.stopScanPolling();
        return;
    }

    // Show active state
    dom.btnAutoScanEid.textContent = 'Scanning...';
    dom.btnAutoScanEid.classList.add('scanning');
    dom.btnScanEid.disabled = true;

    // Continuous mode: keeps scanning, stops when tag detected
    await reader.startScanPolling({ continuous: true, stopOnTag: true });
}

async function connectReader(showAll = false) {
    const reader = initEIDReader();

    dom.btnConnectReader.textContent = 'Connecting...';
    dom.btnConnectReader.disabled = true;

    try {
        let ok = false;
        if (!showAll && reader.device) {
            try {
                ok = await reader.reconnect();
            } catch (e) {
                debugLog(`Reader reconnect failed: ${e.message}`);
            }
        }
        if (!ok) {
            ok = await reader.connect(showAll);
        }
        if (!ok) {
            dom.btnConnectReader.textContent = 'Connect Reader';
            dom.btnConnectReader.disabled = false;
        }
    } catch (e) {
        debugLog(`Reader connect error: ${e.message}`);
        dom.btnConnectReader.textContent = 'Connect Reader';
        dom.btnConnectReader.disabled = false;
        showToast('Reader connection failed', 'warning');
    }
}

function disconnectReader() {
    if (eidReader) {
        eidReader.softDisconnect();
    }
}

async function downloadStoredTags() {
    if (!eidReader || !state.readerConnected) {
        debugLog('Reader not connected');
        return;
    }

    dom.btnDownloadTags.disabled = true;
    dom.btnDownloadTags.textContent = 'Downloading...';
    dom.downloadProgress.style.display = 'flex';
    dom.downloadedTags.style.display = 'none';

    try {
        const tags = await eidReader.readAllTags((current, total) => {
            dom.progressFill.style.width = `${(current / total) * 100}%`;
            dom.progressText.textContent = `${current} / ${total}`;
        });

        dom.progressFill.style.width = '100%';
        dom.btnDownloadTags.textContent = 'Download Stored Tags';
        dom.btnDownloadTags.disabled = false;

        if (tags.length === 0) {
            dom.downloadedTags.style.display = '';
            dom.downloadedTags.innerHTML = '<div style="padding:12px; text-align:center; color:var(--text-dim); font-size:13px;">No tags stored on reader</div>';
            return;
        }

        // Dedupe tags — keep first occurrence of each tagId
        const uniqueMap = new Map();
        for (const tag of tags) {
            if (!uniqueMap.has(tag.tagId)) {
                uniqueMap.set(tag.tagId, tag);
            }
        }
        const uniqueTags = [...uniqueMap.values()];
        const dupeCount = tags.length - uniqueTags.length;

        // Display tags (show all by default, dedupe button filters)
        function renderTagList(displayTags, showDupeInfo) {
            let html = '<div class="downloaded-tags-header">';
            html += `<span class="downloaded-tags-title">${displayTags.length} tag${displayTags.length !== 1 ? 's' : ''}`;
            if (showDupeInfo && dupeCount > 0) {
                html += ` <span style="color:var(--text-dim); font-size:11px;">(${dupeCount} dupes removed)</span>`;
            }
            html += '</span>';
            html += '<div style="display:flex; gap:6px;">';
            if (dupeCount > 0) {
                html += `<button class="downloaded-tags-export" id="btn-dedupe-tags">${showDupeInfo ? 'Show All' : 'Dedupe (' + dupeCount + ')'}</button>`;
            }
            html += '<button class="downloaded-tags-export" id="btn-export-stored-tags">Export CSV</button>';
            html += '</div></div>';

            for (const tag of displayTags) {
                html += `<div class="downloaded-tag-item">`;
                html += `<span class="downloaded-tag-id">${tag.tagId}</span>`;
                html += `<span class="downloaded-tag-meta">${tag.tagType} ${tag.timestamp ? '| ' + tag.timestamp : ''}</span>`;
                html += '</div>';
            }

            dom.downloadedTags.innerHTML = html;

            // Wire up buttons
            const exportBtn = document.getElementById('btn-export-stored-tags');
            if (exportBtn) {
                exportBtn.addEventListener('click', () => exportStoredTagsCSV(displayTags));
            }
            const dedupeBtn = document.getElementById('btn-dedupe-tags');
            if (dedupeBtn) {
                dedupeBtn.addEventListener('click', () => {
                    renderTagList(showDupeInfo ? tags : uniqueTags, !showDupeInfo);
                });
            }
        }

        dom.downloadedTags.style.display = '';
        renderTagList(tags, false);

        // Show delete button after successful download
        dom.btnDeleteReaderTags.style.display = '';

    } catch (e) {
        debugLog(`Download failed: ${e.message}`);
        dom.btnDownloadTags.textContent = 'Download Stored Tags';
        dom.btnDownloadTags.disabled = false;
        dom.downloadProgress.style.display = 'none';
    }
}

async function deleteReaderTags() {
    if (!eidReader || !state.readerConnected) {
        debugLog('Reader not connected');
        return;
    }

    if (!confirm('Delete all stored tags from the reader? This cannot be undone.')) {
        return;
    }

    dom.btnDeleteReaderTags.disabled = true;
    dom.btnDeleteReaderTags.textContent = 'Deleting...';

    try {
        const ok = await eidReader.deleteAllTags();
        if (ok) {
            showToast('Reader storage cleared', 'success');
            dom.downloadedTags.innerHTML = '<div style="padding:12px; text-align:center; color:var(--text-dim); font-size:13px;">No tags stored on reader</div>';
            dom.btnDeleteReaderTags.style.display = 'none';
            // Reset poll baseline so it doesn't think there are old tags
            eidReader._lastKnownCount = 0;
        } else {
            showToast('Delete failed — unexpected response', 'warning');
        }
    } catch (e) {
        debugLog(`Delete failed: ${e.message}`);
        showToast('Delete failed', 'warning');
    }

    dom.btnDeleteReaderTags.disabled = false;
    dom.btnDeleteReaderTags.textContent = 'Delete All from Reader';
}

async function exportStoredTagsCSV(tags) {
    const headers = ['TagID', 'Type', 'Timestamp'];
    // Wrap TagID in ="..." so spreadsheet apps treat it as text, not a number
    const rows = tags.map(t => [`="${t.tagId}"`, t.tagType, t.timestamp || '']);
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const filename = `stored_tags_${new Date().toISOString().slice(0, 10)}.csv`;

    await downloadCSVFile(csv, filename);
    showToast(`Exported ${tags.length} tags`, 'success');
    debugLog('Stored tags CSV exported');
}

/**
 * Cross-platform CSV download helper.
 * Uses Web Share API on iOS (opens share sheet with save-to-files option),
 * falls back to blob URL download or window.open for other platforms.
 */
async function downloadCSVFile(csvContent, filename) {
    // Try Web Share API first (best for iOS — opens share sheet with "Save to Files")
    if (navigator.share) {
        try {
            const file = new File([csvContent], filename, { type: 'text/csv' });
            const shareData = { files: [file], title: filename };
            if (navigator.canShare && navigator.canShare(shareData)) {
                await navigator.share(shareData);
                return;
            }
        } catch (e) {
            // AbortError = user cancelled share sheet — that's fine
            if (e.name === 'AbortError') return;
            debugLog(`Share API failed: ${e.message}, trying fallback`);
        }
    }

    // Fallback: blob URL + anchor click (works on Chrome desktop)
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ============================================================
// Photo / Video Capture
// ============================================================
const mediaFiles = []; // Array of {type, blob, url} for current record

function addMediaFile(type, file) {
    const url = URL.createObjectURL(file);
    mediaFiles.push({ type, blob: file, url, name: file.name });
    renderMediaPreview();
}

function removeMediaFile(index) {
    const item = mediaFiles[index];
    if (item) URL.revokeObjectURL(item.url);
    mediaFiles.splice(index, 1);
    renderMediaPreview();
}

function clearMediaFiles() {
    for (const item of mediaFiles) {
        URL.revokeObjectURL(item.url);
    }
    mediaFiles.length = 0;
    renderMediaPreview();
}

function renderMediaPreview() {
    const container = dom.mediaPreview;
    if (!container) return;

    if (mediaFiles.length === 0) {
        container.style.display = 'none';
        container.innerHTML = '';
        return;
    }

    container.style.display = 'flex';
    container.innerHTML = '';

    mediaFiles.forEach((item, idx) => {
        const thumb = document.createElement('div');
        thumb.className = 'media-thumb';

        if (item.type === 'photo') {
            const img = document.createElement('img');
            img.src = item.url;
            thumb.appendChild(img);
        } else {
            const vid = document.createElement('video');
            vid.src = item.url;
            vid.muted = true;
            thumb.appendChild(vid);
        }

        const removeBtn = document.createElement('button');
        removeBtn.className = 'media-thumb-remove';
        removeBtn.textContent = '\u00D7';
        removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            removeMediaFile(idx);
        });
        thumb.appendChild(removeBtn);

        container.appendChild(thumb);
    });
}

// ============================================================
// DOM References
// ============================================================
const $ = (id) => document.getElementById(id);

const screens = {
    setup: $('screen-setup'),
    dashboard: $('screen-dashboard'),
    session: $('screen-session'),
    main: $('screen-main'),
    records: $('screen-records'),
    autoweigh: $('screen-autoweigh'),
    'cloud-dashboard': $('screen-cloud-dashboard'),
    'animal-detail': $('screen-animal-detail'),
};

const dom = {
    // Setup — Scales
    btnConnectScales: $('btn-connect-scales'),
    btnDisconnectScales: $('btn-disconnect-scales'),
    btnNewSessionSetup: $('btn-new-session-setup'),
    btnHistoricSessions: $('btn-historic-sessions'),
    scalesDeviceName: $('scales-device-name'),
    btnDebugToggle: $('btn-debug-toggle'),
    debugPanel: $('debug-panel'),

    // Setup — Reader
    btnConnectReader: $('btn-connect-reader'),
    btnDisconnectReader: $('btn-disconnect-reader'),
    readerDeviceName: $('reader-device-name'),
    btnDownloadTags: $('btn-download-tags'),
    downloadProgress: $('download-progress'),
    progressFill: $('progress-fill'),
    progressText: $('progress-text'),
    downloadedTags: $('downloaded-tags'),
    btnDeleteReaderTags: $('btn-delete-reader-tags'),

    // Dashboard
    dashboardList: $('dashboard-list'),
    btnNewSession: $('btn-new-session'),
    btnDashboardSetup: $('btn-dashboard-setup'),

    // Session
    inputSessionName: $('input-session-name'),
    inputMob: $('input-mob'),
    inputPaddock: $('input-paddock'),
    inputExpected: $('input-expected'),
    btnCreateSession: $('btn-create-session'),
    btnSessionBack: $('btn-session-back'),

    // Main
    mainScalesDot: $('main-scales-dot'),
    mainReaderDot: $('main-reader-dot'),
    sessionNameDisplay: $('session-name-display'),
    sessionCountDisplay: $('session-count-display'),
    indicator: $('indicator'),
    weightDisplay: $('weight-display'),
    weightValue: $('weight-value'),
    weightUnit: $('weight-unit'),
    badgeStatus: $('badge-status'),
    badgeType: $('badge-type'),
    badgeUnit: $('badge-unit'),
    lockedWeightSection: $('locked-weight-section'),
    lockedWeightValue: $('locked-weight-value'),
    btnLockWeight: $('btn-lock-weight'),
    eidSection: $('eid-section'),
    inputEid: $('input-eid'),
    btnScanEid: $('btn-scan-eid'),
    btnAutoScanEid: $('btn-auto-scan-eid'),
    btnClearEid: $('btn-clear-eid'),
    eidExisting: $('eid-existing'),
    inputVid: $('input-vid'),
    btnSearchAnimal: $('btn-search-animal'),
    btnTakePhoto: $('btn-take-photo'),
    btnTakeVideo: $('btn-take-video'),
    inputPhoto: $('input-photo'),
    inputVideo: $('input-video'),
    mediaPreview: $('media-preview'),
    inputDate: $('input-date'),
    inputNotes: $('input-notes'),
    notesSection: $('notes-section'),
    btnMic: $('btn-mic'),
    btnSaveRecord: $('btn-save-record'),
    footerCount: $('footer-count'),
    footerExpected: $('footer-expected'),
    footerLast: $('footer-last'),
    btnViewRecords: $('btn-view-records'),
    btnSettings: $('btn-settings'),
    recentRecords: $('recent-records'),
    recentRecordsList: $('recent-records-list'),
    btnViewAllRecords: $('btn-view-all-records'),

    // Animal History
    animalHistory: $('animal-history'),
    historyCount: $('history-count'),
    historyLastWeight: $('history-last-weight'),
    historyLastDate: $('history-last-date'),
    historyAdg: $('history-adg'),
    weightChart: $('weight-chart'),

    // Session Stats
    sessionStats: $('session-stats'),
    statTotal: $('stat-total'),
    statAvg: $('stat-avg'),
    statMin: $('stat-min'),
    statMax: $('stat-max'),

    // Records
    recordsList: $('records-list'),
    recordsSessionName: $('records-session-name'),
    recordsTotal: $('records-total'),
    btnExportCsv: $('btn-export-csv'),
    btnExportCsvMain: $('btn-export-csv-main'),
    btnBackMain: $('btn-back-main'),

    // Auto Weigh (main screen bar)
    btnAutoWeigh: $('btn-auto-weigh'),
    autoWeighBar: $('auto-weigh-bar'),
    autoWeighStatus: $('auto-weigh-status'),
    btnStopAutoWeigh: $('btn-stop-auto-weigh'),
    autoSaveCheckbox: $('auto-save-checkbox'),

    // Auto Weigh screen
    btnAutoweighBack: $('btn-autoweigh-back'),
    awToggle: $('aw-toggle'),
    awThreshold: $('aw-threshold'),
    awSteadyTime: $('aw-steady-time'),
    awAutoScan: $('aw-auto-scan'),
    awAutoSave: $('aw-auto-save'),
    awBeep: $('aw-beep'),
    awStatusCard: $('aw-status-card'),
    awPhaseDot: $('aw-phase-dot'),
    awPhaseText: $('aw-phase-text'),
    awAutoCount: $('aw-auto-count'),
    awCurrentWeight: $('aw-current-weight'),

    // LivestockPro / Medical Batch
    inputMedicalBatch: $('input-medical-batch'),
    btnNewBatch: $('btn-new-batch'),
    btnIdentifyAnimal: $('btn-identify-animal'),
    inputIdentifyPhoto: $('input-identify-photo'),
    btnLpPush: $('btn-lp-push'),
    btnLpPull: $('btn-lp-pull'),
    btnLpFetchBatches: $('btn-lp-fetch-batches'),
    historyCloudAdg: $('history-cloud-adg'),
    historyCloudAdgSection: $('history-cloud-adg-section'),

    // New Batch Modal
    modalNewBatch: $('modal-new-batch'),
    inputBatchName: $('input-batch-name'),
    inputBatchType: $('input-batch-type'),
    btnBatchSave: $('btn-batch-save'),
    btnBatchCancel: $('btn-batch-cancel'),
    btnBatchCancel2: $('btn-batch-cancel-2'),

    // Sync Progress
    syncProgressBar: $('sync-progress-bar'),
    syncProgressFill: $('sync-progress-fill'),
    syncProgressText: $('sync-progress-text'),
    syncLastTime: $('sync-last-time'),
};

// ============================================================
// Display Mode
// ============================================================

/**
 * Apply display mode — show/hide sections on the main weighing screen.
 * Modes: 'combined' (default), 'eid-only', 'scales-only'
 */
function applyDisplayMode(mode) {
    // Elements to control
    const scalesSetup = document.getElementById('setup-scales');
    const eidSetup = document.getElementById('setup-eid');
    const weightHero = document.querySelector('.weight-hero');
    const eidSection = dom.eidSection;
    const vidSection = document.getElementById('vid-section');

    // Reset all to visible
    if (scalesSetup) scalesSetup.style.display = '';
    if (eidSetup) eidSetup.style.display = '';
    if (eidSection) eidSection.style.display = '';
    if (vidSection) vidSection.style.display = '';
    if (weightHero) weightHero.style.display = '';

    switch (mode) {
        case 'eid-only':
            // Hide scales indicator + lock button
            if (weightHero) weightHero.style.display = 'none';
            // Hide scales setup card
            if (scalesSetup) scalesSetup.style.display = 'none';
            break;

        case 'scales-only':
            // Hide EID section + scan buttons
            if (eidSection) eidSection.style.display = 'none';
            // Hide EID reader setup card
            if (eidSetup) eidSetup.style.display = 'none';
            break;

        case 'combined':
        default:
            // Everything visible — nothing to hide
            break;
    }
}

// ============================================================
// Screen Navigation
// ============================================================
function showScreen(name) {
    Object.values(screens).forEach(s => s.classList.remove('active'));
    screens[name].classList.add('active');

    if (name === 'dashboard') {
        renderDashboard();
    }
    if (name === 'cloud-dashboard') {
        renderCloudDashboard();
    }
    if (name === 'autoweigh') {
        // Sync toggle state
        if (dom.awToggle) dom.awToggle.checked = state.autoWeighActive;
        if (dom.awStatusCard) dom.awStatusCard.style.display = state.autoWeighActive ? '' : 'none';
        if (dom.awPhaseDot) dom.awPhaseDot.classList.toggle('active', state.autoWeighActive);
    }
    // Focus EID input when entering main screen + apply any pending scan
    if (name === 'main') {
        // Set date to today
        if (dom.inputDate) {
            dom.inputDate.value = new Date().toISOString().slice(0, 10);
        }
        if (state.pendingEID) {
            debugLog(`Applying buffered EID: ${state.pendingEID}`);
            setCurrentEID(state.pendingEID);
            state.pendingEID = null;
            dom.eidSection.classList.add('scanned');
            setTimeout(() => dom.eidSection.classList.remove('scanned'), 800);
        }
        setTimeout(() => focusEidIfDesktop(), 100);
    }
}

// ============================================================
// Data Mode (Cloud vs Manual)
// ============================================================
function applyDataMode(mode) {
    const cloudDataBtn = $('btn-cloud-data');
    const cloudToggleBtn = $('btn-cloud-toggle');
    const cloudDropdown = $('cloud-dropdown');

    if (mode === 'manual') {
        if (cloudDataBtn) cloudDataBtn.style.display = 'none';
        if (cloudToggleBtn) cloudToggleBtn.style.display = 'none';
        if (cloudDropdown) cloudDropdown.style.display = 'none';
    } else {
        if (cloudDataBtn) cloudDataBtn.style.display = '';
        if (cloudToggleBtn) cloudToggleBtn.style.display = '';
    }
}

function toggleCloudDropdown() {
    const dropdown = $('cloud-dropdown');
    const btn = $('btn-cloud-toggle');
    if (!dropdown) return;

    const isVisible = dropdown.style.display !== 'none';
    dropdown.style.display = isVisible ? 'none' : '';
    if (btn) btn.classList.toggle('active', !isVisible);
}

// ============================================================
// Debug Logging
// ============================================================
function debugLog(msg) {
    console.log(msg);
    if (state.debugMode) {
        const line = document.createElement('div');
        line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
        dom.debugPanel.appendChild(line);
        dom.debugPanel.scrollTop = dom.debugPanel.scrollHeight;
    }
}

// ============================================================
// Cloud Sync UI
// ============================================================
function updateSyncBadge() {
    const badge = $('sync-status-badge');
    if (!badge) return;
    const loggedIn = lpSync.isLoggedIn();
    const online = navigator.onLine;

    if (!loggedIn) {
        badge.textContent = 'Not logged in';
        badge.className = 'sync-badge sync-offline';
    } else if (online) {
        badge.textContent = 'Connected';
        badge.className = 'sync-badge sync-ok';
    } else {
        badge.textContent = 'Offline';
        badge.className = 'sync-badge sync-offline';
    }
}

function updateCloudUI() {
    const loginSection = $('cloud-login');
    const accountSection = $('cloud-account');
    const emailDisplay = $('cloud-user-email');
    const toggleBtn = $('btn-cloud-toggle');
    const dropdown = $('cloud-dropdown');

    const isLoggedIn = lpSync.isLoggedIn();

    if (loginSection && accountSection) {
        if (isLoggedIn) {
            loginSection.style.display = 'none';
            accountSection.style.display = 'block';
            const user = lpSync.getUser();
            if (emailDisplay) emailDisplay.textContent = user?.name || user?.email || 'Logged in';
        } else {
            loginSection.style.display = 'block';
            accountSection.style.display = 'none';
        }
    }

    // Update toggle button
    if (toggleBtn) {
        if (isLoggedIn) {
            toggleBtn.textContent = 'Connected';
            toggleBtn.classList.add('active');
            // Auto-show dropdown when connected
            if (dropdown) dropdown.style.display = '';
        } else {
            toggleBtn.textContent = 'Cloud Login';
            toggleBtn.classList.remove('active');
        }
    }

    updateSyncBadge();
}

async function cloudLogin() {
    const email = $('cloud-email')?.value.trim();
    const password = $('cloud-password')?.value;
    if (!email || !password) {
        showToast('Please enter username and password', 'warning');
        return;
    }

    const btn = $('btn-cloud-login');
    if (btn) { btn.disabled = true; btn.textContent = 'Logging in...'; }

    try {
        await lpSync.login(email, password);
        debugLog('AgriEID Cloud: logged in as ' + email);
        showToast('Logged in to AgriEID Cloud!', 'success');

        // Save details if checkbox is checked
        const saveCheck = $('cloud-save-details');
        if (saveCheck?.checked) {
            localStorage.setItem('ae_saved_credentials', JSON.stringify({ username: email, password }));
        } else {
            localStorage.removeItem('ae_saved_credentials');
        }

        // Offer biometric setup if available and not already enrolled
        if (!localStorage.getItem('ae_biometric_credId') && window.PublicKeyCredential) {
            try {
                const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
                if (available) {
                    setupBiometricLogin(email, password);
                }
            } catch { /* ignore */ }
        }

        lpFetchBatches(true);
        const pwField = $('cloud-password');
        if (pwField) pwField.value = '';
        updateCloudUI();
    } catch (err) {
        debugLog('AgriEID Cloud: login failed — ' + err.message);
        showToast('Login failed — check your credentials', 'warning');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Log In'; }
    }
}

// ── Saved Credentials ────────────────────────────────────
function loadSavedCredentials() {
    const saved = localStorage.getItem('ae_saved_credentials');
    if (!saved) return;
    try {
        const { username, password } = JSON.parse(saved);
        const emailField = $('cloud-email');
        const pwField = $('cloud-password');
        const saveCheck = $('cloud-save-details');
        if (emailField && username) emailField.value = username;
        if (pwField && password) pwField.value = password;
        if (saveCheck) saveCheck.checked = true;
    } catch { /* ignore corrupt */ }
}

// ── Biometric (Face ID / Touch ID) Login ─────────────────
async function setupBiometricLogin(username, password) {
    try {
        const userId = new TextEncoder().encode(username);
        const challenge = crypto.getRandomValues(new Uint8Array(32));

        const credential = await navigator.credentials.create({
            publicKey: {
                challenge,
                rp: { name: 'AgriEID', id: location.hostname },
                user: {
                    id: userId,
                    name: username,
                    displayName: username,
                },
                pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
                authenticatorSelection: {
                    authenticatorAttachment: 'platform',
                    userVerification: 'required',
                },
                timeout: 60000,
            },
        });

        if (credential) {
            // Store credential ID and login details for biometric auth
            const credId = btoa(String.fromCharCode(...new Uint8Array(credential.rawId)));
            localStorage.setItem('ae_biometric_credId', credId);
            localStorage.setItem('ae_biometric_user', JSON.stringify({ username, password }));
            debugLog('Biometric login enrolled');
            showToast('Face ID / Touch ID enabled for login', 'success');
        }
    } catch (err) {
        debugLog('Biometric setup skipped: ' + err.message);
    }
}

async function biometricLogin() {
    const credIdB64 = localStorage.getItem('ae_biometric_credId');
    const userRaw = localStorage.getItem('ae_biometric_user');
    if (!credIdB64 || !userRaw) {
        showToast('No biometric login saved — log in with password first', 'warning');
        return;
    }

    const btn = $('btn-biometric-login');
    if (btn) { btn.disabled = true; btn.textContent = 'Verifying...'; }

    try {
        const credId = Uint8Array.from(atob(credIdB64), c => c.charCodeAt(0));
        const challenge = crypto.getRandomValues(new Uint8Array(32));

        await navigator.credentials.get({
            publicKey: {
                challenge,
                allowCredentials: [{ id: credId, type: 'public-key', transports: ['internal'] }],
                userVerification: 'required',
                timeout: 60000,
            },
        });

        // Biometric verified — log in with stored credentials
        const { username, password } = JSON.parse(userRaw);
        await lpSync.login(username, password);
        debugLog('AgriEID Cloud: biometric login as ' + username);
        showToast('Logged in with Face ID!', 'success');
        lpFetchBatches(true);
        updateCloudUI();
    } catch (err) {
        debugLog('Biometric login failed: ' + err.message);
        if (err.name === 'NotAllowedError') {
            showToast('Biometric verification cancelled', 'info');
        } else {
            showToast('Biometric login failed — use password', 'warning');
        }
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Log In with Face ID'; }
    }
}

async function cloudLogout() {
    try { await lpSync.logout(); } catch (_) { /* ignore */ }
    showToast('Logged out', 'info');
    debugLog('AgriEID Cloud: logged out');
    updateCloudUI();
}

// ============================================================
// LivestockPro Cloud Functions
// ============================================================

// ============================================================
// Sync UI Feedback Helpers
// ============================================================
let _syncHideTimer = null;

function showSyncProgress(message) {
    if (!dom.syncProgressBar) return;
    dom.syncProgressBar.style.display = '';
    dom.syncProgressFill.className = 'sync-progress-fill animating';
    dom.syncProgressText.textContent = message || 'Syncing...';
    clearTimeout(_syncHideTimer);
}

function showSyncSuccess(message) {
    if (!dom.syncProgressBar) return;
    dom.syncProgressBar.style.display = '';
    dom.syncProgressFill.className = 'sync-progress-fill sync-success';
    dom.syncProgressText.textContent = message || 'Sync complete';
    // Update last sync time
    const now = new Date();
    localStorage.setItem('agrieid_last_sync_ui', now.toISOString());
    updateLastSyncDisplay();
    // Auto-hide after 3 seconds
    clearTimeout(_syncHideTimer);
    _syncHideTimer = setTimeout(hideSyncStatus, 3000);
}

function showSyncError(message) {
    if (!dom.syncProgressBar) return;
    dom.syncProgressBar.style.display = '';
    dom.syncProgressFill.className = 'sync-progress-fill sync-error';
    dom.syncProgressText.textContent = message || 'Sync failed';
    // Auto-hide after 5 seconds
    clearTimeout(_syncHideTimer);
    _syncHideTimer = setTimeout(hideSyncStatus, 5000);
}

function hideSyncStatus() {
    if (dom.syncProgressBar) dom.syncProgressBar.style.display = 'none';
}

function updateLastSyncDisplay() {
    if (!dom.syncLastTime) return;
    const raw = localStorage.getItem('agrieid_last_sync_ui');
    if (!raw) {
        dom.syncLastTime.textContent = '';
        return;
    }
    const d = new Date(raw);
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.floor(diffMs / 60000);

    let timeStr;
    if (diffMin < 1) {
        timeStr = 'just now';
    } else if (diffMin < 60) {
        timeStr = `${diffMin}m ago`;
    } else {
        timeStr = d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
    }
    dom.syncLastTime.textContent = `Last synced: ${timeStr}`;
}

async function lpPushData() {
    const btn = dom.btnLpPush;
    const statusEl = $('cloud-sync-status');
    if (btn) { btn.disabled = true; btn.textContent = 'Pushing...'; }
    if (statusEl) statusEl.textContent = 'Pushing data to cloud...';
    showSyncProgress('Pushing to AgriEID Cloud...');

    try {
        const result = await lpSync.pushData();
        const msg = `Pushed ${result.sessions} session(s), ${result.records} record(s)`;
        showToast(msg, 'success');
        debugLog('Cloud push: ' + msg);
        if (statusEl) statusEl.textContent = msg;
        showSyncSuccess(msg);
    } catch (err) {
        showToast('Push failed: ' + err.message, 'warning');
        debugLog('Cloud push failed: ' + err.message);
        if (statusEl) statusEl.textContent = 'Push failed: ' + err.message;
        showSyncError('Push failed');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<span class="cloud-btn-icon">&#x2B06;</span> Push'; }
    }
}

async function lpPullData() {
    const btn = dom.btnLpPull;
    const statusEl = $('cloud-sync-status');
    if (btn) { btn.disabled = true; btn.textContent = 'Pulling...'; }
    if (statusEl) statusEl.textContent = 'Pulling data from cloud...';
    showSyncProgress('Pulling from AgriEID Cloud...');

    try {
        const result = await lpSync.pullData();
        const msg = `Merged ${result.newSessions} session(s), ${result.newRecords} record(s)`;
        showToast(msg, 'success');
        debugLog('Cloud pull: ' + msg);
        if (statusEl) statusEl.textContent = msg;
        showSyncSuccess(msg);
        // Refresh the dashboard if we're on it
        if (state.session) {
            renderRecentRecords();
            updateFooter();
        }
    } catch (err) {
        showToast('Pull failed: ' + err.message, 'warning');
        debugLog('Cloud pull failed: ' + err.message);
        if (statusEl) statusEl.textContent = 'Pull failed: ' + err.message;
        showSyncError('Pull failed');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<span class="cloud-btn-icon">&#x2B07;</span> Pull'; }
    }
}

async function lpFetchBatches(silent = false) {
    const btn = dom.btnLpFetchBatches;
    if (btn && !silent) { btn.disabled = true; btn.textContent = 'Fetching...'; }
    if (!silent) showSyncProgress('Fetching medical batches...');

    try {
        const batches = await lpSync.fetchMedicalBatches();
        populateMedicalBatches(batches);
        if (!silent) {
            showToast(`Fetched ${batches.length} medical batch(es)`, 'success');
            debugLog(`LP: fetched ${batches.length} medical batches`);
            showSyncSuccess(`Fetched ${batches.length} batch(es)`);
        } else {
            debugLog(`LP: loaded ${batches.length} medical batches`);
        }
    } catch (err) {
        if (!silent) {
            showToast('Fetch batches failed: ' + err.message, 'warning');
            debugLog('LP fetch batches failed: ' + err.message);
            showSyncError('Fetch batches failed');
        }
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Fetch Batches'; }
    }
}

function populateMedicalBatches(batches) {
    // After LP batches are fetched/loaded, refresh the full dropdown (LP + local)
    refreshMedicalBatchDropdown();
}

function loadCachedMedicalBatches() {
    try {
        const raw = localStorage.getItem('agrieid_medical_batches');
        const lpBatches = raw ? JSON.parse(raw) : [];
        populateMedicalBatches(lpBatches);
    } catch (_) { /* ignore */ }
}

// ============================================================
// Local Medical Batch Management
// ============================================================
const LOCAL_BATCHES_KEY = 'agrieid_local_batches';

function getLocalBatches() {
    try {
        const raw = localStorage.getItem(LOCAL_BATCHES_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch (_) { return []; }
}

function saveLocalBatches(batches) {
    localStorage.setItem(LOCAL_BATCHES_KEY, JSON.stringify(batches));
}

function createLocalBatch(name, treatmentType) {
    const batch = {
        uuid: crypto.randomUUID(),
        batch_no: name,
        name: name,
        treatment_type: treatmentType,
        createdAt: new Date().toISOString(),
        isLocal: true,
    };
    const batches = getLocalBatches();
    batches.push(batch);
    saveLocalBatches(batches);
    debugLog(`Local batch created: ${name} (${treatmentType})`);
    return batch;
}

function openNewBatchModal() {
    if (dom.modalNewBatch) {
        dom.modalNewBatch.style.display = '';
        if (dom.inputBatchName) { dom.inputBatchName.value = ''; dom.inputBatchName.focus(); }
        if (dom.inputBatchType) dom.inputBatchType.value = 'Drench';
    }
}

function closeNewBatchModal() {
    if (dom.modalNewBatch) dom.modalNewBatch.style.display = 'none';
}

function saveNewBatch() {
    const name = dom.inputBatchName?.value.trim();
    const type = dom.inputBatchType?.value || 'Other';
    if (!name) {
        showToast('Please enter a batch name', 'warning');
        return;
    }
    const batch = createLocalBatch(name, type);
    closeNewBatchModal();
    // Refresh dropdown with merged batches
    refreshMedicalBatchDropdown();
    // Auto-select the new batch
    if (dom.inputMedicalBatch) {
        dom.inputMedicalBatch.value = batch.uuid;
    }
    showToast(`Batch "${name}" created`, 'success');
}

/** Merges LP cloud batches + local batches into the dropdown */
function refreshMedicalBatchDropdown() {
    const select = dom.inputMedicalBatch;
    if (!select) return;
    const currentVal = select.value;

    // Clear existing options except "None"
    select.innerHTML = '<option value="">None</option>';

    // LP cloud batches
    try {
        const raw = localStorage.getItem('agrieid_medical_batches');
        let lpBatches = raw ? JSON.parse(raw) : [];
        // Handle nested API response format: {medical_batch: {rows: [...]}}
        if (lpBatches && !Array.isArray(lpBatches)) {
            lpBatches = lpBatches.medical_batch?.rows || lpBatches.rows || [];
        }
        if (lpBatches.length > 0) {
            const group = document.createElement('optgroup');
            group.label = 'Cloud Batches';
            for (const batch of lpBatches) {
                const opt = document.createElement('option');
                opt.value = batch.uuid || batch.id || '';
                opt.textContent = batch.batch_no || batch.name || batch.uuid || 'Unnamed';
                group.appendChild(opt);
            }
            select.appendChild(group);
        }
    } catch (_) { /* ignore */ }

    // Local batches
    const localBatches = getLocalBatches();
    if (localBatches.length > 0) {
        const group = document.createElement('optgroup');
        group.label = 'Local Batches';
        for (const batch of localBatches) {
            const opt = document.createElement('option');
            opt.value = batch.uuid;
            opt.textContent = `${batch.name} (${batch.treatment_type})`;
            group.appendChild(opt);
        }
        select.appendChild(group);
    }

    // Restore selection
    if (currentVal) select.value = currentVal;
}

async function fetchCloudADG(eid, vid) {
    // Only attempt if logged into LivestockPro and we have a session
    if (!lpSync.isLoggedIn() || !state.session) {
        hideCloudADG();
        return;
    }

    try {
        const history = await lpSync.fetchWeightHistory(state.session.id);
        if (!history || !history.activityDetails || history.activityDetails.length === 0) {
            hideCloudADG();
            return;
        }

        // Find records matching this EID or VID
        const matching = history.activityDetails.filter(r => {
            if (eid && r.eid === eid) return true;
            if (vid && r.visual_tag === vid) return true;
            return false;
        });

        if (matching.length > 0) {
            // Use the most recent matching record's ADG
            const latest = matching[matching.length - 1];
            const adgKg = parseFloat(latest.adg_kg);
            if (!isNaN(adgKg) && adgKg !== 0) {
                showCloudADG(adgKg);
            } else {
                hideCloudADG();
            }
        } else {
            hideCloudADG();
        }
    } catch (err) {
        debugLog('Cloud ADG fetch failed: ' + err.message);
        hideCloudADG();
    }
}

function showCloudADG(adgKg) {
    if (dom.historyCloudAdgSection) dom.historyCloudAdgSection.style.display = '';
    if (dom.historyCloudAdg) {
        dom.historyCloudAdg.textContent = `${adgKg >= 0 ? '+' : ''}${adgKg.toFixed(2)} kg/d`;
        dom.historyCloudAdg.style.color = adgKg >= 0 ? 'var(--green)' : 'var(--red)';
    }
}

function hideCloudADG() {
    if (dom.historyCloudAdgSection) dom.historyCloudAdgSection.style.display = 'none';
    if (dom.historyCloudAdg) dom.historyCloudAdg.textContent = '—';
}

async function identifyAnimal() {
    if (!lpSync.isLoggedIn()) {
        showToast('Log in to LivestockPro to use animal identification', 'info');
        return;
    }

    // Trigger file input to capture a photo
    dom.inputIdentifyPhoto?.click();
}

async function processIdentifyPhoto(file) {
    if (!file) return;

    showToast('Identifying animal...', 'info');
    debugLog('Face recognition: processing photo...');

    try {
        const base64 = await blobToBase64(file);
        const result = await lpSync.recognizeAnimal(base64);

        if (result && result.matched) {
            // Auto-populate EID and VID
            if (result.eid) {
                setCurrentEID(result.eid);
                debugLog(`Face recognition: matched EID ${result.eid}`);
            }
            if (result.visual_tag && dom.inputVid) {
                dom.inputVid.value = result.visual_tag;
            }
            showToast(`Matched: ${result.eid || result.visual_tag || 'Unknown'}`, 'success');
            // Trigger history lookup
            renderAnimalHistory(result.eid || null, result.visual_tag || null);
        } else {
            showToast('No matching animal found', 'warning');
            debugLog('Face recognition: no match');
        }
    } catch (err) {
        showToast('Identification failed: ' + err.message, 'warning');
        debugLog('Face recognition error: ' + err.message);
    }
}

// ============================================================
// Scales Events
// ============================================================
scales.addEventListener('connection', (e) => {
    const { connected, name, error } = e.detail;
    state.scalesConnected = connected;

    if (connected) {
        dom.scalesDeviceName.textContent = `Connected: ${name || 'Scales'}`;
        dom.mainScalesDot.classList.add('connected');
        dom.btnConnectScales.textContent = 'Connected';
        dom.btnConnectScales.disabled = true;
        dom.btnDisconnectScales.style.display = '';
        debugLog(`Scales connected: ${name}`);
    } else {
        dom.mainScalesDot.classList.remove('connected');
        dom.scalesDeviceName.textContent = '';
        dom.btnConnectScales.textContent = 'Connect Scales';
        dom.btnConnectScales.disabled = false;
        dom.btnDisconnectScales.style.display = 'none';
        debugLog(`Scales disconnected${error ? ': ' + error : ''}`);
    }
    updateStartButton();
    updateMainUI();
});

scales.addEventListener('weight', (e) => {
    const data = e.detail;
    state.liveWeight = data.weight;
    state.liveUnit = data.unit;
    state.isSteady = data.isSteady;
    scales.lastDecimalPlaces = data.decimalPlaces;

    // Debug: log raw frame data to debug panel
    if (!state._weightLogCount) state._weightLogCount = 0;
    state._weightLogCount++;
    if (state._weightLogCount <= 3 || state._weightLogCount % 100 === 0) {
        debugLog(`Scales raw: ${data.weightDisplay} ${data.unit} (dp=${data.decimalPlaces}) | hex: ${data.rawHex}`);
    }

    if (data.isSteady && data.weight > 0) {
        if (!state.steadyStart) state.steadyStart = Date.now();
    } else {
        state.steadyStart = null;
    }

    updateWeightDisplay(data);

    // Auto Weigh state machine
    processAutoWeigh(data);
});

// ============================================================
// Weight Display
// ============================================================
function updateWeightDisplay(data) {
    if (!data) {
        dom.weightValue.textContent = '---';
        dom.weightDisplay.className = 'weight-display disconnected';
        dom.indicator.className = 'indicator-container disconnected';
        dom.badgeStatus.textContent = 'OFFLINE';
        dom.badgeStatus.className = 'indicator-badge';
        return;
    }

    dom.weightValue.textContent = data.weightDisplay;
    dom.weightUnit.textContent = data.unit;

    if (data.isSteady) {
        dom.weightDisplay.className = 'weight-display';
        dom.indicator.className = 'indicator-container steady';
        dom.badgeStatus.textContent = 'STEADY';
        dom.badgeStatus.className = 'indicator-badge steady';
    } else {
        dom.weightDisplay.className = 'weight-display dynamic';
        dom.indicator.className = 'indicator-container dynamic';
        dom.badgeStatus.textContent = 'LIVE';
        dom.badgeStatus.className = 'indicator-badge motion';
    }

    dom.badgeType.textContent = data.weightType;
    dom.badgeUnit.textContent = data.unit;
    dom.btnLockWeight.disabled = data.weight <= 0;
}

// ============================================================
// EID Input (Manual + Scanner Keyboard)
// ============================================================
function getEIDFromInput() {
    const raw = dom.inputEid.value.trim().replace(/[\s\-\.]/g, '');
    return raw || null;
}

let eidHistoryTimer = null;

function updateEIDState() {
    const eid = getEIDFromInput();
    const vid = dom.inputVid?.value.trim() || '';
    state.currentEID = eid;

    if (eid) {
        dom.eidSection.classList.add('has-tag');
        dom.btnClearEid.style.display = '';
        dom.btnScanEid.style.display = 'none';
        dom.btnAutoScanEid.style.display = 'none';

        // Check if this EID exists in current session (informational notice)
        const existsInSession = state.records.find(r => r.eid === eid);
        if (existsInSession) {
            dom.eidExisting.style.display = '';
        } else {
            dom.eidExisting.style.display = 'none';
        }
    } else {
        dom.eidSection.classList.remove('has-tag');
        dom.btnClearEid.style.display = 'none';
        dom.btnScanEid.style.display = '';
        dom.btnAutoScanEid.style.display = '';
        dom.eidExisting.style.display = 'none';
    }

    // Debounced cross-session history lookup (by EID or VID)
    clearTimeout(eidHistoryTimer);
    if (eid || vid) {
        eidHistoryTimer = setTimeout(() => renderAnimalHistory(eid, vid), 200);
    } else {
        renderAnimalHistory(null, null);
    }

    updateSaveButton();

    // Auto Weigh: check if we have both weight + EID
    autoWeighCheckReady();
}

function setCurrentEID(tagId) {
    state.currentEID = tagId;
    dom.inputEid.value = tagId || '';
    updateEIDState();
}

// Generic toast for status messages (type: 'info', 'warning', 'success')
function showToast(message, type = 'info') {
    const toast = $('scan-toast');
    const text = $('scan-toast-text');
    if (!toast || !text) return;

    text.textContent = message;
    // Style based on type
    toast.classList.remove('toast-warning', 'toast-success', 'toast-info');
    toast.classList.add(`toast-${type}`);
    toast.style.display = '';
    toast.style.animation = 'none';
    toast.offsetHeight;
    toast.style.animation = '';

    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => {
        toast.style.display = 'none';
    }, 4000);
}

// Show toast notification when scan detected on non-main screen
function showScanToast(eid) {
    const toast = $('scan-toast');
    const text = $('scan-toast-text');
    if (!toast || !text) return;

    text.textContent = `EID Scanned: ${eid}`;
    toast.style.display = '';
    // Re-trigger animation
    toast.style.animation = 'none';
    toast.offsetHeight; // force reflow
    toast.style.animation = '';

    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => {
        toast.style.display = 'none';
    }, 4000);
}

// ============================================================
// Cross-Session Animal History Lookup (by EID or VID)
// ============================================================
function lookupAnimalHistory(eid, vid) {
    if (!eid && !vid) return [];

    const allSessions = getAllSessions();
    const history = [];
    const seenIds = new Set();

    function matchRecord(record) {
        if (eid && record.eid === eid) return true;
        if (vid && record.vid && record.vid === vid) return true;
        return false;
    }

    for (const sessionData of allSessions) {
        for (const record of (sessionData.records || [])) {
            if (matchRecord(record) && !seenIds.has(record.id)) {
                seenIds.add(record.id);
                history.push({
                    ...record,
                    sessionName: sessionData.session.name,
                    sessionId: sessionData.session.id,
                });
            }
        }
    }

    // Also check current in-memory records (may not be saved to localStorage yet)
    if (state.session) {
        for (const record of state.records) {
            if (matchRecord(record) && !seenIds.has(record.id)) {
                seenIds.add(record.id);
                history.push({
                    ...record,
                    sessionName: state.session.name,
                    sessionId: state.session.id,
                });
            }
        }
    }

    // Sort by date ascending
    history.sort((a, b) => {
        const da = new Date(a.date || a.timestamp);
        const db = new Date(b.date || b.timestamp);
        return da - db;
    });

    return history;
}

// Backward-compatible alias
function lookupEIDHistory(eid) {
    return lookupAnimalHistory(eid, null);
}

// ============================================================
// Animal History Panel
// ============================================================
function renderAnimalHistory(eid, vid) {
    const panel = dom.animalHistory;
    if (!panel) return;

    if (!eid && !vid) {
        panel.style.display = 'none';
        return;
    }

    const history = lookupAnimalHistory(eid, vid);
    if (history.length === 0) {
        panel.style.display = 'none';
        return;
    }

    panel.style.display = '';
    dom.historyCount.textContent = `${history.length} record${history.length !== 1 ? 's' : ''}`;

    // Last record
    const last = history[history.length - 1];
    dom.historyLastWeight.textContent = `${last.weight} ${last.weightUnit}`;

    const lastDate = new Date(last.date || last.timestamp);
    dom.historyLastDate.textContent = formatShortDate(lastDate);

    // Calculate ADG
    if (state.lockedWeight && history.length >= 1) {
        const daysBetween = (new Date() - lastDate) / (1000 * 60 * 60 * 24);
        if (daysBetween >= 1) {
            const adg = (state.lockedWeight - last.weight) / daysBetween;
            dom.historyAdg.textContent = `${adg >= 0 ? '+' : ''}${adg.toFixed(2)} kg/d`;
            dom.historyAdg.style.color = adg >= 0 ? 'var(--green)' : 'var(--red)';
        } else {
            dom.historyAdg.textContent = 'Same day';
            dom.historyAdg.style.color = 'var(--text-secondary)';
        }
    } else if (history.length >= 2) {
        const prev = history[history.length - 2];
        const prevDate = new Date(prev.date || prev.timestamp);
        const daysBetween = (lastDate - prevDate) / (1000 * 60 * 60 * 24);
        if (daysBetween >= 1) {
            const adg = (last.weight - prev.weight) / daysBetween;
            dom.historyAdg.textContent = `${adg >= 0 ? '+' : ''}${adg.toFixed(2)} kg/d`;
            dom.historyAdg.style.color = adg >= 0 ? 'var(--green)' : 'var(--red)';
        } else {
            dom.historyAdg.textContent = '—';
            dom.historyAdg.style.color = 'var(--text-secondary)';
        }
    } else {
        dom.historyAdg.textContent = '—';
        dom.historyAdg.style.color = 'var(--text-secondary)';
    }

    // Render weight chart
    renderWeightChart(history);

    // Render full record list
    renderHistoryRecordList(history);

    // Fetch cloud ADG from LivestockPro (non-blocking)
    fetchCloudADG(eid, vid);
}

function renderHistoryRecordList(history) {
    let container = document.getElementById('history-record-list');
    if (!container) {
        container = document.createElement('div');
        container.id = 'history-record-list';
        container.className = 'history-record-list';
        dom.animalHistory.appendChild(container);
    }

    if (history.length === 0) {
        container.innerHTML = '';
        return;
    }

    // Show records in reverse chronological order (newest first)
    const reversed = [...history].reverse();
    let html = '<div class="history-list-title">Full History</div>';

    for (const rec of reversed) {
        const date = new Date(rec.date || rec.timestamp);
        const dateStr = formatShortDate(date);
        const weight = rec.weight ? `${rec.weight} ${rec.weightUnit}` : 'No weight';
        const session = rec.sessionName || '';
        const vid = rec.vid ? `VID: ${rec.vid}` : '';
        const notes = rec.notes || '';
        const media = rec.media || [];

        html += '<div class="history-record-item">';
        html += `<div class="history-record-row">`;
        html += `<span class="history-record-date">${dateStr}</span>`;
        html += `<span class="history-record-weight">${weight}</span>`;
        html += `</div>`;
        if (session || vid) {
            html += `<div class="history-record-meta">`;
            if (session) html += `<span>${session}</span>`;
            if (vid) html += `<span>${vid}</span>`;
            html += `</div>`;
        }
        if (notes) {
            html += `<div class="history-record-notes">${notes}</div>`;
        }
        // Show media thumbnails
        if (media.length > 0) {
            html += '<div class="history-record-media">';
            for (const item of media) {
                if (item.type === 'photo' && item.data) {
                    html += `<img class="history-media-thumb" src="${item.data}" alt="Photo">`;
                } else if (item.type === 'video') {
                    html += `<span class="history-media-badge">🎬 Video</span>`;
                }
            }
            html += '</div>';
        }
        html += '</div>';
    }

    container.innerHTML = html;
}

function formatShortDate(date) {
    const opts = { day: 'numeric', month: 'short' };
    if (date.getFullYear() !== new Date().getFullYear()) {
        opts.year = 'numeric';
    }
    return date.toLocaleDateString('en-AU', opts);
}

// ============================================================
// Weight Gain Chart (SVG)
// ============================================================
function renderWeightChart(history) {
    const container = dom.weightChart;
    if (!container) return;

    // Build data points from history
    const points = history
        .map(r => ({
            date: new Date(r.date || r.timestamp),
            weight: r.weight,
            session: r.sessionName || '',
        }))
        .filter(p => p.weight > 0);

    // Add current locked weight as a projected point
    if (state.lockedWeight && state.lockedWeight > 0) {
        const today = new Date();
        const lastPoint = points[points.length - 1];
        // Only add if different day from last point
        if (!lastPoint || (today - lastPoint.date) > 12 * 60 * 60 * 1000) {
            points.push({
                date: today,
                weight: state.lockedWeight,
                isCurrent: true,
                session: 'Current',
            });
        }
    }

    if (points.length < 2) {
        // Single point — just show text
        if (points.length === 1) {
            container.innerHTML = `<div style="text-align:center; padding:12px; color:var(--text-dim); font-size:12px;">Single weigh record — chart needs 2+ points</div>`;
        } else {
            container.innerHTML = '';
        }
        return;
    }

    // Sort by date
    points.sort((a, b) => a.date - b.date);

    const width = container.clientWidth || 320;
    const height = 140;
    const pad = { top: 20, right: 15, bottom: 25, left: 45 };

    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    const weights = points.map(p => p.weight);
    const minW = Math.min(...weights) * 0.97;
    const maxW = Math.max(...weights) * 1.03;
    const wRange = maxW - minW || 1;

    const minDate = points[0].date.getTime();
    const maxDate = points[points.length - 1].date.getTime();
    const dateRange = maxDate - minDate || 1;

    const sx = (d) => pad.left + ((d.getTime() - minDate) / dateRange) * plotW;
    const sy = (w) => pad.top + plotH - ((w - minW) / wRange) * plotH;

    let svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`;

    // Horizontal grid lines
    const gridN = 3;
    for (let i = 0; i <= gridN; i++) {
        const y = pad.top + (plotH / gridN) * i;
        const w = maxW - (wRange / gridN) * i;
        svg += `<line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" stroke="#21262d" stroke-width="1"/>`;
        svg += `<text x="${pad.left - 5}" y="${y + 4}" text-anchor="end" fill="#8b949e" font-size="9" font-family="Inter,sans-serif">${w.toFixed(0)}</text>`;
    }

    // Area fill under the line
    const coords = points.map(p => `${sx(p.date).toFixed(1)},${sy(p.weight).toFixed(1)}`);
    const x0 = sx(points[0].date).toFixed(1);
    const xN = sx(points[points.length - 1].date).toFixed(1);
    const yBottom = (pad.top + plotH).toFixed(1);
    svg += `<polygon points="${x0},${yBottom} ${coords.join(' ')} ${xN},${yBottom}" fill="rgba(57,211,83,0.08)"/>`;

    // Line
    svg += `<polyline points="${coords.join(' ')}" fill="none" stroke="#39d353" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;

    // Data points with labels
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const cx = sx(p.date);
        const cy = sy(p.weight);
        const color = p.isCurrent ? '#58a6ff' : '#39d353';
        const r = p.isCurrent ? 5 : 3.5;
        svg += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r}" fill="${color}"/>`;
        // Weight label (avoid overlap for closely spaced points)
        svg += `<text x="${cx.toFixed(1)}" y="${(cy - 8).toFixed(1)}" text-anchor="middle" fill="${color}" font-size="9" font-family="Inter,sans-serif" font-weight="600">${p.weight.toFixed(1)}</text>`;
    }

    // Date labels on x-axis
    svg += `<text x="${sx(points[0].date).toFixed(1)}" y="${height - 4}" text-anchor="start" fill="#8b949e" font-size="9" font-family="Inter,sans-serif">${formatShortDate(points[0].date)}</text>`;
    svg += `<text x="${sx(points[points.length - 1].date).toFixed(1)}" y="${height - 4}" text-anchor="end" fill="#8b949e" font-size="9" font-family="Inter,sans-serif">${formatShortDate(points[points.length - 1].date)}</text>`;

    svg += '</svg>';
    container.innerHTML = svg;
}

// ============================================================
// Session Statistics
// ============================================================
function calculateSessionStats() {
    const weights = state.records.filter(r => r.weight > 0).map(r => r.weight);
    if (weights.length === 0) return null;

    return {
        count: weights.length,
        total: weights.reduce((a, b) => a + b, 0),
        avg: weights.reduce((a, b) => a + b, 0) / weights.length,
        min: Math.min(...weights),
        max: Math.max(...weights),
    };
}

// ============================================================
// Lock Weight
// ============================================================
function lockWeight() {
    if (state.liveWeight == null || state.liveWeight <= 0) return;

    state.lockedWeight = state.liveWeight;
    state.lockedUnit = state.liveUnit;

    dom.lockedWeightSection.classList.add('visible');
    dom.lockedWeightValue.textContent = `${state.lockedWeight.toFixed(
        scales.lastDecimalPlaces || 1
    )} ${state.lockedUnit}`;

    dom.btnLockWeight.textContent = 'Weight Locked';
    dom.btnLockWeight.classList.add('locked');

    dom.lockedWeightSection.classList.add('flash');
    setTimeout(() => dom.lockedWeightSection.classList.remove('flash'), 1000);

    updateSaveButton();
    debugLog(`Weight locked: ${state.lockedWeight} ${state.lockedUnit}`);

    // Refresh animal history (ADG depends on locked weight)
    if (state.currentEID) {
        const vid = dom.inputVid?.value.trim() || '';
        renderAnimalHistory(state.currentEID, vid);
    }
}

function unlockWeight() {
    state.lockedWeight = null;
    state.lockedUnit = null;

    dom.lockedWeightSection.classList.remove('visible');
    dom.lockedWeightValue.textContent = '0.0 kg';
    dom.btnLockWeight.textContent = 'Lock Weight';
    dom.btnLockWeight.classList.remove('locked');

    updateSaveButton();
}

// ============================================================
// Auto Weigh Mode
// ============================================================
function startAutoWeigh() {
    // Read settings from Auto Weigh screen
    state.autoWeighThreshold = parseFloat(dom.awThreshold?.value) || 5.0;
    state.autoWeighSteadyTime = parseInt(dom.awSteadyTime?.value) || 0;
    state.autoScan = dom.awAutoScan?.checked ?? true;
    state.autoSave = dom.awAutoSave?.checked ?? false;
    state.autoBeep = dom.awBeep?.checked ?? true;
    state.autoWeighCount = 0;
    state.autoWeighActive = true;
    state.autoWeighPhase = 'idle';

    // Sync the inline checkbox on main screen
    if (dom.autoSaveCheckbox) dom.autoSaveCheckbox.checked = state.autoSave;

    // Show bar on main screen
    dom.autoWeighBar.style.display = '';
    dom.btnAutoWeigh.classList.add('btn-auto-weigh-active');
    dom.btnAutoWeigh.textContent = 'Auto';

    // Show status on autoweigh screen
    if (dom.awStatusCard) dom.awStatusCard.style.display = '';
    if (dom.awPhaseDot) dom.awPhaseDot.classList.add('active');
    updateAutoWeighCount();

    // Determine initial phase based on current weight
    if (state.liveWeight != null && state.liveWeight <= state.autoWeighThreshold) {
        setAutoWeighPhase('waiting');
    } else if (state.liveWeight != null && state.liveWeight > state.autoWeighThreshold) {
        setAutoWeighPhase('weighing');
    } else {
        setAutoWeighPhase('idle');
    }

    debugLog(`Auto Weigh started (threshold=${state.autoWeighThreshold}kg, steady=${state.autoWeighSteadyTime}s, autoScan=${state.autoScan}, autoSave=${state.autoSave})`);
}

function stopAutoWeigh() {
    state.autoWeighActive = false;
    state.autoWeighPhase = 'idle';

    // Hide bar on main screen
    dom.autoWeighBar.style.display = 'none';
    dom.btnAutoWeigh.classList.remove('btn-auto-weigh-active');
    dom.btnAutoWeigh.textContent = 'Auto';

    // Update autoweigh screen
    if (dom.awToggle) dom.awToggle.checked = false;
    if (dom.awStatusCard) dom.awStatusCard.style.display = 'none';
    if (dom.awPhaseDot) dom.awPhaseDot.classList.remove('active');

    // Stop any active scan that auto-weigh started
    if (eidReader?._scanning) {
        eidReader.stopScanPolling();
    }

    debugLog('Auto Weigh stopped');
}

function updateAutoWeighCount() {
    if (dom.awAutoCount) dom.awAutoCount.textContent = state.autoWeighCount;
}

function setAutoWeighPhase(phase) {
    state.autoWeighPhase = phase;

    // Update main screen bar
    const el = dom.autoWeighStatus;
    if (el) {
        el.className = 'auto-weigh-status';
        switch (phase) {
            case 'idle':
                el.textContent = 'Initializing...';
                el.classList.add('phase-waiting');
                break;
            case 'waiting':
                el.textContent = 'Scales empty — waiting for animal...';
                el.classList.add('phase-waiting');
                break;
            case 'weighing':
                el.textContent = 'Animal detected — waiting for steady weight...';
                el.classList.add('phase-weighing');
                break;
            case 'scanning':
                el.textContent = 'Weight locked — scanning for EID...';
                el.classList.add('phase-scanning');
                break;
            case 'ready':
                el.textContent = state.autoSave ? 'Saving record...' : 'Ready — tap Save Record';
                el.classList.add('phase-ready');
                break;
        }
    }

    // Update autoweigh screen status
    if (dom.awPhaseText) {
        const labels = {
            idle: 'Initializing...',
            waiting: 'Waiting for animal',
            weighing: 'Weighing...',
            scanning: 'Scanning for EID...',
            ready: state.autoSave ? 'Auto-saving...' : 'Ready to save',
        };
        dom.awPhaseText.textContent = labels[phase] || phase;
    }
}

/**
 * Called on every weight event when Auto Weigh is active.
 * Drives the auto weigh state machine.
 */
let _autoWeighSteadyStart = null;

function processAutoWeigh(data) {
    if (!state.autoWeighActive) return;

    const weight = data.weight;
    const isSteady = data.isSteady;
    const threshold = state.autoWeighThreshold;

    // Update current weight on autoweigh screen
    if (dom.awCurrentWeight) {
        dom.awCurrentWeight.textContent = weight > 0 ? `${data.weightDisplay} ${data.unit}` : '—';
    }

    // Only process on main screen
    const isMainScreen = screens.main.classList.contains('active');
    if (!isMainScreen) return;

    switch (state.autoWeighPhase) {
        case 'idle':
            // Wait for scales to read near-zero (empty)
            if (weight <= threshold) {
                setAutoWeighPhase('waiting');
            }
            break;

        case 'waiting':
            // Scales are empty — waiting for animal to step on
            _autoWeighSteadyStart = null;
            if (weight > threshold) {
                setAutoWeighPhase('weighing');
            }
            break;

        case 'weighing':
            // Animal on scales — waiting for steady reading
            if (weight <= threshold) {
                // Animal stepped off before we locked — go back to waiting
                _autoWeighSteadyStart = null;
                setAutoWeighPhase('waiting');
            } else if (isSteady && weight > threshold) {
                // Check steady time requirement
                const requiredMs = state.autoWeighSteadyTime * 1000;
                if (requiredMs > 0) {
                    if (!_autoWeighSteadyStart) {
                        _autoWeighSteadyStart = Date.now();
                    }
                    if (Date.now() - _autoWeighSteadyStart < requiredMs) {
                        break; // Not steady long enough yet
                    }
                }

                _autoWeighSteadyStart = null;

                // Steady weight — auto-lock it
                lockWeight();
                if (state.autoBeep) playBeep(800, 150);
                setAutoWeighPhase(state.autoScan ? 'scanning' : 'ready');

                // Auto-trigger continuous EID scan
                if (state.autoScan) {
                    autoWeighStartScan();
                }
            } else {
                // Not steady — reset steady timer
                _autoWeighSteadyStart = null;
            }
            break;

        case 'scanning':
            // Weight is locked, scanning for EID
            // If weight drops below threshold and weight was already saved/unlocked
            if (weight <= threshold && state.lockedWeight == null) {
                if (eidReader?._scanning) {
                    eidReader.stopScanPolling();
                }
                setAutoWeighPhase('waiting');
            }
            break;

        case 'ready':
            // Waiting for save (manual or auto)
            break;
    }
}

/** Simple beep using Web Audio API */
function playBeep(freq = 800, durationMs = 150) {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = freq;
        gain.gain.value = 0.3;
        osc.start();
        osc.stop(ctx.currentTime + durationMs / 1000);
    } catch (_) { /* audio not available */ }
}

// ============================================================
// Voice Dictation (Web Speech API)
// ============================================================
let speechRecognition = null;

function toggleVoiceDictation() {
    if (speechRecognition) {
        speechRecognition.stop();
        return;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        showToast('Voice dictation not supported on this browser', 'warning');
        return;
    }

    speechRecognition = new SpeechRecognition();
    speechRecognition.continuous = true;
    speechRecognition.interimResults = true;
    speechRecognition.lang = 'en-AU';

    const startText = dom.inputNotes.value;

    dom.btnMic.classList.add('recording');
    dom.notesSection?.classList.add('recording');
    debugLog('Voice dictation started');

    speechRecognition.onresult = (event) => {
        let transcript = '';
        for (let i = 0; i < event.results.length; i++) {
            transcript += event.results[i][0].transcript;
        }
        dom.inputNotes.value = startText + (startText ? ' ' : '') + transcript;
    };

    speechRecognition.onerror = (event) => {
        debugLog(`Speech error: ${event.error}`);
        if (event.error === 'not-allowed') {
            showToast('Microphone access denied', 'warning');
        }
        stopVoiceDictation();
    };

    speechRecognition.onend = () => {
        stopVoiceDictation();
    };

    speechRecognition.start();
}

function stopVoiceDictation() {
    if (speechRecognition) {
        try { speechRecognition.stop(); } catch (_) {}
        speechRecognition = null;
    }
    dom.btnMic?.classList.remove('recording');
    dom.notesSection?.classList.remove('recording');
    debugLog('Voice dictation stopped');
}

async function autoWeighStartScan() {
    // Use eidReader directly — don't call ensureReaderConnected() because
    // that tries to open the BLE picker, which requires a user gesture
    // and fails when called from the auto-weigh timer/weight event.
    const reader = eidReader;
    if (!reader || !state.readerConnected) {
        debugLog('Auto Weigh: reader not connected — skipping scan');
        showToast('Connect EID reader first', 'warning');
        setAutoWeighPhase('ready'); // Still let user save manually
        return;
    }

    // Stop any stale scan from previous cycle before starting fresh
    if (reader._scanning) {
        reader.stopScanPolling();
        // Small delay to let cleanup finish
        await new Promise(r => setTimeout(r, 100));
    }

    dom.btnAutoScanEid.textContent = 'Scanning...';
    dom.btnAutoScanEid.classList.add('scanning');
    dom.btnScanEid.disabled = true;

    await reader.startScanPolling({ continuous: true, stopOnTag: true });
    debugLog('Auto Weigh: continuous scan started');
}

/**
 * Called when EID state changes (tag scanned or manually entered).
 * Checks if auto-weigh should advance to "ready" phase.
 */
function autoWeighCheckReady() {
    if (!state.autoWeighActive) return;
    if (state.autoWeighPhase !== 'scanning' && state.autoWeighPhase !== 'ready') return;

    if (state.currentEID && state.lockedWeight != null) {
        if (state.autoBeep) playBeep(1000, 100);
        setAutoWeighPhase('ready');

        if (state.autoSave) {
            // Small delay so the user sees the EID flash
            setTimeout(() => {
                if (state.autoWeighActive && state.autoWeighPhase === 'ready') {
                    state.autoWeighCount++;
                    updateAutoWeighCount();
                    if (state.autoBeep) playBeep(600, 200);
                    saveRecord();
                }
            }, 500);
        }
    }
}

/**
 * Called after a record is saved. If auto weigh is active,
 * reset to waiting for the next animal.
 */
function autoWeighAfterSave() {
    if (!state.autoWeighActive) return;

    // Stop any active scan from this cycle so next cycle starts fresh
    if (eidReader?._scanning) {
        eidReader.stopScanPolling();
    }

    // Check current weight to determine next phase
    if (state.liveWeight != null && state.liveWeight <= state.autoWeighThreshold) {
        setAutoWeighPhase('waiting');
    } else {
        // Animal still on scales — wait for it to step off
        setAutoWeighPhase('idle');
    }
}

// ============================================================
// Save Record
// ============================================================
function updateSaveButton() {
    const hasWeight = state.lockedWeight != null;
    const hasEID = state.currentEID != null;
    const hasVID = !!(dom.inputVid?.value.trim());
    dom.btnSaveRecord.disabled = !hasWeight && !hasEID && !hasVID;
}

async function saveRecord() {
    const eid = getEIDFromInput();
    const dateValue = dom.inputDate?.value || new Date().toISOString().slice(0, 10);

    const vid = dom.inputVid?.value.trim() || '';

    // Convert media files to base64 for storage (photos only — videos too large)
    const mediaData = [];
    for (const item of mediaFiles) {
        if (item.type === 'photo' && item.blob.size < 2 * 1024 * 1024) {
            try {
                const base64 = await blobToBase64(item.blob);
                mediaData.push({ type: 'photo', data: base64, name: item.name });
            } catch (e) {
                debugLog(`Failed to encode photo: ${e.message}`);
            }
        } else if (item.type === 'video') {
            // Store video reference only (too large for localStorage)
            mediaData.push({ type: 'video', name: item.name, size: item.blob.size });
        }
    }

    const record = {
        id: crypto.randomUUID(),
        eid: eid || '',
        vid: vid,
        weight: state.lockedWeight || 0,
        weightUnit: state.lockedUnit || state.liveUnit,
        date: dateValue,
        notes: dom.inputNotes.value.trim(),
        media: mediaData.length > 0 ? mediaData : undefined,
        medicalBatchUuid: dom.inputMedicalBatch?.value || '',
        timestamp: new Date().toISOString(),
    };

    state.records.push(record);
    saveSessionToStorage();

    // Records will be pushed to cloud on next manual sync

    // Sync to LivestockPro (primary) — non-blocking, will push on next sync
    // Records are marked lpSynced after successful pushData() call

    const eidDisplay = eid || 'No EID';
    const weightDisplay = record.weight ? `${record.weight} ${record.weightUnit}` : '';
    debugLog(`Record saved: EID=${eidDisplay} Weight=${weightDisplay}`);

    updateFooter();

    // Show prominent save feedback
    showSaveToast(eidDisplay, weightDisplay);

    // Reset for next animal
    setCurrentEID(null);
    unlockWeight();
    dom.inputNotes.value = '';
    stopVoiceDictation();
    if (dom.inputVid) dom.inputVid.value = '';
    // Don't reset medical batch — user likely weighing same batch
    clearMediaFiles();
    dom.btnSaveRecord.disabled = true;
    // Reset date to today
    if (dom.inputDate) {
        dom.inputDate.value = new Date().toISOString().slice(0, 10);
    }

    dom.btnSaveRecord.textContent = '✓ Saved!';
    dom.btnSaveRecord.style.opacity = '0.7';
    setTimeout(() => {
        dom.btnSaveRecord.textContent = 'Save Record';
        dom.btnSaveRecord.style.opacity = '';
    }, 3000);

    // Focus EID input for next scan/entry
    focusEidIfDesktop();

    // Auto Weigh: reset for next animal
    autoWeighAfterSave();
}

function showSaveToast(eid, weight) {
    const toast = $('scan-toast');
    const text = $('scan-toast-text');
    if (!toast || !text) return;

    text.textContent = `✓ Saved: ${eid}${weight ? ' — ' + weight : ''}`;
    toast.classList.remove('toast-warning', 'toast-info');
    toast.classList.add('toast-success');
    toast.style.display = '';
    toast.style.animation = 'none';
    toast.offsetHeight;
    toast.style.animation = '';

    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => {
        toast.style.display = 'none';
    }, 4000);
}

function updateFooter() {
    const count = state.records.length;
    dom.footerCount.textContent = `Records: ${count}`;

    if (state.session?.expectedCount) {
        dom.footerExpected.textContent = `/ ${state.session.expectedCount}`;
    }

    // Update session count badge
    const countNum = $('session-count-number');
    if (countNum) {
        countNum.textContent = count;
    }

    if (count > 0) {
        const last = state.records[count - 1];
        const eid = last.eid || 'No EID';
        const weight = last.weight ? `${last.weight} ${last.weightUnit}` : 'No weight';
        dom.footerLast.textContent = `Last: ${eid} - ${weight}`;
    }

    // Session statistics
    const stats = calculateSessionStats();
    if (stats && dom.sessionStats) {
        dom.sessionStats.style.display = '';
        dom.statTotal.textContent = `${stats.total.toFixed(0)} kg`;
        dom.statAvg.textContent = `${stats.avg.toFixed(1)} kg`;
        dom.statMin.textContent = `${stats.min.toFixed(1)} kg`;
        dom.statMax.textContent = `${stats.max.toFixed(1)} kg`;
    } else if (dom.sessionStats) {
        dom.sessionStats.style.display = 'none';
    }

    // Update recent records on main screen
    renderRecentRecords();
}

function renderRecentRecords() {
    if (!dom.recentRecords || !dom.recentRecordsList) return;

    if (state.records.length === 0) {
        dom.recentRecords.style.display = 'none';
        return;
    }

    dom.recentRecords.style.display = '';

    // Show last 5 records (newest first)
    const recent = [...state.records].reverse().slice(0, 5);
    let html = '';

    for (const rec of recent) {
        const eid = rec.eid || 'No EID';
        const eidShort = rec.eid
            ? (rec.eid.length > 10 ? '...' + rec.eid.slice(-8) : rec.eid)
            : 'No EID';
        const vid = rec.vid ? ` | ${rec.vid}` : '';
        const weight = rec.weight ? `${rec.weight} ${rec.weightUnit}` : '—';
        const time = new Date(rec.timestamp).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
        const notes = rec.notes ? ` — ${rec.notes}` : '';

        html += `<div class="recent-record-item">`;
        html += `<div class="recent-record-main">`;
        html += `<span class="recent-record-eid">${eidShort}${vid}</span>`;
        html += `<span class="recent-record-weight">${weight}</span>`;
        html += `</div>`;
        html += `<div class="recent-record-sub">${time}${notes}</div>`;
        html += `</div>`;
    }

    dom.recentRecordsList.innerHTML = html;
}

// ============================================================
// Session Management
// ============================================================
function createSession() {
    state.session = {
        id: crypto.randomUUID(),
        name: dom.inputSessionName.value.trim() || 'Session',
        mob: dom.inputMob.value.trim(),
        paddock: dom.inputPaddock.value.trim(),
        expectedCount: parseInt(dom.inputExpected.value) || 0,
        createdAt: new Date().toISOString(),
    };
    state.records = [];

    // Session will be pushed to cloud on next manual sync

    dom.inputSessionName.value = '';
    dom.inputMob.value = '';
    dom.inputPaddock.value = '';
    dom.inputExpected.value = '';

    enterSession();
}

function resumeSession(sessionId) {
    const raw = localStorage.getItem(`agrieid_session_${sessionId}`);
    if (!raw) return;

    try {
        const data = JSON.parse(raw);
        state.session = data.session;
        state.records = data.records || [];
        enterSession();
    } catch (e) {
        debugLog(`Failed to load session: ${e.message}`);
    }
}

function enterSession() {
    dom.sessionNameDisplay.textContent = [
        state.session.name,
        state.session.mob,
        state.session.paddock
    ].filter(Boolean).join(' - ');

    dom.footerExpected.textContent = '';
    saveSessionToStorage();
    updateFooter();
    setCurrentEID(null);
    unlockWeight();
    showScreen('main');
}

function deleteSession(sessionId) {
    localStorage.removeItem(`agrieid_session_${sessionId}`);

    const index = getSessionIndex();
    const updated = index.filter(id => id !== sessionId);
    localStorage.setItem('agrieid_session_index', JSON.stringify(updated));

    if (state.session?.id === sessionId) {
        state.session = null;
        state.records = [];
    }

    renderDashboard();
}

// ============================================================
// Dashboard
// ============================================================
function getSessionIndex() {
    try {
        const raw = localStorage.getItem('agrieid_session_index');
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

function addToSessionIndex(sessionId) {
    const index = getSessionIndex();
    if (!index.includes(sessionId)) {
        index.push(sessionId);
        localStorage.setItem('agrieid_session_index', JSON.stringify(index));
    }
}

function getAllSessions() {
    const index = getSessionIndex();
    const sessions = [];

    for (const id of index) {
        const raw = localStorage.getItem(`agrieid_session_${id}`);
        if (raw) {
            try {
                const data = JSON.parse(raw);
                sessions.push(data);
            } catch { /* skip corrupt */ }
        }
    }

    // Scan for sessions not in index (migration)
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key.startsWith('agrieid_session_') && key !== 'agrieid_session_index') {
            const id = key.replace('agrieid_session_', '');
            if (!index.includes(id)) {
                try {
                    const data = JSON.parse(localStorage.getItem(key));
                    if (data.session?.id) {
                        sessions.push(data);
                        addToSessionIndex(data.session.id);
                    }
                } catch { /* skip */ }
            }
        }
    }

    sessions.sort((a, b) => {
        const da = new Date(a.session.createdAt || 0);
        const db = new Date(b.session.createdAt || 0);
        return db - da;
    });

    return sessions;
}

function renderDashboard() {
    const sessions = getAllSessions();
    dom.dashboardList.innerHTML = '';

    if (sessions.length === 0) {
        dom.dashboardList.innerHTML = '<div class="dashboard-empty">No sessions yet. Tap "+ New Session" to start.</div>';
        return;
    }

    for (const data of sessions) {
        const s = data.session;
        const count = (data.records || []).length;
        const date = new Date(s.createdAt);
        const dateStr = date.toLocaleDateString('en-AU', {
            day: 'numeric', month: 'short', year: 'numeric'
        });
        const timeStr = date.toLocaleTimeString('en-AU', {
            hour: '2-digit', minute: '2-digit'
        });

        const meta = [s.mob, s.paddock].filter(Boolean).join(' | ');
        const isActive = state.session?.id === s.id;

        const el = document.createElement('div');
        el.className = 'dashboard-item';
        if (isActive) {
            el.style.borderColor = 'var(--green)';
        }

        el.innerHTML = `
            <div class="dashboard-item-left">
                <div class="dashboard-item-name">${s.name}${isActive ? ' (Active)' : ''}</div>
                <div class="dashboard-item-meta">
                    ${meta ? `<span>${meta}</span>` : ''}
                    ${s.expectedCount ? `<span>Expected: ${s.expectedCount}</span>` : ''}
                </div>
            </div>
            <div class="dashboard-item-right">
                <div class="dashboard-item-count">${count}</div>
                <div class="dashboard-item-date">${dateStr}</div>
                <div class="dashboard-item-date">${timeStr}</div>
            </div>
        `;

        el.addEventListener('click', (e) => {
            if (e.target.closest('.dashboard-delete-btn')) return;
            resumeSession(s.id);
        });

        dom.dashboardList.appendChild(el);
    }
}

// ============================================================
// Records Screen
// ============================================================
function showRecords() {
    dom.recordsSessionName.textContent = state.session?.name || 'Session';
    dom.recordsTotal.textContent = `${state.records.length} records`;

    dom.recordsList.innerHTML = '';

    // Build EID→weight history cache for ADG calculations
    const eidHistoryCache = buildEidHistoryCache();

    const sorted = [...state.records].reverse();
    for (const record of sorted) {
        const el = document.createElement('div');
        el.className = 'record-item';

        const eidFormatted = record.eid
            ? (record.eid.length >= 4
                ? record.eid.slice(0, 3) + ' ' + record.eid.slice(3)
                : record.eid)
            : 'No EID';

        const vidFormatted = record.vid ? ` | VID: ${record.vid}` : '';

        const weightFormatted = record.weight
            ? `${record.weight} ${record.weightUnit}`
            : 'No weight';

        const recordDate = record.date
            ? new Date(record.date + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })
            : new Date(record.timestamp).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
        const time = new Date(record.timestamp).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });

        const mediaCount = record.media?.length || 0;
        const mediaIcon = mediaCount > 0 ? ` | ${mediaCount} media` : '';

        // Calculate ADG badge
        const adgHtml = calculateRecordADGBadge(record, eidHistoryCache);

        el.innerHTML = `
            <div class="record-item-left">
                <div class="record-item-eid">${eidFormatted}${vidFormatted}</div>
                <div class="record-item-time">${recordDate} ${time}${record.notes ? ' - ' + record.notes : ''}${mediaIcon}</div>
                <div class="record-item-actions">
                    <button class="record-action-btn reweigh-btn" data-id="${record.id}">Re-weigh</button>
                    <button class="record-action-btn delete-btn" data-id="${record.id}">Delete</button>
                </div>
            </div>
            <div class="record-item-right">
                <div class="record-item-weight">${weightFormatted}${adgHtml}</div>
            </div>
        `;

        el.querySelector('.reweigh-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            reweighRecord(record.id);
        });

        el.querySelector('.delete-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            deleteRecord(record.id);
        });

        dom.recordsList.appendChild(el);
    }

    showScreen('records');
}

/**
 * Build a cache of EID→sorted weight history across all sessions.
 * Used for efficient ADG calculation on the records list.
 */
function buildEidHistoryCache() {
    const cache = new Map();
    const allSessions = getAllSessions();

    for (const sessionData of allSessions) {
        for (const record of (sessionData.records || [])) {
            const key = record.eid;
            if (!key || !record.weight || record.weight <= 0) continue;
            if (!cache.has(key)) cache.set(key, []);
            cache.get(key).push({
                weight: record.weight,
                date: record.date || record.timestamp,
                id: record.id,
            });
        }
    }

    // Also include current in-memory records
    for (const record of state.records) {
        const key = record.eid;
        if (!key || !record.weight || record.weight <= 0) continue;
        if (!cache.has(key)) cache.set(key, []);
        // Avoid duplicates
        const arr = cache.get(key);
        if (!arr.some(r => r.id === record.id)) {
            arr.push({
                weight: record.weight,
                date: record.date || record.timestamp,
                id: record.id,
            });
        }
    }

    // Sort each EID's records by date
    for (const [, records] of cache) {
        records.sort((a, b) => new Date(a.date) - new Date(b.date));
    }

    return cache;
}

/**
 * Calculate ADG badge HTML for a given record.
 * Finds the previous weight for the same EID and computes daily gain.
 */
function calculateRecordADGBadge(record, cache) {
    if (!record.eid || !record.weight || record.weight <= 0) return '';

    const history = cache.get(record.eid);
    if (!history || history.length < 2) return '';

    // Find this record's index in the sorted history
    const idx = history.findIndex(h => h.id === record.id);
    if (idx <= 0) return ''; // First record for this EID or not found

    const prev = history[idx - 1];
    const currDate = new Date(record.date || record.timestamp);
    const prevDate = new Date(prev.date);
    const daysBetween = (currDate - prevDate) / (1000 * 60 * 60 * 24);

    if (daysBetween < 1) return ''; // Same day, can't calculate meaningful ADG

    const adg = (record.weight - prev.weight) / daysBetween;
    const adgClass = adg > 0.01 ? 'adg-gain' : adg < -0.01 ? 'adg-loss' : 'adg-neutral';
    const sign = adg >= 0 ? '+' : '';

    return `<span class="adg-badge ${adgClass}">${sign}${adg.toFixed(2)} kg/d</span>`;
}

function deleteRecord(recordId) {
    const idx = state.records.findIndex(r => r.id === recordId);
    if (idx === -1) return;

    const record = state.records[idx];
    const eid = record.eid || 'No EID';
    if (!confirm(`Delete record for ${eid}?`)) return;

    state.records.splice(idx, 1);
    saveSessionToStorage();
    updateFooter();
    debugLog(`Record deleted: ${eid}`);

    showRecords();
}

function reweighRecord(recordId) {
    const idx = state.records.findIndex(r => r.id === recordId);
    if (idx === -1) return;

    const record = state.records[idx];

    state.records.splice(idx, 1);
    saveSessionToStorage();
    updateFooter();

    setCurrentEID(record.eid || null);
    if (dom.inputVid) dom.inputVid.value = record.vid || '';
    dom.inputNotes.value = record.notes || '';
    unlockWeight();

    debugLog(`Re-weighing: ${record.eid || 'No EID'} (old weight: ${record.weight} ${record.weightUnit})`);

    showScreen('main');
}

// ============================================================
// CSV Export
// ============================================================
async function exportCSV() {
    if (state.records.length === 0) return;

    const headers = ['EID', 'VID', 'Weight', 'Unit', 'Date', 'Notes', 'Timestamp'];
    // Wrap EID/VID in ="..." so spreadsheet apps treat them as text, not numbers
    const rows = state.records.map(r => [
        r.eid ? `="${r.eid}"` : '',
        r.vid ? `="${r.vid}"` : '',
        r.weight,
        r.weightUnit,
        r.date || '',
        `"${(r.notes || '').replace(/"/g, '""')}"`,
        r.timestamp
    ]);

    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const filename = `${state.session?.name || 'session'}_${new Date().toISOString().slice(0, 10)}.csv`;

    await downloadCSVFile(csv, filename);
    debugLog('CSV exported');
}

// ============================================================
// Local Storage
// ============================================================
function saveSessionToStorage() {
    if (!state.session) return;
    const data = {
        session: state.session,
        records: state.records,
    };
    localStorage.setItem(`agrieid_session_${state.session.id}`, JSON.stringify(data));
    localStorage.setItem('agrieid_last_session', state.session.id);
    addToSessionIndex(state.session.id);
}

// ============================================================
// UI Helpers
// ============================================================
function updateStartButton() {
    // Sessions are always accessible — scales connection is optional
    if (dom.btnNewSessionSetup) dom.btnNewSessionSetup.disabled = false;
    if (dom.btnHistoricSessions) dom.btnHistoricSessions.disabled = false;
}

function updateMainUI() {
    if (!state.scalesConnected) {
        updateWeightDisplay(null);
    }
}

// ============================================================
// Global Scanner Keyboard Listener
// Captures scanner input on ALL screens — the BTU Stick types
// EID digits as rapid keystrokes via HID keyboard.
// Works whether or not the EID field is focused.
// ============================================================
function handleGlobalKeydown(e) {
    const now = Date.now();
    const isMainScreen = screens.main.classList.contains('active');
    const isEidFocused = document.activeElement === dom.inputEid;

    // === DIGIT KEYS ===
    if (/^\d$/.test(e.key)) {
        // Reset buffer if gap too large (new input sequence)
        if (now - scanner.lastKeyTime > 500) {
            scanner.buffer = '';
        }
        const prevKeyTime = scanner.lastKeyTime;
        scanner.buffer += e.key;
        scanner.lastKeyTime = now;

        // Debug logging for scanner diagnosis
        if (state.debugMode) {
            const gap = scanner.buffer.length > 1
                ? `${now - prevKeyTime}ms`
                : 'start';
            debugLog(`Key: ${e.key}  buf: ${scanner.buffer}  gap: ${gap}`);
        }

        if (isMainScreen && !isEidFocused) {
            // On main screen with EID not focused — redirect ONLY if no other input has focus
            const tag = document.activeElement?.tagName;
            if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
                e.preventDefault();
                dom.inputEid.value += e.key;
                focusEidIfDesktop();
                updateEIDState();
            }
            // If user is typing in date/notes, let it through (scanner buffer still tracks)
        } else if (!isMainScreen) {
            // Not on main screen — capture digit silently (prevent it going to random elements)
            const tag = document.activeElement?.tagName;
            if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
                e.preventDefault();
            }
        }
        // If EID input is focused on main screen, let browser insert digit naturally
        return;
    }

    // === ENTER KEY ===
    if (e.key === 'Enter') {
        const wasScanner = scanner.buffer.length >= 10 && (now - scanner.lastKeyTime < 500);

        if (wasScanner) {
            e.preventDefault();
            e.stopPropagation();

            const scannedEID = scanner.buffer;
            scanner.buffer = '';
            debugLog(`Scanner complete: ${scannedEID}`);

            if (isMainScreen) {
                // Set EID directly on the weighing screen
                setCurrentEID(scannedEID);
                dom.eidSection.classList.add('scanned');
                setTimeout(() => dom.eidSection.classList.remove('scanned'), 1500);

                // Focus notes field — user must press Save Record manually
                { if (!isTouchDevice) dom.inputNotes.focus(); };
            } else {
                // Buffer EID — will be applied when user navigates to main screen
                state.pendingEID = scannedEID;
                debugLog(`EID buffered — navigate to weighing screen to use`);
                showScanToast(scannedEID);
            }
            return;
        }

        // Not a scanner Enter — normal handling
        scanner.buffer = '';

        // Manual Enter on EID input → move to notes
        if (isMainScreen && isEidFocused) {
            const eid = getEIDFromInput();
            if (eid) {
                e.preventDefault();
                { if (!isTouchDevice) dom.inputNotes.focus(); };
            }
        }
        // Notes Enter handled by its own listener
        return;
    }

    // Any other key — reset buffer if gap is large
    if (now - scanner.lastKeyTime > 500) {
        scanner.buffer = '';
    }
}

// ============================================================
// Utility: Blob to Base64
// ============================================================
function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

// ============================================================
// Event Listeners
// ============================================================
function init() {
    // Cloud sync — update UI on online/offline changes
    window.addEventListener('online', () => updateSyncBadge());
    window.addEventListener('offline', () => updateSyncBadge());

    // Check Web Bluetooth / Web Serial support
    const hasBluetooth = !!navigator.bluetooth;
    if (!hasBluetooth) {
        debugLog('Web Bluetooth not supported in this browser.');
        debugLog('Scales: use Chrome on desktop, or Bluefy on iOS.');
    }

    // Show iOS hint if on Apple mobile device without Bluetooth support (Safari)
    const isAppleMobile = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const iosHint = document.getElementById('ios-hint');
    if (isAppleMobile && !hasBluetooth && iosHint) {
        iosHint.style.display = '';
    }
    // Setup screen — scales connection
    dom.btnConnectScales.addEventListener('click', async () => {
        if (!navigator.bluetooth) {
            showToast('Scales require Bluetooth — use Chrome on desktop or Bluefy browser on iOS', 'warning');
            return;
        }
        dom.btnConnectScales.textContent = 'Connecting...';
        dom.btnConnectScales.disabled = true;
        const ok = await scales.connect();
        if (!ok) {
            dom.btnConnectScales.textContent = 'Connect Scales';
            dom.btnConnectScales.disabled = false;
        }
    });

    dom.btnDisconnectScales.addEventListener('click', () => {
        scales.disconnect();
    });

    // Setup screen — reader connection
    // Main button: BLE (works on Bluefy iOS + Chrome desktop)
    dom.btnConnectReader.addEventListener('click', () => {
        if (!navigator.bluetooth) {
            showToast('EID Reader requires Chrome on desktop or Bluefy on iOS', 'warning');
            return;
        }
        connectReader(false);
    });
    dom.btnDisconnectReader.addEventListener('click', disconnectReader);
    dom.btnDownloadTags.addEventListener('click', downloadStoredTags);
    dom.btnDeleteReaderTags.addEventListener('click', deleteReaderTags);

    // Setup screen buttons
    dom.btnNewSessionSetup.addEventListener('click', () => {
        showScreen('session');
    });
    dom.btnHistoricSessions.addEventListener('click', () => {
        showScreen('dashboard');
    });

    // Cloud Data button
    const btnCloudData = $('btn-cloud-data');
    if (btnCloudData) {
        btnCloudData.addEventListener('click', () => {
            showScreen('cloud-dashboard');
        });
    }

    // Cloud Login toggle button
    const btnCloudToggle = $('btn-cloud-toggle');
    if (btnCloudToggle) {
        btnCloudToggle.addEventListener('click', toggleCloudDropdown);
    }

    // Cloud Dashboard — back button
    const btnCloudDashBack = $('btn-cloud-dash-back');
    if (btnCloudDashBack) {
        btnCloudDashBack.addEventListener('click', () => showScreen('setup'));
    }

    // Animal Detail — back button
    const btnAnimalBack = $('btn-animal-back');
    if (btnAnimalBack) {
        btnAnimalBack.addEventListener('click', () => showScreen('cloud-dashboard'));
    }

    dom.btnDebugToggle.addEventListener('click', () => {
        state.debugMode = !state.debugMode;
        dom.debugPanel.classList.toggle('visible', state.debugMode);
    });

    // Debug panel copy button
    const btnDebugCopy = $('btn-debug-copy');
    if (btnDebugCopy) {
        btnDebugCopy.addEventListener('click', () => {
            const lines = Array.from(dom.debugPanel.querySelectorAll('div'))
                .map(el => el.textContent)
                .join('\n');
            navigator.clipboard.writeText(lines).then(() => {
                btnDebugCopy.textContent = '✅';
                setTimeout(() => { btnDebugCopy.textContent = '📋'; }, 1500);
            }).catch(() => {
                // Fallback for non-secure contexts
                const ta = document.createElement('textarea');
                ta.value = lines;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                btnDebugCopy.textContent = '✅';
                setTimeout(() => { btnDebugCopy.textContent = '📋'; }, 1500);
            });
        });
    }

    // Cloud sync — login/logout
    const btnCloudLogin = $('btn-cloud-login');
    const btnCloudLogout = $('btn-cloud-logout');

    if (btnCloudLogin) btnCloudLogin.addEventListener('click', cloudLogin);
    if (btnCloudLogout) btnCloudLogout.addEventListener('click', cloudLogout);

    // Biometric login button
    const btnBiometric = $('btn-biometric-login');
    if (btnBiometric) {
        btnBiometric.addEventListener('click', biometricLogin);
        // Show biometric button if enrolled and WebAuthn available
        if (localStorage.getItem('ae_biometric_credId') && window.PublicKeyCredential) {
            btnBiometric.style.display = '';
        }
    }

    // Load saved credentials into form
    loadSavedCredentials();

    // Allow Enter key to submit login
    $('cloud-password')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') cloudLogin();
    });

    updateCloudUI();

    // LivestockPro — button event listeners
    if (dom.btnLpPush) dom.btnLpPush.addEventListener('click', lpPushData);
    if (dom.btnLpPull) dom.btnLpPull.addEventListener('click', lpPullData);
    if (dom.btnLpFetchBatches) dom.btnLpFetchBatches.addEventListener('click', () => lpFetchBatches(false));

    // New Batch modal
    if (dom.btnNewBatch) dom.btnNewBatch.addEventListener('click', openNewBatchModal);
    if (dom.btnBatchSave) dom.btnBatchSave.addEventListener('click', saveNewBatch);
    if (dom.btnBatchCancel) dom.btnBatchCancel.addEventListener('click', closeNewBatchModal);
    if (dom.btnBatchCancel2) dom.btnBatchCancel2.addEventListener('click', closeNewBatchModal);
    // Close modal on overlay click
    dom.modalNewBatch?.addEventListener('click', (e) => {
        if (e.target === dom.modalNewBatch) closeNewBatchModal();
    });
    // Enter key saves batch
    dom.inputBatchName?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') saveNewBatch();
    });

    // Identify Animal button
    if (dom.btnIdentifyAnimal) dom.btnIdentifyAnimal.addEventListener('click', identifyAnimal);
    dom.inputIdentifyPhoto?.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) processIdentifyPhoto(file);
        e.target.value = '';
    });

    // Initialize LivestockPro auth (restore from localStorage)
    lpSync.loadAuth();
    if (lpSync.isLoggedIn()) {
        debugLog('LivestockPro: restored session for ' + (lpSync.getUser()?.name || 'user'));
        // Load cached medical batches into dropdown (includes local batches)
        loadCachedMedicalBatches();
        // Refresh batches in background
        lpFetchBatches(true);
    } else {
        // Still load local batches even if LP not connected
        refreshMedicalBatchDropdown();
    }
    updateCloudUI();

    // Show last sync time
    updateLastSyncDisplay();

    // Dashboard screen
    dom.btnNewSession.addEventListener('click', () => {
        showScreen('session');
    });

    dom.btnDashboardSetup.addEventListener('click', () => {
        showScreen('setup');
    });

    // Session screen
    dom.btnCreateSession.addEventListener('click', createSession);

    dom.btnSessionBack.addEventListener('click', () => {
        showScreen('dashboard');
    });

    // Main screen — lock weight
    dom.btnLockWeight.addEventListener('click', () => {
        if (state.lockedWeight != null) {
            unlockWeight();
        } else {
            lockWeight();
        }
    });

    // Auto Weigh — open settings screen
    dom.btnAutoWeigh.addEventListener('click', () => {
        showScreen('autoweigh');
    });

    // Auto Weigh — stop from main screen bar
    dom.btnStopAutoWeigh?.addEventListener('click', () => {
        stopAutoWeigh();
    });

    // Auto Weigh — inline auto-save checkbox sync
    dom.autoSaveCheckbox?.addEventListener('change', () => {
        state.autoSave = dom.autoSaveCheckbox.checked;
        if (dom.awAutoSave) dom.awAutoSave.checked = state.autoSave;
        debugLog(`Auto Save ${state.autoSave ? 'enabled' : 'disabled'}`);
    });

    // Auto Weigh screen — master toggle
    dom.awToggle?.addEventListener('change', () => {
        if (dom.awToggle.checked) {
            startAutoWeigh();
            showScreen('main');
        } else {
            stopAutoWeigh();
        }
    });

    // Auto Weigh screen — back button
    dom.btnAutoweighBack?.addEventListener('click', () => {
        showScreen('main');
    });

    // Auto Weigh screen — sync auto-save checkbox to inline
    dom.awAutoSave?.addEventListener('change', () => {
        state.autoSave = dom.awAutoSave.checked;
        if (dom.autoSaveCheckbox) dom.autoSaveCheckbox.checked = state.autoSave;
    });

    // EID input — manual typing (scanner handled by global listener)
    dom.inputEid.addEventListener('input', updateEIDState);

    // VID input — triggers save button update and animal history lookup
    dom.inputVid?.addEventListener('input', () => {
        updateSaveButton();
        // Debounced — same as EID lookup
        clearTimeout(eidHistoryTimer);
        eidHistoryTimer = setTimeout(() => {
            const eid = getEIDFromInput();
            const vid = dom.inputVid?.value.trim() || '';
            if (eid || vid) {
                renderAnimalHistory(eid, vid);
            } else {
                renderAnimalHistory(null, null);
            }
        }, 300);
    });

    dom.btnClearEid.addEventListener('click', () => {
        setCurrentEID(null);
        focusEidIfDesktop();
    });

    // Search button — triggers animal history lookup by EID and/or VID
    dom.btnSearchAnimal?.addEventListener('click', () => {
        const eid = getEIDFromInput();
        const vid = dom.inputVid?.value.trim() || '';
        if (eid || vid) {
            renderAnimalHistory(eid, vid);
            // Scroll to history panel
            setTimeout(() => {
                dom.animalHistory?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 100);
        } else {
            showToast('Enter an EID or VID to search', 'info');
        }
    });

    // BLE EID scan buttons
    dom.btnScanEid.addEventListener('click', handleSingleScan);
    dom.btnAutoScanEid.addEventListener('click', handleAutoScan);

    // Photo / Video capture
    dom.btnTakePhoto?.addEventListener('click', () => dom.inputPhoto?.click());
    dom.btnTakeVideo?.addEventListener('click', () => dom.inputVideo?.click());

    dom.inputPhoto?.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) addMediaFile('photo', file);
        e.target.value = ''; // allow re-selecting same file
    });

    dom.inputVideo?.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) addMediaFile('video', file);
        e.target.value = '';
    });

    dom.btnSaveRecord.addEventListener('click', saveRecord);

    dom.btnViewRecords.addEventListener('click', showRecords);

    // "View All" in recent records section
    dom.btnViewAllRecords?.addEventListener('click', showRecords);

    dom.btnSettings.addEventListener('click', () => {
        showScreen('setup');
    });

    // Records screen
    dom.btnBackMain.addEventListener('click', () => showScreen('main'));
    dom.btnExportCsv.addEventListener('click', exportCSV);

    // Export CSV from main screen footer
    dom.btnExportCsvMain?.addEventListener('click', exportCSV);

    // Voice dictation mic button — hide on browsers that don't support Web Speech API
    // (Bluefy/WKWebView doesn't support it; users can use iOS keyboard dictation instead)
    const hasSpeechAPI = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    if (dom.btnMic) {
        if (hasSpeechAPI) {
            dom.btnMic.addEventListener('click', toggleVoiceDictation);
        } else {
            // Hide mic button — iOS keyboard has built-in dictation (mic icon on keyboard)
            dom.btnMic.style.display = 'none';
        }
    }

    // Keyboard: Enter on notes field saves record
    dom.inputNotes.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !dom.btnSaveRecord.disabled) {
            saveRecord();
        }
    });

    // Global scanner capture — captures scanner input on ALL screens (capture phase)
    document.addEventListener('keydown', handleGlobalKeydown, true);

    // ── Display Mode ──
    // Load saved display mode from localStorage
    const savedMode = localStorage.getItem('ae_display_mode') || 'combined';
    state.displayMode = savedMode;
    const modeRadio = document.querySelector(`input[name="display-mode"][value="${savedMode}"]`);
    if (modeRadio) modeRadio.checked = true;
    applyDisplayMode(savedMode);

    // Listen for display mode changes
    document.querySelectorAll('input[name="display-mode"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            state.displayMode = e.target.value;
            localStorage.setItem('ae_display_mode', e.target.value);
            applyDisplayMode(e.target.value);
            debugLog(`Display mode: ${e.target.value}`);
        });
    });

    // ── Data Mode (Cloud vs Manual) ──
    const savedDataMode = localStorage.getItem('ae_data_mode') || 'cloud';
    const dataModeRadio = document.querySelector(`input[name="data-mode"][value="${savedDataMode}"]`);
    if (dataModeRadio) dataModeRadio.checked = true;
    applyDataMode(savedDataMode);

    document.querySelectorAll('input[name="data-mode"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            localStorage.setItem('ae_data_mode', e.target.value);
            applyDataMode(e.target.value);
            debugLog(`Data mode: ${e.target.value}`);
        });
    });

    debugLog('AgriEID initialized. Connect scales to begin.');
    window.__appLoaded = true;
}

// ============================================================
// Cloud Dashboard
// ============================================================

/**
 * Scan all session sources and group records by EID.
 * Returns a Map<eid, { eid, vid, records[], latestWeight, latestDate, recordCount }>
 */
function buildAnimalIndex() {
    const animals = new Map();

    function addRecord(record, sessionName) {
        const eid = record.eid;
        if (!eid) return;

        if (!animals.has(eid)) {
            animals.set(eid, {
                eid,
                vid: record.vid || '',
                records: [],
                latestWeight: 0,
                latestDate: null,
                recordCount: 0,
            });
        }
        const animal = animals.get(eid);
        animal.records.push({
            ...record,
            sessionName: sessionName || '',
        });
        // Keep latest VID
        if (record.vid) animal.vid = record.vid;
    }

    // 1. Local per-session storage (agrieid_session_{id})
    const localSessions = getAllSessions();
    for (const sessionData of localSessions) {
        const name = sessionData.session?.name || '';
        for (const r of (sessionData.records || [])) {
            addRecord(r, name);
        }
    }

    // 2. LP cloud sessions (agrieid_sessions) — may have records not in local storage
    try {
        const lpRaw = localStorage.getItem('agrieid_sessions');
        if (lpRaw) {
            const lpSessions = JSON.parse(lpRaw);
            for (const sess of lpSessions) {
                const name = sess.name || 'Cloud Session';
                for (const r of (sess.records || [])) {
                    addRecord(r, name);
                }
            }
        }
    } catch { /* skip corrupt */ }

    // 3. Current in-memory session
    if (state.session) {
        for (const r of state.records) {
            addRecord(r, state.session.name);
        }
    }

    // 4. LP full cattle register (all animals) — covers records not tied
    //    to any scanner session. Skip soft-deleted rows.
    try {
        const cloudRecords = lpSync.getCloudRecords ? lpSync.getCloudRecords() : [];
        for (const cr of cloudRecords) {
            if (cr.deleted_at || cr.record_status !== 1 || !cr.eid) continue;
            addRecord({
                id: cr.uuid,
                eid: cr.eid || '',
                vid: cr.visual_tag || '',
                weight: parseFloat(cr.weight_kg) || 0,
                weightUnit: 'kg',
                unit: 'kg',
                notes: cr.notes || '',
                date: (cr.record_date || cr.updated_at || '').split(' ')[0].split('T')[0],
                timestamp: cr.updated_at || cr.created_at || new Date().toISOString(),
                lpSynced: true,
            }, 'Cloud Register');
        }
    } catch { /* skip */ }

    // 5. LP record_history — per-animal weight events across all time
    try {
        const history = lpSync.getCloudRecordHistory ? lpSync.getCloudRecordHistory() : [];
        for (const h of history) {
            if (h.deleted_at || !h.eid) continue;
            addRecord({
                id: h.uuid,
                eid: h.eid || '',
                vid: h.visual_tag || '',
                weight: parseFloat(h.weight_kg) || 0,
                weightUnit: 'kg',
                unit: 'kg',
                notes: h.notes || '',
                date: (h.record_date || h.created_at || '').split(' ')[0].split('T')[0],
                timestamp: h.created_at || new Date().toISOString(),
                lpSynced: true,
            }, 'History');
        }
    } catch { /* skip */ }

    // Deduplicate records per animal and compute stats
    for (const [eid, animal] of animals) {
        // Deduplicate by record id
        const seen = new Set();
        const unique = [];
        for (const r of animal.records) {
            const rid = r.id || `${r.eid}-${r.date}-${r.weight}`;
            if (!seen.has(rid)) {
                seen.add(rid);
                unique.push(r);
            }
        }
        // Sort by date ascending
        unique.sort((a, b) => {
            const da = new Date(a.date || a.timestamp || 0);
            const db = new Date(b.date || b.timestamp || 0);
            return da - db;
        });
        animal.records = unique;
        animal.recordCount = unique.length;

        // Latest record
        const last = unique[unique.length - 1];
        if (last) {
            animal.latestWeight = last.weight || 0;
            animal.latestDate = new Date(last.date || last.timestamp);
        }
    }

    return animals;
}

/**
 * Render the cloud dashboard: pull data, build index, populate stats + animal list.
 */
async function renderCloudDashboard() {
    const listEl = $('cloud-dash-list');
    const statusEl = $('cloud-dash-pull-status');

    // Auto-pull if logged in
    if (lpSync.isLoggedIn()) {
        if (statusEl) {
            statusEl.textContent = 'Pulling latest data from cloud...';
            statusEl.style.color = 'var(--text-dim)';
        }
        try {
            const result = await lpSync.pullData();
            if (statusEl) {
                const regAnimals = result.registerAnimals || 0;
                statusEl.textContent = `Synced: ${regAnimals} animal(s), ${result.newSessions} new session(s), ${result.newRecords} new record(s)`;
                statusEl.style.color = 'var(--green)';
            }
        } catch (err) {
            if (statusEl) {
                statusEl.textContent = 'Pull failed: ' + err.message;
                statusEl.style.color = 'var(--red, #ff4444)';
            }
        }
    } else {
        if (statusEl) {
            statusEl.textContent = 'Not connected — showing local data only';
            statusEl.style.color = 'var(--text-dim)';
        }
    }

    // Build animal index
    const animals = buildAnimalIndex();

    // Summary stats
    let totalRecords = 0;
    const sessionIds = new Set();
    for (const [, a] of animals) {
        totalRecords += a.recordCount;
        for (const r of a.records) {
            if (r.sessionName) sessionIds.add(r.sessionName);
        }
    }

    $('cloud-stat-animals').textContent = animals.size;
    $('cloud-stat-records').textContent = totalRecords;
    $('cloud-stat-sessions').textContent = sessionIds.size;

    const lastSync = localStorage.getItem('agrieid_lp_last_sync');
    if (lastSync) {
        const d = new Date(lastSync);
        $('cloud-stat-sync').textContent = d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
    } else {
        $('cloud-stat-sync').textContent = '—';
    }

    // Sort animals by most recent weigh first
    const sorted = [...animals.values()].sort((a, b) => {
        const da = a.latestDate ? a.latestDate.getTime() : 0;
        const db = b.latestDate ? b.latestDate.getTime() : 0;
        return db - da;
    });

    // Render animal list
    if (!listEl) return;
    if (sorted.length === 0) {
        listEl.innerHTML = '<div class="dashboard-empty">No animal records found. Pull data from the cloud or start a session.</div>';
        return;
    }

    listEl.innerHTML = '';
    for (const animal of sorted) {
        const row = document.createElement('div');
        row.className = 'cloud-animal-row';
        row.dataset.eid = animal.eid;

        const dateStr = animal.latestDate
            ? formatShortDate(animal.latestDate)
            : '—';

        row.innerHTML = `
            <div class="cloud-animal-left">
                <div class="cloud-animal-eid">${animal.eid}</div>
                <div class="cloud-animal-meta">${animal.vid ? 'VID: ' + animal.vid : ''} · ${animal.recordCount} record${animal.recordCount !== 1 ? 's' : ''}</div>
            </div>
            <div class="cloud-animal-right">
                <div class="cloud-animal-weight">${animal.latestWeight ? animal.latestWeight.toFixed(1) + ' kg' : '—'}</div>
                <div class="cloud-animal-date">${dateStr}</div>
            </div>
        `;

        row.addEventListener('click', () => showAnimalDetail(animal.eid));
        listEl.appendChild(row);
    }
}

/**
 * Show the animal detail screen for a specific EID.
 */
function showAnimalDetail(eid) {
    const animals = buildAnimalIndex();
    const animal = animals.get(eid);
    if (!animal) {
        showToast('Animal not found', 'warning');
        return;
    }

    // Update title
    const title = $('animal-detail-title');
    if (title) {
        title.textContent = animal.vid ? `${animal.eid} — ${animal.vid}` : animal.eid;
    }

    // Stats
    const records = animal.records;
    const last = records[records.length - 1];
    const weights = records.map(r => r.weight).filter(w => w > 0);

    $('animal-stat-weight').textContent = last?.weight ? last.weight.toFixed(1) + ' kg' : '—';
    $('animal-stat-count').textContent = records.length;

    if (weights.length > 0) {
        const min = Math.min(...weights);
        const max = Math.max(...weights);
        $('animal-stat-range').textContent = `${min.toFixed(0)}–${max.toFixed(0)}`;
    } else {
        $('animal-stat-range').textContent = '—';
    }

    // ADG (between last two records)
    if (records.length >= 2) {
        const prev = records[records.length - 2];
        const currDate = new Date(last.date || last.timestamp);
        const prevDate = new Date(prev.date || prev.timestamp);
        const days = (currDate - prevDate) / (1000 * 60 * 60 * 24);
        if (days >= 1 && last.weight && prev.weight) {
            const adg = (last.weight - prev.weight) / days;
            const adgEl = $('animal-stat-adg');
            adgEl.textContent = `${adg >= 0 ? '+' : ''}${adg.toFixed(2)}`;
            adgEl.style.color = adg >= 0 ? 'var(--green)' : 'var(--red, #ff4444)';
        } else {
            $('animal-stat-adg').textContent = '—';
            $('animal-stat-adg').style.color = '';
        }
    } else {
        $('animal-stat-adg').textContent = '—';
        $('animal-stat-adg').style.color = '';
    }

    // Draw weight chart
    const canvas = $('animal-weight-chart');
    if (canvas) {
        drawWeightChart(canvas, records);
    }

    // Render history list
    const historyList = $('animal-history-list');
    if (historyList) {
        const reversed = [...records].reverse();
        if (reversed.length === 0) {
            historyList.innerHTML = '<div class="dashboard-empty">No records</div>';
        } else {
            let html = '';
            for (const rec of reversed) {
                const date = new Date(rec.date || rec.timestamp);
                const dateStr = formatShortDate(date);
                const weight = rec.weight ? `${rec.weight.toFixed(1)} kg` : '—';
                const session = rec.sessionName || '';
                const notes = rec.notes || '';

                html += `<div class="animal-history-row">
                    <div class="animal-history-main">
                        <span class="animal-history-date">${dateStr}</span>
                        <span class="animal-history-weight">${weight}</span>
                    </div>
                    <div class="animal-history-meta">
                        ${session ? `<span>${session}</span>` : ''}
                        ${notes ? `<span class="animal-history-notes">${notes}</span>` : ''}
                    </div>
                </div>`;
            }
            historyList.innerHTML = html;
        }
    }

    showScreen('animal-detail');
}

/**
 * Draw a weight-over-time line chart on a canvas element.
 */
function drawWeightChart(canvas, records) {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    // Set canvas size based on container
    const container = canvas.parentElement;
    const displayW = container.clientWidth || 350;
    const displayH = 220;
    canvas.width = displayW * dpr;
    canvas.height = displayH * dpr;
    canvas.style.width = displayW + 'px';
    canvas.style.height = displayH + 'px';
    ctx.scale(dpr, dpr);

    // Filter valid data points
    const points = records
        .map(r => ({
            date: new Date(r.date || r.timestamp),
            weight: r.weight,
        }))
        .filter(p => p.weight > 0)
        .sort((a, b) => a.date - b.date);

    if (points.length < 2) {
        ctx.clearRect(0, 0, displayW, displayH);
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.font = '13px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(
            points.length === 1 ? 'Need 2+ records for chart' : 'No weight data',
            displayW / 2, displayH / 2
        );
        return;
    }

    const pad = { top: 25, right: 15, bottom: 35, left: 50 };
    const plotW = displayW - pad.left - pad.right;
    const plotH = displayH - pad.top - pad.bottom;

    const weights = points.map(p => p.weight);
    const minW = Math.min(...weights) * 0.95;
    const maxW = Math.max(...weights) * 1.05;
    const wRange = maxW - minW || 1;

    const minDate = points[0].date.getTime();
    const maxDate = points[points.length - 1].date.getTime();
    const dateRange = maxDate - minDate || 1;

    const sx = (d) => pad.left + ((d.getTime() - minDate) / dateRange) * plotW;
    const sy = (w) => pad.top + plotH - ((w - minW) / wRange) * plotH;

    // Clear
    ctx.clearRect(0, 0, displayW, displayH);

    // Grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    const gridSteps = 4;
    for (let i = 0; i <= gridSteps; i++) {
        const y = pad.top + (plotH / gridSteps) * i;
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(displayW - pad.right, y);
        ctx.stroke();
    }

    // Y-axis labels
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '11px "Orbitron", monospace';
    ctx.textAlign = 'right';
    for (let i = 0; i <= gridSteps; i++) {
        const val = maxW - (wRange / gridSteps) * i;
        const y = pad.top + (plotH / gridSteps) * i;
        ctx.fillText(val.toFixed(0), pad.left - 8, y + 4);
    }

    // X-axis labels
    ctx.textAlign = 'center';
    const xLabelCount = Math.min(points.length, 5);
    const step = Math.max(1, Math.floor(points.length / xLabelCount));
    for (let i = 0; i < points.length; i += step) {
        const p = points[i];
        const x = sx(p.date);
        const label = p.date.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
        ctx.fillText(label, x, displayH - pad.bottom + 18);
    }
    // Always show last label
    const lastP = points[points.length - 1];
    const lastX = sx(lastP.date);
    ctx.fillText(lastP.date.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }), lastX, displayH - pad.bottom + 18);

    // Line
    ctx.strokeStyle = '#00e676';
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
        const x = sx(points[i].date);
        const y = sy(points[i].weight);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Gradient fill under line
    const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
    grad.addColorStop(0, 'rgba(0, 230, 118, 0.25)');
    grad.addColorStop(1, 'rgba(0, 230, 118, 0.02)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(sx(points[0].date), sy(points[0].weight));
    for (let i = 1; i < points.length; i++) {
        ctx.lineTo(sx(points[i].date), sy(points[i].weight));
    }
    ctx.lineTo(sx(points[points.length - 1].date), pad.top + plotH);
    ctx.lineTo(sx(points[0].date), pad.top + plotH);
    ctx.closePath();
    ctx.fill();

    // Dots
    for (let i = 0; i < points.length; i++) {
        const x = sx(points[i].date);
        const y = sy(points[i].weight);
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#00e676';
        ctx.fill();
        ctx.strokeStyle = '#0d1117';
        ctx.lineWidth = 2;
        ctx.stroke();
    }
}

// ============================================================
// Boot
// ============================================================
init();
