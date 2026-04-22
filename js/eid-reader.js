// BTU Stick EID Reader - BLE Connection & DEJ RFID Protocol Handler
// Device name: HID-KB-UART (BLE bridge UART)
//
// *** CRITICAL SAFETY ***
// This reader has an OTA firmware update characteristic that MUST NOT be accessed.
// SAFETY RULE: NEVER call service.getCharacteristics() — always request specific
// characteristic UUIDs using service.getCharacteristic(uuid).
//
// Protocol: DEJ RFID Bluetooth Communication Protocol
//   Frame: Header(0xC3) + Length(1) + CmdType(1) + CmdParam(1) + Payload(N) + CRC(2) + Tail(0x3C)
//   Wire encoding: every byte XOR 0x55
//   CRC16-CCITT: poly=0x8408, init=0x0000, range=[header..payload], little-endian [lo,hi]

const XOR_KEY = 0x55;
const FRAME_HEADER = 0xC3;
const FRAME_TAIL = 0x3C;
const CRC_POLY = 0x8408;
const CRC_INIT = 0x0000;

// Command types & params
// Command types
const CMD_TYPE = {
    TAG:     0x01,  // Tag information commands
    CFG_RD:  0x02,  // Read configuration commands
    CFG_WR:  0x03,  // Write configuration commands
};

// Command parameters (odd = request, even = response per protocol spec)
const CMD = {
    TAG:         0x01,  // CmdType for tag operations (alias for CMD_TYPE.TAG)
    READ_TAG:    0x01,  // CmdParam: read tag at index (request)
    TAG_RECORD:  0x02,  // CmdParam: tag record (response)
    QUERY_COUNT: 0x03,  // CmdParam: query stored tag count (request)
    COUNT_RESP:  0x04,  // CmdParam: tag count (response)
    DELETE_ALL:  0x05,  // CmdParam: delete all stored tags (request)
    DELETE_RESP: 0x06,  // CmdParam: delete response
    SCAN:        0x07,  // CmdParam: trigger RFID scan (request)
    SCAN_RESP:   0x08,  // CmdParam: scan acknowledgement (response, empty payload)
};

// Configuration parameter IDs (used with CFG_RD/CFG_WR)
// Request = odd param, Response = even param (param + 1)
const CFG = {
    LANGUAGE:      0x01,
    MARK:          0x03,
    SHUTDOWN_TIME: 0x05,
    READING_MODE:  0x07,  // 0x00=Single, 0x01=Continuous
    SAVE:          0x09,
    REREAD:        0x0B,
    COMPARE:       0x0D,
    SOUND:         0x0F,
    VIBRATION:     0x11,
    USB_HID:       0x13,
    RF_24G:        0x15,
};

// ---------------------------------------------------------------
// Known SAFE BLE UART service + characteristic UUID pairs
// ---------------------------------------------------------------
const SAFE_UART_PROFILES = [
    {
        // AgriEID SR-SPP: FFE4=Notify(incoming tags), FFE1=Write(send commands)
        name: 'AgriEID SR-SPP',
        service: '0000ffe0-0000-1000-8000-00805f9b34fb',
        tx: '0000ffe4-0000-1000-8000-00805f9b34fb',
        rx: '0000ffe1-0000-1000-8000-00805f9b34fb',
    },
    {
        name: 'ISSC Transparent UART',
        service: '49535343-fe7d-4ae5-8fa9-9fafd205e455',
        tx: '49535343-1e4d-4bd9-ba61-23c647249616',
        rx: '49535343-8841-43f4-a8d4-ecbe34729bb3',
    },
    {
        name: 'Nordic UART',
        service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
        tx: '6e400003-b5a3-f393-e0a9-e50e24dcca9e',
        rx: '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
    },
    {
        name: 'HM-10 / TI CC254x',
        service: '0000ffe0-0000-1000-8000-00805f9b34fb',
        tx: '0000ffe1-0000-1000-8000-00805f9b34fb',
        rx: '0000ffe1-0000-1000-8000-00805f9b34fb',
    },
    {
        name: 'HM-10 Alternate',
        service: '0000ffe5-0000-1000-8000-00805f9b34fb',
        tx: '0000ffe9-0000-1000-8000-00805f9b34fb',
        rx: '0000ffe9-0000-1000-8000-00805f9b34fb',
    },
    {
        name: 'Generic BLE Serial (FFF0)',
        service: '0000fff0-0000-1000-8000-00805f9b34fb',
        tx: '0000fff1-0000-1000-8000-00805f9b34fb',
        rx: '0000fff2-0000-1000-8000-00805f9b34fb',
    },
    {
        name: 'Microchip RN4870',
        service: 'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
        tx: 'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
        rx: 'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
    },
    {
        name: 'Dialog Semiconductor',
        service: '0000fef0-0000-1000-8000-00805f9b34fb',
        tx: '0000fef1-0000-1000-8000-00805f9b34fb',
        rx: '0000fef2-0000-1000-8000-00805f9b34fb',
    },
];

// All service UUIDs we request access to (safe only — no OTA)
// MUST be deduplicated — Web Bluetooth throws TypeError on duplicate optionalServices
const SAFE_SERVICE_UUIDS = [
    ...new Set(SAFE_UART_PROFILES.map(p => p.service)),
    0x1800,  // Generic Access
    0x180A,  // Device Information
    0x180F,  // Battery Service
];

const TAG_TYPES = {
    0x01: { name: 'FDXB', digits: 15 },
    0x02: { name: 'EMID', digits: 10 },
    0x03: { name: 'HDX',  digits: 15 },
    0x04: { name: 'FDXA', digits: 10 },
};

// Timeout helper
function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
        )
    ]);
}

// ===============================================================
// EIDReaderManager
// ===============================================================
export class EIDReaderManager extends EventTarget {
    constructor() {
        super();
        this.device = null;
        this.server = null;
        this.notifyCharacteristic = null;
        this.writeCharacteristic = null;
        this.connected = false;
        this._buffer = [];           // raw wire bytes (XOR-encoded)
        this._decoded = [];          // decoded bytes awaiting frame parse
        this._reconnecting = false;
        this._manualDisconnect = false;
        this._profileName = null;
        this._hidMode = false;       // true when device is HID-only (no UART)

        // SPP (Serial Port Profile) mode
        this._sppMode = false;
        this._serialPort = null;
        this._serialReader = null;

        // Plain-text tag buffer (reader sends scanned tags as ASCII over BLE or SPP)
        this._textBuf = '';

        // Command response handling
        this._pendingResolve = null;
        this._pendingReject = null;
        this._pendingTimeout = null;
        this._pendingCmdParam = null;  // track which command we're waiting for

        // Scan polling
        this._pollTimer = null;
        this._lastKnownCount = 0;
        this._scanning = false;
        this._stopOnTag = false;       // Auto-stop scanning when tag detected
        this._scanRetrigger = null;    // Timer for periodic SCAN re-trigger
    }

