// HiWeigh Scales BLE Connection & Mettler Toledo Continuous Output Parser
// Service: ISSC Transparent UART Service (TUS)
// Protocol: Mettler Toledo Continuous Output (18-byte frames)

const SCALES_SERVICE_UUID = '49535343-fe7d-4ae5-8fa9-9fafd205e455';
const SCALES_TX_UUID = '49535343-1e4d-4bd9-ba61-23c647249616';  // Notify - data FROM scales

const STX = 0x02;
const CR = 0x0D;
const FRAME_LENGTH = 18;

export class ScalesManager extends EventTarget {
    constructor() {
        super();
        this.device = null;
        this.txCharacteristic = null;
        this.connected = false;
        this.buffer = [];
        this._reconnecting = false;
    }

    async connect() {
        try {
            this.device = await navigator.bluetooth.requestDevice({
                filters: [
                    { namePrefix: 'AgriEID' },
                ],
                optionalServices: [SCALES_SERVICE_UUID]
            });

            this.device.addEventListener('gattserverdisconnected', () => {
                this.connected = false;
                this._emit('connection', { connected: false });
                if (!this._manualDisconnect) {
                    this._reconnect();
                }
                this._manualDisconnect = false;
            });

            await this._connectGatt();
            return true;
        } catch (error) {
            console.error('Scales connection failed:', error);
            this.connected = false;
            this._emit('connection', { connected: false, error: error.message });
            return false;
        }
    }

    async _connectGatt() {
        const server = await this.device.gatt.connect();
        const service = await server.getPrimaryService(SCALES_SERVICE_UUID);
        this.txCharacteristic = await service.getCharacteristic(SCALES_TX_UUID);

        await this.txCharacteristic.startNotifications();
        this.txCharacteristic.addEventListener('characteristicvaluechanged', (e) => {
            this._handleData(e.target.value);
        });

        this.connected = true;
        this.buffer = [];
        this._emit('connection', { connected: true, name: this.device.name });
    }

    async _reconnect() {
        if (!this.device || this._reconnecting) return;
        this._reconnecting = true;

        for (let i = 1; i <= 10; i++) {
            console.log(`Scales reconnect attempt ${i}...`);
            await new Promise(r => setTimeout(r, 2000));
            try {
                await this._connectGatt();
                this._reconnecting = false;
                return;
            } catch (e) {
                console.warn('Reconnect failed:', e.message);
            }
        }
        this._reconnecting = false;
    }

    _handleData(dataView) {
        for (let i = 0; i < dataView.byteLength; i++) {
            this.buffer.push(dataView.getUint8(i));
        }
        this._parseFrames();
    }

    _parseFrames() {
        // Find complete MT frames: STX ... CR CHECKSUM
        while (this.buffer.length >= FRAME_LENGTH) {
            const stxIndex = this.buffer.indexOf(STX);

            if (stxIndex === -1) {
                this.buffer = [];
                return;
            }
            if (stxIndex > 0) {
                this.buffer = this.buffer.slice(stxIndex);
            }
            if (this.buffer.length < FRAME_LENGTH) return;

            const frame = this.buffer.slice(0, FRAME_LENGTH);
            this.buffer = this.buffer.slice(FRAME_LENGTH);

            // Validate CR at position 16 (byte 17)
            if (frame[16] !== CR) {
                // Try to find next STX
                continue;
            }

            // Validate checksum: sum of all 18 bytes mod 256 = 0
            let sum = 0;
            for (const b of frame) sum = (sum + b) & 0xFF;

            if (sum !== 0) {
                // Checksum failed — try parsing anyway for debugging
                console.warn('Scales checksum error, parsing anyway');
            }

            this._parseFrame(frame);
        }
    }

