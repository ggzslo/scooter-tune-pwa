'use strict';

/* ---------- Protokoll ----------
 * Frame: D7 | LEN | CMD | DATA… | CHK
 * LEN  = Gesamtlänge des Frames inkl. Header und Prüfsumme
 * CHK  = Summe aller Bytes nach D7 (inkl. LEN), mod 256
 */
const HEADER = 0xD7;
const CMD = { LOCK: 0xA0, MODE: 0xA3, SPEED: 0xA9 };
const SPEED_MIN = 8;
const SPEED_MAX = 30;
const LEGAL_LIMIT = 20;

const checksum = bytes => bytes.reduce((sum, b) => (sum + b) & 0xFF, 0);

function buildFrame(cmd, data) {
    const body = [data.length + 4, cmd, ...data];
    return Uint8Array.from([HEADER, ...body, checksum(body)]);
}

const Commands = {
    lock: () => buildFrame(CMD.LOCK, [0x00, 0x01, 0x01]),
    unlock: () => buildFrame(CMD.LOCK, [0x00, 0x03, 0x01]),
    mode: m => buildFrame(CMD.MODE, [0x00, m]),
    speed: kmh => {
        const v = kmh * 10;
        return buildFrame(CMD.SPEED, [0x00, (v >> 8) & 0xFF, v & 0xFF]);
    }
};

function parseFrame(bytes) {
    if (bytes.length < 3 || bytes[0] !== HEADER) return null;
    const body = bytes.slice(1, -1);
    return { cmd: bytes[2], data: bytes.slice(3, -1), valid: checksum(body) === bytes[bytes.length - 1] };
}

/* ---------- Hilfsfunktionen ---------- */
const $ = id => document.getElementById(id);
const toHex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0').toUpperCase()).join('');

function fromHex(str) {
    const clean = str.replace(/\s+/g, '');
    if (!/^([0-9a-fA-F]{2})+$/.test(clean)) throw new Error('Ungültiger Hex-String (nur 0-9/A-F, gerade Länge)');
    return Uint8Array.from(clean.match(/../g), h => parseInt(h, 16));
}

const MAX_LOG = 200;
function log(msg, type = 'info') {
    const out = $('log-output');
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    out.append(entry);
    while (out.childElementCount > MAX_LOG) out.firstElementChild.remove();
    out.scrollTop = out.scrollHeight;
}

function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    $('toast-container').append(t);
    setTimeout(() => {
        t.style.animation = 'fadeOut .3s ease forwards';
        t.addEventListener('animationend', () => t.remove(), { once: true });
    }, 3000);
}