    // -----------------------------------------------------------
    // CRC16-CCITT (poly 0x8408, init 0x0000)
    // Input: array of decoded bytes [header, length, type, param, ...payload]
    // Returns: 16-bit CRC value
    // -----------------------------------------------------------
    _crc16(data) {
        let crc = CRC_INIT;
        for (const byte of data) {
            crc ^= byte & 0xFF;
            for (let i = 0; i < 8; i++) {
                if (crc & 1) {
                    crc = (crc >> 1) ^ CRC_POLY;
                } else {
                    crc >>= 1;
                }
            }
        }
        return crc & 0xFFFF;
    }

    // -----------------------------------------------------------
    // Build a DEJ protocol frame (decoded bytes, NOT wire-encoded)
    // Returns: Uint8Array of wire-encoded (XOR 0x55) bytes
    // -----------------------------------------------------------
    _buildFrame(cmdType, cmdParam, payload = []) {
        // Length = total frame bytes: header(1) + length(1) + type(1) + param(1) + payload(N) + crc(2) + tail(1)
        const length = payload.length + 7;

        // CRC covers: header + length + cmdType + cmdParam + payload
        const crcData = [FRAME_HEADER, length, cmdType, cmdParam, ...payload];
        const crc = this._crc16(crcData);
        const crcLo = crc & 0xFF;
        const crcHi = (crc >> 8) & 0xFF;

        // Assemble decoded frame
        const frame = [
            FRAME_HEADER,
            length,
            cmdType,
            cmdParam,
            ...payload,
            crcLo,
            crcHi,
            FRAME_TAIL,
        ];

        // Wire-encode: XOR every byte with 0x55
        const encoded = new Uint8Array(frame.length);
        for (let i = 0; i < frame.length; i++) {
            encoded[i] = frame[i] ^ XOR_KEY;
        }

        return encoded;
    }

    // -----------------------------------------------------------
    // Try to parse a complete frame from the decoded buffer
    // Returns: { cmdType, cmdParam, payload } or null
    // -----------------------------------------------------------
    _tryParseFrame() {
        // Find header
        const headerIdx = this._decoded.indexOf(FRAME_HEADER);
        if (headerIdx === -1) {
            this._decoded = [];
            return null;
        }
        // Discard bytes before header
        if (headerIdx > 0) {
            this._decoded = this._decoded.slice(headerIdx);
        }

        // Need at least header + length
        if (this._decoded.length < 2) return null;

        const frameLen = this._decoded[1];
        if (frameLen < 7 || frameLen > 255) {
            // Invalid length — discard header and try again
            this._decoded.shift();
            return this._tryParseFrame();
        }

        // Wait for complete frame
        if (this._decoded.length < frameLen) return null;

        const frame = this._decoded.slice(0, frameLen);

        // Verify tail
        if (frame[frameLen - 1] !== FRAME_TAIL) {
            this._log(`Frame tail mismatch: 0x${frame[frameLen - 1]?.toString(16)}`);
            this._decoded.shift();
            return this._tryParseFrame();
        }

        // Extract parts
        const cmdType = frame[2];
        const cmdParam = frame[3];
        const payloadEnd = frameLen - 3; // before CRC(2) + tail(1)
        const payload = frame.slice(4, payloadEnd);
        const crcLo = frame[frameLen - 3];
        const crcHi = frame[frameLen - 2];
        const crcReceived = (crcHi << 8) | crcLo;

        // Verify CRC (covers header + length + type + param + payload)
        const crcData = frame.slice(0, payloadEnd);
        const crcCalc = this._crc16(crcData);

        if (crcCalc !== crcReceived) {
            this._log(`CRC mismatch: calc=0x${crcCalc.toString(16)} recv=0x${crcReceived.toString(16)}`);
            this._decoded.shift();
            return this._tryParseFrame();
        }

        // Consume frame from buffer
        this._decoded = this._decoded.slice(frameLen);

        return { cmdType, cmdParam, payload };
    }

    // -----------------------------------------------------------
    // Handle incoming BLE data (raw wire bytes from notification)
    // -----------------------------------------------------------
    _handleData(dataView) {
        const raw = [];
        for (let i = 0; i < dataView.byteLength; i++) {
            raw.push(dataView.getUint8(i));
        }

        this._log(`RX [${raw.length}]: ${raw.map(b => b.toString(16).padStart(2, '0')).join(' ')}`);

        // Detect: DEJ protocol frames start with 0x96 on wire (0xC3 ^ 0x55).
        // Plain-text tag IDs are ASCII digits (0x30-0x39).
        // 0x96 = 0xC3 ^ 0x55; plain text digits 0x30-0x39 would never XOR to 0xC3.
        const firstByte = raw[0];
        const isDEJStart = (firstByte === (FRAME_HEADER ^ XOR_KEY)); // 0x96

        if (isDEJStart || this._decoded.length > 0) {
            // DEJ protocol — XOR-decode and feed to frame parser
            for (const byte of raw) {
                this._decoded.push(byte ^ XOR_KEY);
            }
            let frame;
            while ((frame = this._tryParseFrame()) !== null) {
                this._routeFrame(frame);
            }
            // If buffer grows without producing frames, it's stale/corrupted — flush it
            // so plain-text data isn't permanently routed to the DEJ parser
            if (this._decoded.length > 512) {
                this._log('Flushing stale DEJ buffer');
                this._decoded = [];
            }
        } else {
            // Plain text — reader sends scanned tag IDs as ASCII (e.g. "999115002391022\r\n")
            // Clear any stale DEJ buffer so it doesn't trap future plain-text data
            if (this._decoded.length > 0) {
                this._log('Clearing stale DEJ buffer before plain-text processing');
                this._decoded = [];
            }
            const text = new TextDecoder().decode(new Uint8Array(raw));
            this._textBuf += text;
            this._processTextBuffer();
        }
    }

