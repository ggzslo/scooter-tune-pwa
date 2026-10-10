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

const xorsum = bytes => bytes.reduce((x, b) => x ^ b, 0);

/* Empfangene Frames:
 *  D5 | LEN | …  | SUM   – Controller-Status (Summen-Prüfsumme wie beim Senden)
 *  01 | LEN | …  | XOR   – Display-/Telemetrie-Frame (XOR über alle Bytes)
 */
function parseFrame(bytes) {
    if (bytes.length < 3 || bytes[1] !== bytes.length) return null;
    const last = bytes[bytes.length - 1];
    if (bytes[0] === 0xD5 || bytes[0] === HEADER) {
        return { type: bytes[0].toString(16).toUpperCase(), valid: checksum(bytes.slice(1, -1)) === last };
    }
    if (bytes[0] === 0x01) return { type: '01', valid: xorsum(bytes.slice(0, -1)) === last };
    return null;
}

// Vermutete Felder – müssen noch durch Fahr-/Ladedaten bestätigt werden
const u16 = (b, i) => (b[i] << 8) | b[i + 1];
const FIELDS = [
    { id: 'volt', label: 'Spannung', frame: '01', unit: 'V', guess: true, read: b => (u16(b, 14) / 10).toFixed(1).replace('.', ',') },
    { id: 'batA', label: 'Akku', frame: '01', unit: '%', guess: true, read: b => b[8] },
    { id: 'batB', label: 'Akku (alt.)', frame: 'D5', unit: '%', guess: true, read: b => b[19] },
    { id: 'odo', label: 'Kilometer', frame: 'D5', unit: 'km', guess: true, read: b => (u16(b, 17) / 10).toFixed(1).replace('.', ',') }
];

/* ---------- Hilfsfunktionen ---------- */
const $ = id => document.getElementById(id);
const toHex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0').toUpperCase()).join('');

function fromHex(str) {
    const clean = str.replace(/\s+/g, '');
    if (!/^([0-9a-fA-F]{2})+$/.test(clean)) throw new Error('Ungültiger Hex-String (nur 0-9/A-F, gerade Länge)');
    return Uint8Array.from(clean.match(/../g), h => parseInt(h, 16));
}

const store = {
    get(key, fallback) {
        try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
    },
    set(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Speicher nicht verfügbar */ }
    }
};

const vibrate = pattern => navigator.vibrate?.(pattern);

const MAX_LOG = 200;
const MAX_HISTORY = 2000;
const logHistory = [];
function log(msg, type = 'info') {
    const out = $('log-output');
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logHistory.push(`${new Date().toISOString()} ${type.toUpperCase().padEnd(7)} ${msg}`);
    if (logHistory.length > MAX_HISTORY) logHistory.shift();
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.textContent = line;
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

        store.set('lastDevice', { id: device.id, name: device.name || '' });
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

// Bekannten Scooter ohne Geräteauswahl verbinden (Chrome: getDevices)
async function findKnownDevice() {
    const last = store.get('lastDevice');
    if (!last || !navigator.bluetooth?.getDevices) return null;
    try {
        return (await navigator.bluetooth.getDevices()).find(d => d.id === last.id) || null;
    } catch { return null; }
}

function waitForAdvertisement(device, ms = 8000) {
    if (!device.watchAdvertisements) return Promise.resolve();
    const ctrl = new AbortController();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { ctrl.abort(); reject(new Error('Scooter nicht in Reichweite.')); }, ms);
        device.addEventListener('advertisementreceived', () => {
            clearTimeout(timer);
            ctrl.abort();
            resolve();
        }, { once: true });
        device.watchAdvertisements({ signal: ctrl.signal }).catch(err => { clearTimeout(timer); reject(err); });
    });
}

async function autoConnect() {
    const device = await findKnownDevice();
    if (!device) return false;
    log(`Suche ${device.name || 'bekannten Scooter'}…`);
    try {
        await waitForAdvertisement(device);
        await ble.connect(device);
        setUI(true);
        vibrate(30);
        toast('Automatisch verbunden');
        return true;
    } catch (err) {
        log(`Auto-Verbindung: ${err.message}`, 'warning');
        return false;
    }
}

const frames = {};          // type -> { bytes, changedAt[] }
const repeatCount = {};