function confirmAction(text) {
    const dlg = $('confirm-dialog');
    if (!dlg.showModal) return Promise.resolve(window.confirm(text));
    $('confirm-text').textContent = text;
    dlg.returnValue = '';
    dlg.showModal();
    return new Promise(resolve =>
        dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}

/* ---------- BLE ---------- */
const SERVICES = {
    // Bevorzugte Kombinationen [service, write, notify]
    known: [
        ['0000ffe0-0000-1000-8000-00805f9b34fb', '0000ffe1-0000-1000-8000-00805f9b34fb', '0000ffe1-0000-1000-8000-00805f9b34fb'],
        ['6e400001-b5a3-f393-e0a9-e50e24dcca9e', '6e400002-b5a3-f393-e0a9-e50e24dcca9e', '6e400003-b5a3-f393-e0a9-e50e24dcca9e']
    ]
};

const ble = {
    device: null,
    write: null,
    notify: null,
    queue: Promise.resolve(),
    manualDisconnect: false,

    get connected() { return !!this.device?.gatt?.connected && !!this.write; },

    async request() {
        return navigator.bluetooth.requestDevice({
            acceptAllDevices: true,
            optionalServices: SERVICES.known.map(s => s[0])
        });
    },

    async connect(device) {
        this.device = device;
        this.manualDisconnect = false;
        device.removeEventListener('gattserverdisconnected', onDisconnected);
        device.addEventListener('gattserverdisconnected', onDisconnected);

        log(`Verbinde mit ${device.name || 'unbekanntem Gerät'}…`);
        const server = await device.gatt.connect();
        await this.discover(server);

        if (this.notify) {
            await this.notify.startNotifications();
            this.notify.addEventListener('characteristicvaluechanged', onNotify);
            log('Benachrichtigungen aktiv.');
        }
    },

    async discover(server) {
        this.write = this.notify = null;

        // 1. Bekannte UART-Services gezielt suchen
        for (const [svc, w, n] of SERVICES.known) {
            try {
                const service = await server.getPrimaryService(svc);
                this.write = await service.getCharacteristic(w);
                this.notify = await service.getCharacteristic(n).catch(() => null);
                log(`Service ${svc.slice(4, 8).toUpperCase()} gefunden.`);
                return;
            } catch { /* nächsten probieren */ }
        }

        // 2. Fallback: erste passende Characteristic
        for (const service of await server.getPrimaryServices()) {
            for (const c of await service.getCharacteristics()) {
                const p = c.properties;
                if (!this.write && (p.write || p.writeWithoutResponse)) this.write = c;
                if (!this.notify && (p.notify || p.indicate)) this.notify = c;
            }
            if (this.write && this.notify) break;
        }
        if (!this.write) throw new Error('Keine beschreibbare Characteristic gefunden.');
        log(`Fallback-Characteristic ${this.write.uuid} verwendet.`, 'warning');
    },

    disconnect() {
        this.manualDisconnect = true;
        this.device?.gatt?.connected && this.device.gatt.disconnect();
    },

    // GATT erlaubt nur eine Operation gleichzeitig -> Warteschlange
    send(bytes) {
        const task = this.queue.then(async () => {
            if (!this.connected) throw new Error('Nicht verbunden.');
            const c = this.write;
            if (c.properties.writeWithoutResponse && c.writeValueWithoutResponse) {
                await c.writeValueWithoutResponse(bytes);
            } else if (c.writeValueWithResponse) {
                await c.writeValueWithResponse(bytes);
            } else {
                await c.writeValue(bytes);
            }
            log(`TX: ${toHex(bytes)}`, 'tx');
        });
        this.queue = task.catch(() => {});
        return task;
    }
};

function onNotify(e) {
    const bytes = new Uint8Array(e.target.value.buffer);
    const f = parseFrame(bytes);
    const note = f ? (f.valid ? ` (CMD ${f.cmd.toString(16).toUpperCase()})` : ' (Prüfsumme falsch)') : '';
    log(`RX: ${toHex(bytes)}${note}`, 'rx');
}

async function onDisconnected() {
    ble.write = ble.notify = null;
    setUI(false);
    if (ble.manualDisconnect) return log('Verbindung getrennt.', 'warning');

    log('Verbindung verloren – versuche Neuverbindung…', 'warning');
    for (let i = 1; i <= 3; i++) {
        await new Promise(r => setTimeout(r, 1000 * i));
        try {
            await ble.connect(ble.device);
            setUI(true);
            return toast('Wieder verbunden');
        } catch { log(`Neuverbindung ${i}/3 fehlgeschlagen.`, 'error'); }
    }
}

/* ---------- UI ---------- */
function setUI(connected) {
    const status = $('connection-status');
    status.textContent = connected ? 'Verbunden' : 'Getrennt';
    status.className = connected ? 'status-connected' : 'status-disconnected';
    $('btn-connect').textContent = connected ? 'Trennen' : 'Scooter verbinden';
    $('main-content').classList.toggle('active', connected);
    $('main-content').inert = !connected;
}

async function run(bytes, successMsg) {
    try {
        await ble.send(bytes);
        if (successMsg) toast(successMsg);
        return true;
    } catch (err) {
        log(`Fehler: ${err.message}`, 'error');
        toast('Senden fehlgeschlagen');
        return false;
    }
}

function setSpeedView(v) {
    $('speed-slider').value = v;
    $('speed-value').textContent = v;
    $('speed-warning').classList.toggle('hidden', v <= LEGAL_LIMIT);
}

function init() {
    if (!navigator.bluetooth) {
        $('btn-connect').disabled = true;
        log('Web Bluetooth nicht verfügbar. Chrome/Edge (Android, Desktop) oder Bluefy (iOS) nutzen.', 'error');
    }

    $('btn-connect').addEventListener('click', async () => {
        if (ble.connected) return ble.disconnect();
        const btn = $('btn-connect');
        btn.disabled = true;
        try {
            await ble.connect(await ble.request());
            setUI(true);
            toast('Verbunden');
        } catch (err) {
            if (err.name !== 'NotFoundError') { // NotFoundError = Auswahl abgebrochen
                log(`Verbindung fehlgeschlagen: ${err.message}`, 'error');
                toast('Verbindung fehlgeschlagen');
            }
            ble.disconnect();
            setUI(false);
        } finally {
            btn.disabled = false;
        }
    });

    document.querySelectorAll('[data-cmd]').forEach(btn => btn.addEventListener('click', async () => {
        const lock = btn.dataset.cmd === 'lock';
        if (lock && !await confirmAction('Scooter sperren? Nur im Stillstand ausführen!')) return;
        run(lock ? Commands.lock() : Commands.unlock(), lock ? 'Gesperrt' : 'Entsperrt');
    }));

    $('speed-slider').addEventListener('input', e => setSpeedView(+e.target.value));
    $('speed-presets').addEventListener('click', e => {
        const s = e.target.closest('[data-speed]');
        if (s) setSpeedView(+s.dataset.speed);
    });

    $('btn-set-speed').addEventListener('click', async () => {
        const v = +$('speed-slider').value;
        if (v < SPEED_MIN || v > SPEED_MAX) return toast('Ungültiger Wert');
        if (v > LEGAL_LIMIT && !await confirmAction(
            `${v} km/h liegt über dem gesetzlichen Limit von ${LEGAL_LIMIT} km/h. Nur auf Privatgelände nutzen. Fortfahren?`)) return;
        run(Commands.speed(v), `Limit: ${v} km/h`);
    });

    $('mode-buttons').addEventListener('click', async e => {
        const btn = e.target.closest('[data-mode]');
        if (!btn) return;
        if (await run(Commands.mode(+btn.dataset.mode), `Modus: ${btn.textContent}`)) {
            document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('selected', b === btn));
        }
    });

    $('hex-form').addEventListener('submit', e => {
        e.preventDefault();
        try {
            let bytes = fromHex($('hex-cmd').value);
            if ($('hex-auto-checksum').checked) bytes = Uint8Array.from([...bytes, checksum([...bytes.slice(1)])]);
            run(bytes);
        } catch (err) {
            toast(err.message);
        }
    });

    $('btn-clear-log').addEventListener('click', () => $('log-output').replaceChildren());

    setSpeedView(+$('speed-slider').value);

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW:', err));
    }
}

init();