    // -----------------------------------------------------------
    // Route a parsed frame to the appropriate handler
    // -----------------------------------------------------------
    _routeFrame(frame) {
        const { cmdType, cmdParam, payload } = frame;
        this._log(`Frame: type=0x${cmdType.toString(16)} param=0x${cmdParam.toString(16)} payload[${payload.length}]`);

        const isTagRecord = (cmdType === CMD.TAG && cmdParam === CMD.TAG_RECORD);

        if (this._pendingResolve) {
            // A command is waiting for a response.
            // Check: is this TAG_RECORD unsolicited?
            // Only READ_TAG expects TAG_RECORD as response.
            // SCAN gets SCAN_RESP (0x08), tag arrives as plain text separately.
            const expectsTagRecord = (
                this._pendingCmdParam === CMD.READ_TAG
            );

            if (isTagRecord && !expectsTagRecord) {
                // Unsolicited real-time tag notification during poll loop —
                // process as tag but do NOT consume the pending command.
                this._log('Unsolicited TAG_RECORD during pending command — emitting as live tag');
                const tag = this._parseTagRecord(payload);
                if (tag) {
                    this._emitTag(tag.tagId, tag.tagType, tag.timestamp);
                }
                return;
            }

            // Expected response — resolve pending command
            const resolve = this._pendingResolve;
            this._pendingResolve = null;
            this._pendingReject = null;
            this._pendingCmdParam = null;
            clearTimeout(this._pendingTimeout);
            this._pendingTimeout = null;
            resolve(frame);
            return;
        }

        // No pending command — handle as unsolicited notification
        if (isTagRecord) {
            this._log('Unsolicited TAG_RECORD (no pending command) — emitting as live tag');
            const tag = this._parseTagRecord(payload);
            if (tag) {
                this._emitTag(tag.tagId, tag.tagType, tag.timestamp);
            }
        } else if (cmdType === CMD.TAG && cmdParam === CMD.COUNT_RESP) {
            const count = this._parseCount(payload);
            if (count !== null) {
                this._log(`Notification: tag count = ${count}`);
                this._emit('tagcount', { count });
            }
        }
    }