    _parseFrame(frame) {
        const statusA = frame[1];
        const statusB = frame[2];
        const statusC = frame[3];

        // Extract weight digits (bytes 5-10, index 4-9) as ASCII
        let weightStr = '';
        for (let i = 4; i <= 9; i++) {
            weightStr += String.fromCharCode(frame[i]);
        }

        // Extract tare digits (bytes 11-16, index 10-15) as ASCII
        let tareStr = '';
        for (let i = 10; i <= 15; i++) {
            tareStr += String.fromCharCode(frame[i]);
        }

        // Parse Status B (most important for UI)
        const isNet = (statusB & 0x01) !== 0;
        const isNegative = (statusB & 0x02) !== 0;
        const isHighRes = (statusB & 0x04) !== 0;
        const isDynamic = (statusB & 0x08) !== 0;
        const isKg = (statusB & 0x10) !== 0;

        // Parse Status A - decimal point position (bits 2-0)
        const dpBits = statusA & 0x07;

        // Check if weight string contains a decimal point character
        // Some AGU9i indicators embed the decimal in the ASCII string
        const hasDecimalInString = weightStr.includes('.');

        let weight, tare, decimalPlaces;

        if (hasDecimalInString) {
            // Decimal is already in the string — parse as float, don't apply dpBits
            weight = parseFloat(weightStr) || 0;
            tare = parseFloat(tareStr) || 0;
            // Count actual decimal places from the string
            const parts = weightStr.trim().split('.');
            decimalPlaces = parts.length > 1 ? parts[1].replace(/\s/g, '').length : 0;
        } else {
            // AGU9i decimal point encoding: dpBits is offset by 2
            // Confirmed from field data:
            //   dpBits=2 (0x62) → 0 decimal places (5T indicator, whole kg)
            //   dpBits=3 (0x63) → 1 decimal place  (2T indicator, 0.5kg resolution)
            //   dpBits=4         → 2 decimal places
            //   dpBits=5         → 3 decimal places
            // Fallback: dpBits 0 or 1 treated as 0 dp (no decimal)
            decimalPlaces = Math.max(0, dpBits - 2);

            // Allow manual override from localStorage (e.g. for miscalibrated indicators)
            const dpOverride = localStorage.getItem('ae_dp_override');
            if (dpOverride !== null) {
                decimalPlaces = parseInt(dpOverride, 10) || 0;
            }

            let weightRaw = parseInt(weightStr.replace(/\s/g, ''), 10) || 0;
            let tareRaw = parseInt(tareStr.replace(/\s/g, ''), 10) || 0;

            weight = weightRaw / Math.pow(10, decimalPlaces);
            tare = tareRaw / Math.pow(10, decimalPlaces);

            // Sanity check: if dpBits > 0 but weight is unreasonably low for livestock
            // (raw integer > 100 but parsed weight < 20), the indicator's dp config is wrong.
            // Fall back to dp=0 (whole kg) which is standard for cattle scales.
            if (dpOverride === null && decimalPlaces > 0 && weightRaw > 100 && weight < 20) {
                console.warn(`[Scales] Decimal sanity check: dpBits=${dpBits} gave ${weight}kg from raw ${weightRaw} — falling back to dp=0`);
                decimalPlaces = 0;
                weight = weightRaw;
                tare = tareRaw;
            }
        }

        if (isNegative) weight = -weight;

        // Store last decimal places for use by app
        this.lastDecimalPlaces = decimalPlaces;

        const rawHex = Array.from(frame).map(b => b.toString(16).padStart(2, '0')).join(' ');

        // Debug logging (first 5 frames, then every 50th)
        if (!this._frameCount) this._frameCount = 0;
        this._frameCount++;
        if (this._frameCount <= 5 || this._frameCount % 50 === 0) {
            console.log(`[Scales] Frame #${this._frameCount}: weightStr="${weightStr}" dpBits=${dpBits} hasDecimal=${hasDecimalInString} → ${weight} (${decimalPlaces}dp) | StatusA=0x${statusA.toString(16)} StatusB=0x${statusB.toString(16)} | hex: ${rawHex}`);
        }

        const result = {
            weight,
            tare,
            decimalPlaces,
            isNet,
            isNegative,
            isDynamic,
            isSteady: !isDynamic,
            isKg,
            unit: isKg ? 'kg' : 'lb',
            weightType: isNet ? 'Net' : 'Gross',
            weightDisplay: weight.toFixed(decimalPlaces),
            rawHex
        };

        this._emit('weight', result);
    }

    disconnect() {
        this._reconnecting = false; // prevent auto-reconnect
        this._manualDisconnect = true;
        if (this.device?.gatt?.connected) {
            this.device.gatt.disconnect();
        }
        this.device = null;
        this.txCharacteristic = null;
        this.connected = false;
        this.buffer = [];
        this._emit('connection', { connected: false });
    }

    _emit(type, detail) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
    }
}