function onNotify(e) {
    const bytes = new Uint8Array(e.target.value.buffer.slice(0));
    const f = parseFrame(bytes);
    const type = f?.type ?? '??';
    const prev = frames[type];
    const hex = toHex(bytes);

    // Nur geänderte Frames protokollieren, sonst flutet das Log (~16 Frames/s)
    if (!prev || toHex(prev.bytes) !== hex) {
        if (repeatCount[type]) log(`   … ${repeatCount[type]}× unverändert`, 'info');
        repeatCount[type] = 0;
        const note = f ? (f.valid ? ` [${type}]` : ` [${type}, Prüfsumme falsch]`) : ' [unbekannt]';
        log(`RX: ${hex}${note}`, 'rx');
    } else {
        repeatCount[type]++;
    }

    const now = Date.now();
    const changedAt = prev?.changedAt?.length === bytes.length ? prev.changedAt : new Array(bytes.length).fill(0);
    if (prev) bytes.forEach((b, i) => { if (prev.bytes[i] !== b) changedAt[i] = now; });
    frames[type] = { bytes, changedAt, valid: f?.valid };
    scheduleLiveRender();
}

let renderPending = false;
function scheduleLiveRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => { renderPending = false; renderLive(); });
}

function renderLive() {
    $('live-values').replaceChildren(...FIELDS.map(f => {
        const fr = frames[f.frame];
        const el = document.createElement('div');
        el.className = 'live-item';
        const val = fr?.valid ? f.read(fr.bytes) : '–';
        el.innerHTML = '<span class="live-label"></span><span class="live-value"></span>';
        el.firstChild.textContent = f.label + (f.guess ? ' ?' : '');
        el.lastChild.textContent = `${val} ${f.unit}`;
        return el;
    }));

    const now = Date.now();
    $('raw-frames').replaceChildren(...Object.entries(frames).map(([type, fr]) => {
        const row = document.createElement('div');
        row.className = 'raw-row';
        const label = document.createElement('div');
        label.className = 'raw-label';
        label.textContent = `${type}${fr.valid ? '' : ' ✗'}`;
        const grid = document.createElement('div');
        grid.className = 'raw-bytes';
        fr.bytes.forEach((b, i) => {
            const cell = document.createElement('span');
            cell.textContent = b.toString(16).padStart(2, '0').toUpperCase();
            cell.title = `Byte ${i} = ${b}`;
            if (now - fr.changedAt[i] < 3000) cell.className = 'changed';
            grid.append(cell);
        });
        row.append(label, grid);
        return row;
    }));
}

setInterval(() => { if (Object.keys(frames).length) renderLive(); }, 1000);

let reconnecting = false;
async function onDisconnected() {
    ble.write = ble.notify = null;
    setUI(false);
    if (ble.manualDisconnect) return log('Verbindung getrennt.', 'warning');
    if (reconnecting) return; // läuft schon – keine parallelen Versuche

    reconnecting = true;
    log('Verbindung verloren – versuche Neuverbindung…', 'warning');
    try {
        for (let i = 1; i <= 5; i++) {
            await new Promise(r => setTimeout(r, 1000 * i));
            if (ble.manualDisconnect) return;
            try {
                await ble.connect(ble.device);
                setUI(true);
                toast('Wieder verbunden');
                return;
            } catch (err) { log(`Neuverbindung ${i}/5 fehlgeschlagen: ${err.message}`, 'error'); }
        }
        toast('Verbindung verloren');
    } finally {
        reconnecting = false;
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
        vibrate(30);
        if (successMsg) toast(successMsg);
        return true;
    } catch (err) {
        vibrate([60, 60, 60]);
        log(`Fehler: ${err.message}`, 'error');
        toast('Senden fehlgeschlagen');
        return false;
    }
}

/* ---------- Zustand & Profile ---------- */
const MODE_NAMES = ['ECO', 'Normal', 'Sport', 'Dev', 'Modus 5'];
const state = store.get('state', { speed: null, mode: null });

function saveState(patch) {
    Object.assign(state, patch);
    store.set('state', state);
    renderState();
}

function renderState() {
    const parts = [];
    if (state.speed != null) parts.push(`${state.speed} km/h`);
    if (state.mode != null) parts.push(MODE_NAMES[state.mode]);
    const el = $('last-state');
    el.textContent = parts.length ? `Zuletzt gesendet: ${parts.join(' · ')}` : '';
    el.classList.toggle('hidden', !parts.length);
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('selected', +b.dataset.mode === state.mode));
}