    // -----------------------------------------------------------
    // Send a command and wait for response
    // -----------------------------------------------------------
    async _sendCommand(cmdType, cmdParam, payload = [], timeoutMs = 5000) {
        if (!this.writeCharacteristic) {
            throw new Error('No write characteristic — not connected');
        }

        // Cancel any pending command (silently — this is expected during rapid commands)
        if (this._pendingReject) {
            const oldReject = this._pendingReject;
            this._pendingResolve = null;
            this._pendingReject = null;
            this._pendingCmdParam = null;
            clearTimeout(this._pendingTimeout);
            try { oldReject(new Error('Superseded by new command')); } catch (_) {}
        }

        const encoded = this._buildFrame(cmdType, cmdParam, payload);

        this._log(`TX [${encoded.length}]: ${Array.from(encoded).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);

        // Set up response promise
        const responsePromise = new Promise((resolve, reject) => {
            this._pendingResolve = resolve;
            this._pendingReject = reject;
            this._pendingCmdParam = cmdParam;  // track what we sent so _routeFrame can distinguish solicited vs unsolicited
            this._pendingTimeout = setTimeout(() => {
                this._pendingResolve = null;
                this._pendingReject = null;
                this._pendingCmdParam = null;
                reject(new Error(`Command 0x${cmdParam.toString(16)} timed out`));
            }, timeoutMs);
        });

        // Send on wire
        try {
            if (this.writeCharacteristic.properties.writeWithoutResponse) {
                await this.writeCharacteristic.writeValueWithoutResponse(encoded);
            } else {
                await this.writeCharacteristic.writeValueWithResponse(encoded);
            }
        } catch (e) {
            this._pendingResolve = null;
            this._pendingReject = null;
            this._pendingCmdParam = null;
            clearTimeout(this._pendingTimeout);
            throw new Error(`Send failed: ${e.message}`);
        }

        return responsePromise;
    }

    /**
     * Unified send: routes to BLE or SPP depending on active connection mode.
     */
    async _send(cmdType, cmdParam, payload = [], timeoutMs = 5000) {
        if (this._sppMode) {
            return this._sendSPPCommand(cmdType, cmdParam, payload, timeoutMs);
        }
        return this._sendCommand(cmdType, cmdParam, payload, timeoutMs);
    }

    // -----------------------------------------------------------
    // Parse a 3-byte count value [hi, mid, lo]
    // -----------------------------------------------------------
    _parseCount(payload) {
        if (payload.length < 3) return null;
        return (payload[0] << 16) | (payload[1] << 8) | payload[2];
    }

    // -----------------------------------------------------------
    // Parse a 49-byte tag record from payload
    // Structure: Index[3] + TagType[1] + Mark[1] + Reserved[1]
    //          + TagID[16] + Time[20] + Reserved[6] + Reserved[1]
    // -----------------------------------------------------------
    _parseTagRecord(payload) {
        if (payload.length < 42) {
            this._log(`Tag record too short: ${payload.length} bytes`);
            return null;
        }

        const tagTypeByte = payload[3];
        const typeInfo = TAG_TYPES[tagTypeByte] || { name: 'Unknown', digits: 15 };

        // TagID: bytes 6..21 (16 bytes), ASCII
        const tagIdBytes = payload.slice(6, 22);
        const tagId = tagIdBytes
            .filter(b => b >= 0x20 && b <= 0x7E)
            .map(b => String.fromCharCode(b))
            .join('')
            .trim()
            .replace(/\s/g, '')
            .slice(0, typeInfo.digits);

        // Timestamp: bytes 22..41 (20 bytes), ASCII
        let timestamp = '';
        if (payload.length >= 42) {
            const tsBytes = payload.slice(22, 42);
            timestamp = tsBytes
                .filter(b => b >= 0x20 && b <= 0x7E)
                .map(b => String.fromCharCode(b))
                .join('')
                .trim();
        }

        if (!tagId || tagId.length < 5) {
            this._log(`Tag ID too short or empty: "${tagId}"`);
            return null;
        }

        this._log(`Tag record: ${tagId} (${typeInfo.name}) @ ${timestamp || 'no time'}`);

        return {
            tagId,
            tagType: typeInfo.name,
            timestamp: timestamp || new Date().toISOString(),
        };
    }

    // ===============================================================
    // PUBLIC COMMANDS
    // ===============================================================

    /**
     * Trigger an RFID scan.
     * Sends SCAN command (0x07), reader responds with ack (0x08).
     * If a tag is read, it arrives separately as plain-text ASCII.
     * NOTE: Only works when reader is on "SCAN Interface" or "Tag Information Interface".
     * @returns {Promise<boolean>} true if scan ack received
     */
    async triggerScan() {
        if (!this.connected) {
            throw new Error('Not connected');
        }
        this._log('Triggering scan...');
        try {
            const resp = await this._send(CMD.TAG, CMD.SCAN, [], 5000);
            if (resp.cmdParam === CMD.SCAN_RESP) {
                this._log('Scan triggered — waiting for tag (arrives as plain text)');
                return true;
            }
            this._log(`Scan response: type=0x${resp.cmdType.toString(16)} param=0x${resp.cmdParam.toString(16)}`);
            return false;
        } catch (e) {
            this._log(`Scan failed: ${e.message}`);
            return false;
        }
    }

    /**
     * Read a configuration value from the reader.
     * @param {number} cfgParam - Config parameter ID (e.g. CFG.READING_MODE)
     * @returns {Promise<number>} config value byte
     */
    async readConfig(cfgParam) {
        const resp = await this._send(CMD_TYPE.CFG_RD, cfgParam, [], 3000);
        // Response param is cfgParam + 1 (even = response)
        if (resp.cmdParam === cfgParam + 1 && resp.payload.length > 0) {
            return resp.payload[0];
        }
        throw new Error(`Config read 0x${cfgParam.toString(16)}: unexpected response`);
    }

    /**
     * Write a configuration value to the reader.
     * @param {number} cfgParam - Config parameter ID (e.g. CFG.READING_MODE)
     * @param {number} value - Value to set
     * @returns {Promise<boolean>} true if "OK"
     */
    async writeConfig(cfgParam, value) {
        const resp = await this._send(CMD_TYPE.CFG_WR, cfgParam, [value], 3000);
        if (resp.cmdParam === cfgParam + 1 && resp.payload.length >= 2) {
            // "OK" = 0x4F 0x4B, "NO" = 0x4E 0x4F
            const ok = resp.payload[0] === 0x4F && resp.payload[1] === 0x4B;
            this._log(`Config write 0x${cfgParam.toString(16)}=${value}: ${ok ? 'OK' : 'FAILED'}`);
            return ok;
        }
        throw new Error(`Config write 0x${cfgParam.toString(16)}: unexpected response`);
    }

    /**
     * Enable continuous card reading mode.
     * In this mode, the reader continuously scans after a SCAN trigger.
     * @returns {Promise<boolean>}
     */
    async enableContinuousMode() {
        try {
            const current = await this.readConfig(CFG.READING_MODE);
            this._log(`Current reading mode: ${current === 0x01 ? 'Continuous' : 'Single'}`);
            if (current === 0x01) return true;  // already continuous

            const ok = await this.writeConfig(CFG.READING_MODE, 0x01);
            if (ok) this._log('Continuous reading mode enabled');
            return ok;
        } catch (e) {
            this._log(`Failed to set continuous mode: ${e.message}`);
            return false;
        }
    }

    /**
     * Enable single card reading mode.
     * In this mode, the reader scans once per SCAN trigger.
     * @returns {Promise<boolean>}
     */
    async enableSingleMode() {
        try {
            const current = await this.readConfig(CFG.READING_MODE);
            this._log(`Current reading mode: ${current === 0x01 ? 'Continuous' : 'Single'}`);
            if (current === 0x00) return true;  // already single

            const ok = await this.writeConfig(CFG.READING_MODE, 0x00);
            if (ok) this._log('Single reading mode enabled');
            return ok;
        } catch (e) {
            this._log(`Failed to set single mode: ${e.message}`);
            return false;
        }
    }

    /**
     * Query the number of stored tags on the reader.
     * @returns {Promise<number>} tag count
     */
    async queryTagCount() {
        if (this._hidMode) {
            this._log('Tag count not available in HID mode');
            return 0;
        }
        const resp = await this._send(CMD.TAG, CMD.QUERY_COUNT, []);
        if (resp.cmdParam === CMD.COUNT_RESP) {
            const count = this._parseCount(resp.payload);
            this._log(`Tag count: ${count}`);
            return count ?? 0;
        }
        throw new Error(`Unexpected response param: 0x${resp.cmdParam.toString(16)}`);
    }

    /**
     * Read a single tag by 1-based index.
     * @param {number} index - 1-based tag index
     * @returns {Promise<{tagId, tagType, timestamp}>}
     */
    async readTag(index) {
        const idx = [
            (index >> 16) & 0xFF,
            (index >> 8) & 0xFF,
            index & 0xFF,
        ];
        const resp = await this._send(CMD.TAG, CMD.READ_TAG, idx, 8000);
        if (resp.cmdParam === CMD.TAG_RECORD) {
            const tag = this._parseTagRecord(resp.payload);
            if (tag) return tag;
            throw new Error('Failed to parse tag record');
        }
        throw new Error(`Unexpected response param: 0x${resp.cmdParam.toString(16)}`);
    }

    /**
     * Delete all stored tags on the reader.
     * @returns {Promise<boolean>}
     */
    async deleteAllTags() {
        // Pause poll timer during delete to avoid GATT collisions.
        // Don't use stopScanPolling() — that would also reset _stopOnTag
        // and kill continuous scanning mode unnecessarily.
        const wasScanning = this._scanning;
        const hadRetrigger = !!this._scanRetrigger;
        if (wasScanning) {
            this._scanning = false;
            clearTimeout(this._pollTimer);
            this._pollTimer = null;
            clearInterval(this._scanRetrigger);
            this._scanRetrigger = null;
            this._log('Poll paused for delete');
            await new Promise(r => setTimeout(r, 250));  // let in-flight GATT finish
        }

        try {
            const resp = await this._send(CMD.TAG, CMD.DELETE_ALL, [], 10000);
            this._log(`Delete response: param=0x${resp.cmdParam.toString(16)}`);
            return resp.cmdParam === CMD.DELETE_RESP;
        } finally {
            if (wasScanning) {
                this._scanning = true;
                if (hadRetrigger) {
                    this._scanRetrigger = setInterval(async () => {
                        if (!this._scanning || !this.connected) {
                            clearInterval(this._scanRetrigger);
                            this._scanRetrigger = null;
                            return;
                        }
                        try { await this.triggerScan(); } catch (_) {}
                    }, 3000);
                }
                this._pollLoop();
                this._log('Poll resumed after delete');
            }
        }
    }

    /**
     * Read ALL stored tags from the reader.
     * @param {function} onProgress - callback(current, total) for progress updates
     * @returns {Promise<Array<{tagId, tagType, timestamp}>>}
     */
    async readAllTags(onProgress) {
        if (this._hidMode) {
            this._log('Download stored tags not available in HID mode');
            throw new Error('Stored tag download not available — reader is in HID keyboard mode');
        }

        // Pause poll timer during download to avoid GATT collisions.
        // Don't use stopScanPolling() — that would also reset _stopOnTag
        // and kill continuous scanning mode unnecessarily.
        const wasScanning = this._scanning;
        const hadRetrigger = !!this._scanRetrigger;
        if (wasScanning) {
            this._scanning = false;
            clearTimeout(this._pollTimer);
            this._pollTimer = null;
            clearInterval(this._scanRetrigger);
            this._scanRetrigger = null;
            this._log('Poll paused for download');
            await new Promise(r => setTimeout(r, 250));  // let in-flight GATT finish
        }

        try {
            const count = await this.queryTagCount();
            this._log(`Reading all ${count} tags...`);

            if (count === 0) return [];

            const tags = [];
            for (let i = 1; i <= count; i++) {
                try {
                    const tag = await this.readTag(i);
                    tags.push(tag);
                    if (onProgress) onProgress(i, count);
                } catch (e) {
                    this._log(`Failed to read tag ${i}: ${e.message}`);
                }
                // Small delay between reads to avoid overwhelming the device
                if (i < count) {
                    await new Promise(r => setTimeout(r, 100));
                }
            }

            this._log(`Read ${tags.length}/${count} tags`);
            return tags;
        } finally {
            if (wasScanning) {
                this._scanning = true;
                if (hadRetrigger) {
                    this._scanRetrigger = setInterval(async () => {
                        if (!this._scanning || !this.connected) {
                            clearInterval(this._scanRetrigger);
                            this._scanRetrigger = null;
                            return;
                        }
                        try { await this.triggerScan(); } catch (_) {}
                    }, 3000);
                }
                this._pollLoop();
                this._log('Poll resumed after download');
            }
        }
    }

    // ===============================================================
    // SCAN POLLING + AUTO-SCAN
    // Enables continuous reading mode, triggers SCAN, then polls
    // tag count as backup. Tags arrive as plain-text ASCII.
    // ===============================================================

    /**
     * Start scanning. Triggers SCAN command and starts polling tag count.
     * @param {Object} [opts]
     * @param {boolean} [opts.continuous=false] - Enable continuous reading mode
     * @param {boolean} [opts.stopOnTag=true] - Auto-stop when a tag is detected
     */
    async startScanPolling({ continuous = false, stopOnTag = true } = {}) {
        if (this._scanning) return;
        if (!this.connected) {
            this._log('Cannot start scan polling — not connected');
            return;
        }

        // HID mode — no UART commands, device types EIDs as keystrokes
        if (this._hidMode) {
            this._scanning = true;
            this._stopOnTag = stopOnTag;
            this._emit('scanning', { scanning: true, hidMode: true });
            this._log('IHID mode — scanner active, listening for keystrokes');
            return;
        }

        this._scanning = true;
        this._stopOnTag = stopOnTag;
        this._emit('scanning', { scanning: true });
        this._log(`Scan polling started (${continuous ? 'continuous' : 'single'} mode, stopOnTag=${stopOnTag})`);

        // If no write characteristic, we can only listen for physical button scans
        if (!this.writeCharacteristic) {
            this._log('No write characteristic — listening for physical scan button only');
            this._emit('listenOnly', { message: 'Press scan button on reader' });
            return;
        }

        // Get baseline count
        try {
            this._lastKnownCount = await this.queryTagCount();
            this._log(`Baseline tag count: ${this._lastKnownCount}`);
        } catch (e) {
            this._log(`Failed to get baseline count: ${e.message}`);
            this._lastKnownCount = 0;
        }

        // Set reading mode on the device
        if (!this._sppMode) {
            if (continuous) {
                await this.enableContinuousMode();
            } else {
                await this.enableSingleMode();
            }
        }

        // Trigger SCAN — activates the reader's antenna.
        // Tag data arrives separately as plain-text ASCII via notifications.
        // Only works when device is on SCAN or Tag Information screen.
        try {
            const scanOk = await this.triggerScan();
            if (scanOk) {
                this._log('SCAN triggered — reader antenna active');
            } else {
                this._log('SCAN trigger failed — device may not be on scan screen');
            }
        } catch (e) {
            this._log(`SCAN trigger error: ${e.message}`);
        }

        // In continuous mode, re-trigger SCAN every 3s as a keepalive
        if (continuous) {
            this._scanRetrigger = setInterval(async () => {
                if (!this._scanning || !this.connected) {
                    clearInterval(this._scanRetrigger);
                    this._scanRetrigger = null;
                    return;
                }
                try { await this.triggerScan(); } catch (_) {}
            }, 3000);
        }

        this._pollLoop();
    }

    async _pollLoop() {
        if (!this._scanning || !this.connected) {
            this._scanning = false;
            this._emit('scanning', { scanning: false });
            return;
        }

        try {
            const count = await this.queryTagCount();

            if (count > this._lastKnownCount) {
                this._log(`New tags detected: ${count} (was ${this._lastKnownCount})`);

                // Read the new tag(s)
                for (let i = this._lastKnownCount + 1; i <= count; i++) {
                    try {
                        const tag = await this.readTag(i);
                        this._emitTag(tag.tagId, tag.tagType, tag.timestamp);
                    } catch (e) {
                        this._log(`Failed to read new tag ${i}: ${e.message}`);
                    }
                }
                this._lastKnownCount = count;
            }
        } catch (e) {
            this._log(`Poll error: ${e.message}`);
        }

        // Schedule next poll
        if (this._scanning && this.connected) {
            this._pollTimer = setTimeout(() => this._pollLoop(), 500);
        }
    }

    /**
     * Stop scan polling.
     */
    stopScanPolling() {
        this._scanning = false;
        this._stopOnTag = false;
        clearTimeout(this._pollTimer);
        this._pollTimer = null;
        clearInterval(this._scanRetrigger);
        this._scanRetrigger = null;
        this._emit('scanning', { scanning: false });
        this._log('Scan polling stopped');
    }

    // ===============================================================
    // CONNECTION
    // ===============================================================

    async connect(showAll = false) {
        try {
            this._log('Requesting BLE device...');

            // Minimal optionalServices — Bluefy crashes with too many UUIDs.
            const minimalServices = ['0000ffe0-0000-1000-8000-00805f9b34fb'];

            const filterOptions = {
                filters: [
                    { namePrefix: 'AgriEID' },
                    { namePrefix: 'HID' },
                    { namePrefix: 'BTU' },
                    { namePrefix: 'RFID' },
                    { namePrefix: 'EID' },
                    { namePrefix: 'DEJ' },
                ],
                optionalServices: minimalServices
            };

            let device = null;

            if (!showAll) {
                device = await navigator.bluetooth.requestDevice(filterOptions);
            } else {
                try {
                    device = await navigator.bluetooth.requestDevice({
                        acceptAllDevices: true,
                        optionalServices: minimalServices
                    });
                } catch (e) {
                    this._log(`acceptAllDevices failed, falling back to filters`);
                    device = await navigator.bluetooth.requestDevice(filterOptions);
                }
            }

            this.device = device;
            this._log(`Device selected: ${this.device.name || this.device.id}`);

            await this._connectGattWithDisconnectHandler();
            return true;
        } catch (error) {
            const msg = error?.message || error?.name || String(error);
            this._log(`CONNECTION FAILED: ${msg}`);
            console.error('EID reader connection failed:', error);
            this.connected = false;
            this._emit('connection', { connected: false, error: msg });
            return false;
        }
    }

    async _connectGattWithDisconnectHandler() {
        this.device.addEventListener('gattserverdisconnected', () => {
            this._log('GATT disconnected');
            if (this._hidMode) {
                this._log('HID mode — GATT disconnect ignored');
                this.server = null;
                this.notifyCharacteristic = null;
                this.writeCharacteristic = null;
                return;
            }
            this.connected = false;
            this.stopScanPolling();
            this._emit('connection', { connected: false });
            if (!this._manualDisconnect) {
                this._reconnect();
            }
            this._manualDisconnect = false;
        });
        await this._connectGatt();
    }

    async _connectGatt() {
        this._log('Step 1: Connecting GATT server...');
        this.server = await withTimeout(
            this.device.gatt.connect(),
            20000,
            'GATT connect'
        );
        this._log('Step 1: GATT connected OK');

        // Discover available services
        this._log('Step 2: Discovering services...');
        let availableServices = [];
        try {
            availableServices = await withTimeout(
                this.server.getPrimaryServices(),
                10000,
                'Service discovery'
            );
            this._log(`Found ${availableServices.length} service(s):`);
            for (const svc of availableServices) {
                this._log(`  > ${svc.uuid}`);
            }
        } catch (e) {
            this._log(`Service discovery failed: ${e.message}`);
        }

        // Try each known UART profile
        this._log('Step 3: Looking for UART service...');
        for (const profile of SAFE_UART_PROFILES) {
            try {
                this._log(`  Trying ${profile.name}...`);
                const service = await withTimeout(
                    this.server.getPrimaryService(profile.service),
                    5000,
                    profile.name
                );
                this._log(`  Found service: ${profile.name}`);

                // SAFETY: Request ONLY specific characteristic UUIDs
                let txChar = null;
                try {
                    txChar = await withTimeout(
                        service.getCharacteristic(profile.tx),
                        5000,
                        'TX char'
                    );
                    const props = txChar.properties;
                    this._log(`  TX char: notify=${props.notify} indicate=${props.indicate} read=${props.read} write=${props.write}`);
                } catch (e) {
                    this._log(`  TX char not found: ${e.message}`);
                }

                let rxChar = null;
                if (profile.rx !== profile.tx) {
                    try {
                        rxChar = await withTimeout(
                            service.getCharacteristic(profile.rx),
                            5000,
                            'RX char'
                        );
                        this._log(`  RX char found: ${profile.rx}`);
                    } catch (e) {
                        this._log(`  RX char ${profile.rx} not found: ${e.message}`);
                    }
                }

                // Subscribe to TX notifications
                if (txChar) {
                    const props = txChar.properties;
                    if (props.notify || props.indicate) {
                        this._log(`  Subscribing to notifications...`);
                        await withTimeout(
                            txChar.startNotifications(),
                            5000,
                            'Start notifications'
                        );
                        txChar.addEventListener('characteristicvaluechanged', (e) => {
                            this._handleData(e.target.value);
                        });
                        this.notifyCharacteristic = txChar;
                        this._log(`  Subscribed OK`);
                    }

                    if (props.write || props.writeWithoutResponse) {
                        this.writeCharacteristic = txChar;
                        this._log(`  Write via TX char`);
                    }
                }

                if (rxChar) {
                    const rxProps = rxChar.properties;
                    if (rxProps.write || rxProps.writeWithoutResponse) {
                        this.writeCharacteristic = rxChar;
                        this._log(`  Write via RX char`);
                    }
                    if (!this.notifyCharacteristic && (rxProps.notify || rxProps.indicate)) {
                        this._log(`  Subscribing to RX notifications...`);
                        await withTimeout(rxChar.startNotifications(), 5000, 'RX notifications');
                        rxChar.addEventListener('characteristicvaluechanged', (e) => {
                            this._handleData(e.target.value);
                        });
                        this.notifyCharacteristic = rxChar;
                        this._log(`  Subscribed to RX OK`);
                    }
                }

                // Fallback: if no write char found, scan ALL characteristics on this service
                if (!this.writeCharacteristic && this.notifyCharacteristic) {
                    this._log(`  No write char from profile — scanning service for writable chars...`);
                    try {
                        const allChars = await withTimeout(
                            service.getCharacteristics(),
                            5000,
                            'Get all characteristics'
                        );
                        for (const c of allChars) {
                            const p = c.properties;
                            this._log(`    ${c.uuid}: notify=${p.notify} write=${p.write} writeNoResp=${p.writeWithoutResponse}`);
                            if ((p.write || p.writeWithoutResponse) && !this.writeCharacteristic) {
                                this.writeCharacteristic = c;
                                this._log(`    → Using ${c.uuid} for write`);
                            }
                        }
                    } catch (e) {
                        this._log(`  Characteristic scan failed: ${e.message}`);
                    }
                }

                if (this.notifyCharacteristic) {
                    this._profileName = profile.name;
                    this.connected = true;
                    this._decoded = [];
                    this._log(`=== CONNECTED via ${profile.name} ===`);
                    this._log(`  Notify: YES | Write: ${this.writeCharacteristic ? 'YES' : 'NO (physical scan only)'}`);
                    this._emit('connection', { connected: true, name: this.device.name, canWrite: !!this.writeCharacteristic });
                    return;
                }

            } catch (e) {
                this._log(`  ${profile.name}: ${e.message}`);
            }
        }

        // No known profile matched — check if HID-only device
        this._log('=== NO MATCHING UART PROFILE ===');
        if (availableServices.length > 0) {
            this._log('Available services on this device:');
            for (const svc of availableServices) {
                this._log(`  ${svc.uuid}`);
            }
        }

        // Detect HID keyboard device — works as scanner via OS Bluetooth
        const hasInfoOrBattery = availableServices.some(s =>
            s.uuid === '0000180a-0000-1000-8000-00805f9b34fb' ||
            s.uuid === '0000180f-0000-1000-8000-00805f9b34fb'
        );
        if (hasInfoOrBattery) {
            this._log('=== SIMULATED KEYBOARD HID DEVICE DETECTED ===');
            this._log('This reader works in simulated keyboard HID mode.');
            this._log('Scanned tags will be typed as keystrokes automatically.');
            this._profileName = 'Simulated Keyboard HID';
            this.connected = true;
            this._hidMode = true;
            this._decoded = [];
            this._emit('connection', { connected: true, name: this.device.name, hidMode: true });
            return;
        }

        throw new Error('No compatible UART service found. Check debug log.');
    }

    async _reconnect() {
        if (!this.device || this._reconnecting) return;

        // HID-mode devices don't need reconnect — they work via OS Bluetooth
        if (this._hidMode) {
            this._log('HID mode — no reconnect needed, scans work via OS Bluetooth');
            return;
        }

        this._reconnecting = true;

        for (let i = 1; i <= 3; i++) {
            this._log(`Reconnect attempt ${i}/3...`);
            await new Promise(r => setTimeout(r, 2000));
            try {
                await this._connectGatt();
                this._reconnecting = false;
                return;
            } catch (e) {
                this._log(`Reconnect ${i} failed: ${e.message}`);
            }
        }
        this._log('Reconnect gave up.');
        this._reconnecting = false;
        this._emit('connection', { connected: false, error: 'Reconnect failed' });
    }

    /**
     * Disconnect GATT but keep device reference for quick reconnect.
     */
    softDisconnect() {
        // SPP mode — use SPP disconnect
        if (this._sppMode) {
            this.disconnectSPP();
            return;
        }
        this.stopScanPolling();
        this._reconnecting = false;
        this._manualDisconnect = true;
        if (this.device?.gatt?.connected) {
            this.device.gatt.disconnect();
        }
        this.server = null;
        this.notifyCharacteristic = null;
        this.writeCharacteristic = null;
        this.connected = false;
        this._hidMode = false;
        this._decoded = [];
        this._cancelPendingCommand();
        this._emit('connection', { connected: false });
    }

    /**
     * Enable HID scanner mode without BLE pairing.
     * Use when the reader is already paired at the OS level
     * and works as an HID keyboard (scans type as keystrokes).
     */
    enableHIDMode(deviceName = 'Simulated Keyboard HID') {
        this._log('=== SIMULATED KEYBOARD HID MODE ENABLED ===');
        this._log('Reader set as simulated keyboard HID.');
        this._log('Scanned tags arrive as keystrokes via OS Bluetooth.');
        this._profileName = 'Simulated Keyboard HID';
        this.connected = true;
        this._hidMode = true;
        this._decoded = [];
        this._emit('connection', { connected: true, name: deviceName, hidMode: true });
    }

    // ===============================================================
    // SPP (Serial Port Profile) — Web Serial API
    // ===============================================================

    /**
     * Connect to the reader via Serial Port Profile (SPP).
     * Uses the Web Serial API — reader must be paired at OS level.
     * Tags are pushed instantly over serial when the scan button is pressed.
     * @param {number} baudRate - Serial baud rate (default 9600)
     * @returns {Promise<boolean>}
     */
    async connectSPP(baudRate = 9600) {
        if (!navigator.serial) {
            this._log('Web Serial API not available in this browser');
            throw new Error('Web Serial API not supported — use Chrome or Edge');
        }

        try {
            this._log('Requesting serial port...');
            this._serialPort = await navigator.serial.requestPort();

            this._log(`Opening serial port at ${baudRate} baud...`);
            await this._serialPort.open({ baudRate });

            this._sppMode = true;
            this.connected = true;
            this._decoded = [];
            this._textBuf = '';
            this._profileName = 'SPP Serial';

            this._log('=== SPP CONNECTED ===');
            this._emit('connection', { connected: true, name: 'SPP Reader', sppMode: true });

            // Start reading serial data
            this._readSerialLoop();

            return true;
        } catch (error) {
            this._log(`SPP CONNECTION FAILED: ${error.message}`);
            this._sppMode = false;
            this.connected = false;
            this._emit('connection', { connected: false, error: error.message });
            return false;
        }
    }

    /**
     * Continuously read from the serial port.
     * Feeds incoming bytes through the DEJ protocol parser.
     * Also handles plain-text tag IDs (newline-delimited) as fallback.
     */
    async _readSerialLoop() {
        if (!this._serialPort?.readable) return;

        this._serialReader = this._serialPort.readable.getReader();

        try {
            while (true) {
                const { value, done } = await this._serialReader.read();
                if (done) {
                    this._log('SPP serial stream ended');
                    break;
                }

                if (value && value.length > 0) {
                    // Log raw bytes
                    const hex = Array.from(value).map(b => b.toString(16).padStart(2, '0')).join(' ');
                    this._log(`SPP RX [${value.length}]: ${hex}`);

                    // Check if this looks like DEJ protocol (first byte XOR 0x55 = 0xC3 header)
                    const firstDecoded = value[0] ^ XOR_KEY;
                    const hasDEJData = firstDecoded === FRAME_HEADER || this._decoded.length > 0;

                    if (hasDEJData) {
                        // Feed to DEJ protocol parser (same as BLE UART)
                        for (const byte of value) {
                            this._decoded.push(byte ^ XOR_KEY);
                        }
                        let frame;
                        while ((frame = this._tryParseFrame()) !== null) {
                            this._routeFrame(frame);
                        }
                        if (this._decoded.length > 512) {
                            this._decoded = this._decoded.slice(-256);
                        }
                    } else {
                        // Plain text fallback — accumulate and look for newline-delimited tag IDs
                        const text = new TextDecoder().decode(value);
                        this._textBuf += text;
                        this._processTextBuffer();
                    }
                }
            }
        } catch (e) {
            if (e.name !== 'AbortError') {
                this._log(`SPP read error: ${e.message}`);
            }
        } finally {
            try { this._serialReader.releaseLock(); } catch (_) {}
            this._serialReader = null;

            // Handle unexpected disconnect
            if (this._sppMode && this.connected) {
                this._log('SPP disconnected unexpectedly');
                this._sppMode = false;
                this.connected = false;
                this._emit('connection', { connected: false });
            }
        }
    }

    /**
     * Process plain-text buffer for newline-delimited tag IDs.
     * Works for both BLE and SPP — reader sends scanned tags as ASCII.
     * Handles formats like "999115002391022\r\n" or "999115002391022\n"
     */
    _processTextBuffer() {
        const lines = this._textBuf.split(/[\r\n]+/);
        // Keep incomplete last line in buffer
        this._textBuf = lines.pop() || '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            // Check if line is all digits (10-16 chars = EID tag)
            if (/^\d{10,16}$/.test(trimmed)) {
                this._log(`Plain-text tag: ${trimmed}`);
                // Bump baseline count — the reader also stores this tag,
                // so the count will increase. Without this bump, the poll
                // loop would detect the count change and re-read the stored
                // tag (which may return a different/older EID from storage).
                this._lastKnownCount++;
                this._emitTag(trimmed, 'FDXB', new Date().toISOString());
            } else {
                this._log(`Plain-text data: ${trimmed}`);
            }
        }

        // Prevent runaway buffer
        if (this._textBuf.length > 256) {
            this._textBuf = this._textBuf.slice(-128);
        }
    }

    /**
     * Send raw bytes over SPP serial (for DEJ commands).
     */
    async _sendSPPCommand(cmdType, cmdParam, payload = [], timeoutMs = 5000) {
        if (!this._serialPort?.writable) {
            throw new Error('SPP serial port not writable');
        }

        const encoded = this._buildFrame(cmdType, cmdParam, payload);
        this._log(`SPP TX [${encoded.length}]: ${Array.from(encoded).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);

        const writer = this._serialPort.writable.getWriter();
        try {
            await writer.write(encoded);
        } finally {
            writer.releaseLock();
        }

        // Wait for response via _routeFrame
        return new Promise((resolve, reject) => {
            this._pendingResolve = resolve;
            this._pendingReject = reject;
            this._pendingCmdParam = cmdParam;  // track what we sent
            this._pendingTimeout = setTimeout(() => {
                this._pendingResolve = null;
                this._pendingReject = null;
                this._pendingCmdParam = null;
                reject(new Error(`SPP command 0x${cmdParam.toString(16)} timed out`));
            }, timeoutMs);
        });
    }

    /**
     * Disconnect SPP serial port.
     */
    async disconnectSPP() {
        this._log('Disconnecting SPP...');
        this._sppMode = false;
        this.connected = false;

        if (this._serialReader) {
            try { await this._serialReader.cancel(); } catch (_) {}
            this._serialReader = null;
        }
        if (this._serialPort) {
            try { await this._serialPort.close(); } catch (_) {}
            this._serialPort = null;
        }

        this._decoded = [];
        this._textBuf = '';
        this._cancelPendingCommand();
        this._emit('connection', { connected: false });
        this._log('SPP disconnected');
    }

    /**
     * Reconnect to a previously paired device (no picker).
     */
    async reconnect() {
        if (!this.device) {
            return this.connect();
        }

        this._manualDisconnect = false;

        try {
            this._log(`Reconnecting to ${this.device.name || this.device.id}...`);
            await this._connectGatt();
            return true;
        } catch (error) {
            this._log(`Reconnect failed: ${error.message}`);
            this.connected = false;
            this._emit('connection', { connected: false, error: error.message });
            return false;
        }
    }

    /**
     * Full disconnect — clears device reference.
     */
    disconnect() {
        // SPP mode — use SPP disconnect
        if (this._sppMode) {
            this.disconnectSPP();
            return;
        }
        this.stopScanPolling();
        this._reconnecting = false;
        this._manualDisconnect = true;
        if (this.device?.gatt?.connected) {
            this.device.gatt.disconnect();
        }
        this.device = null;
        this.server = null;
        this.notifyCharacteristic = null;
        this.writeCharacteristic = null;
        this.connected = false;
        this._hidMode = false;
        this._decoded = [];
        this._cancelPendingCommand();
        this._emit('connection', { connected: false });
    }

    // -----------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------

    _cancelPendingCommand() {
        if (this._pendingReject) {
            this._pendingReject(new Error('Disconnected'));
        }
        this._pendingResolve = null;
        this._pendingReject = null;
        this._pendingCmdParam = null;
        clearTimeout(this._pendingTimeout);
        this._pendingTimeout = null;
    }

    _emitTag(tagId, tagType, timestamp) {
        if (!tagId || tagId.length < 5) {
            this._log(`Ignoring short tag: "${tagId}"`);
            return;
        }
        this._log(`*** TAG: ${tagId} (${tagType}) ***`);
        this._emit('tag', { tagId, tagType, timestamp: timestamp || new Date().toISOString() });

        // Auto-stop scanning if _stopOnTag is set (single scan or auto-scan found a tag)
        if (this._stopOnTag && this._scanning) {
            this._log('Tag detected — auto-stopping scan');
            this.stopScanPolling();
        }
    }

    _log(msg) {
        console.log(`[EID] ${msg}`);
        this._emit('log', { message: msg });
    }

    _emit(type, detail) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
    }
}