const DEFAULT_PROFILES = [
    { name: 'Stadt', speed: 20, mode: 0 },
    { name: 'Standard', speed: 20, mode: 1 }
];
let profiles = store.get('profiles', DEFAULT_PROFILES);

function renderProfiles() {
    const list = $('profile-list');
    list.replaceChildren(...profiles.map((p, i) => {
        const row = document.createElement('div');
        row.className = 'profile-row';
        const apply = document.createElement('button');
        apply.className = 'btn-secondary profile-apply';
        apply.dataset.index = i;
        apply.innerHTML = '<span class="profile-name"></span><span class="profile-meta"></span>';
        apply.querySelector('.profile-name').textContent = p.name;
        apply.querySelector('.profile-meta').textContent = `${p.speed} km/h · ${MODE_NAMES[p.mode]}`;
        const del = document.createElement('button');
        del.className = 'btn-text profile-delete';
        del.dataset.index = i;
        del.setAttribute('aria-label', `Profil ${p.name} löschen`);
        del.textContent = '✕';
        row.append(apply, del);
        return row;
    }));
}

async function confirmSpeed(v) {
    return v <= LEGAL_LIMIT || confirmAction(
        `${v} km/h liegt über dem gesetzlichen Limit von ${LEGAL_LIMIT} km/h. Nur auf Privatgelände nutzen. Fortfahren?`);
}

async function applyProfile(p) {
    if (!await confirmSpeed(p.speed)) return;
    if (!await run(Commands.mode(p.mode))) return;
    saveState({ mode: p.mode });
    if (!await run(Commands.speed(p.speed), `Profil „${p.name}“ aktiv`)) return;
    saveState({ speed: p.speed });
    setSpeedView(p.speed);
}

async function exportLog() {
    if (!logHistory.length) return toast('Protokoll ist leer');
    const text = `Scooter Tune – Protokoll\n${navigator.userAgent}\n\n${logHistory.join('\n')}\n`;
    const name = `scooter-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`;
    const file = new File([text], name, { type: 'text/plain' });
    try {
        if (navigator.canShare?.({ files: [file] })) return await navigator.share({ files: [file], title: name });
    } catch (err) {
        if (err.name === 'AbortError') return;
    }
    const url = URL.createObjectURL(file);
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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
            if (await autoConnect()) return;
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
        if (!await confirmSpeed(v)) return;
        if (await run(Commands.speed(v), `Limit: ${v} km/h`)) saveState({ speed: v });
    });

    $('mode-buttons').addEventListener('click', async e => {
        const btn = e.target.closest('[data-mode]');
        if (!btn) return;
        const mode = +btn.dataset.mode;
        if (await run(Commands.mode(mode), `Modus: ${btn.textContent}`)) saveState({ mode });
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

    $('btn-clear-log').addEventListener('click', () => {
        $('log-output').replaceChildren();
        logHistory.length = 0;
    });
    $('btn-export-log').addEventListener('click', exportLog);

    $('profile-list').addEventListener('click', async e => {
        const apply = e.target.closest('.profile-apply');
        const del = e.target.closest('.profile-delete');
        if (apply) return applyProfile(profiles[+apply.dataset.index]);
        if (del) {
            const p = profiles[+del.dataset.index];
            if (!await confirmAction(`Profil „${p.name}“ löschen?`)) return;
            profiles.splice(+del.dataset.index, 1);
            store.set('profiles', profiles);
            renderProfiles();
        }
    });

    $('profile-form').addEventListener('submit', e => {
        e.preventDefault();
        const name = $('profile-name').value.trim();
        if (!name) return;
        const p = { name, speed: +$('speed-slider').value, mode: state.mode ?? 1 };
        const existing = profiles.findIndex(x => x.name.toLowerCase() === name.toLowerCase());
        existing >= 0 ? profiles.splice(existing, 1, p) : profiles.push(p);
        store.set('profiles', profiles);
        renderProfiles();
        $('profile-name').value = '';
        toast(`Profil „${name}“ gespeichert`);
    });

    renderProfiles();
    renderState();
    setSpeedView(state.speed ?? +$('speed-slider').value);

    findKnownDevice().then(d => {
        if (d) $('btn-connect').textContent = `Mit ${d.name || 'Scooter'} verbinden`;
    });

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW:', err));
    }
}

init();
