import {
    eventSource,
    event_types,
    getRequestHeaders,
    saveSettingsDebounced,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import {
    SECRET_KEYS,
    secret_state,
    writeSecret,
    readSecretState,
    renameSecret,
    canViewSecrets,
} from '../../../secrets.js';

const EXTENSION_NAME = 'tmrw_keyflow';
const DISPLAY_NAME = 'TMRW—KeyFlow';
const EXTENSION_VERSION = '1.1.3';
const GENERATE_PATH = '/api/backends/chat-completions/generate';
const LARGE_KEY_COUNT = 30;

const PROVIDERS = Object.freeze({
    makersuite: {
        id: 'makersuite',
        label: 'Google AI Studio',
        source: 'makersuite',
        secretKey: SECRET_KEYS.MAKERSUITE,
        placeholder: 'AIza... หรือ AQ....',
        commonPrefixes: ['AIza', 'AQ.'],
    },
    openrouter: {
        id: 'openrouter',
        label: 'OpenRouter',
        source: 'openrouter',
        secretKey: SECRET_KEYS.OPENROUTER,
        placeholder: 'sk-or-v1-...',
        commonPrefixes: ['sk-or-'],
    },
});

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    autoRetry: true,
    notifications: true,
    rotateAuthErrors: true,
    rotateQuotaErrors: true,
    rotateCreditErrors: true,
    rotateServerErrors: false,
    quotaCooldownSeconds: 90,
    authCooldownMinutes: 1440,
    creditCooldownMinutes: 60,
    serverCooldownSeconds: 20,
    retryDelayMs: 400,
    selectedProvider: 'makersuite',
    keyPageSize: 10,
    cooldowns: {
        makersuite: {},
        openrouter: {},
    },
    lastEvent: null,
});

let settings;
let originalFetch = null;
let wrappedFetch = null;
let initialized = false;
let uiRoot = null;
let allowKeysExposure = null;
let exposureRefreshTimer = null;
let bulkOperationRunning = false;
let legacyConflict = false;
let keyListState = { page: 0, query: '' };
const rotationLocks = new Map();
const subscriptions = [];

function cloneDefaults() {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

function loadSettings() {
    extension_settings[EXTENSION_NAME] ??= cloneDefaults();

    const loaded = extension_settings[EXTENSION_NAME];
    settings = Object.assign(cloneDefaults(), loaded);
    settings.cooldowns = Object.assign(cloneDefaults().cooldowns, loaded.cooldowns || {});
    settings.cooldowns.makersuite = Object.assign({}, loaded.cooldowns?.makersuite || {});
    settings.cooldowns.openrouter = Object.assign({}, loaded.cooldowns?.openrouter || {});
    settings.keyPageSize = safeNumber(loaded.keyPageSize, 10, 5, 50);
    pruneCooldowns();
    persistSettings();
}

function persistSettings() {
    extension_settings[EXTENSION_NAME] = settings;
    saveSettingsDebounced();
}

function notify(type, message, force = false) {
    if (!force && !settings.notifications && type !== 'error') return false;
    const toaster = globalThis.toastr;
    if (!toaster) {
        console.info(`[${DISPLAY_NAME}] ${message}`);
        return false;
    }

    const method = typeof toaster[type] === 'function' ? type : 'info';
    // Delay by one paint so notifications triggered during fetch interception are visible.
    setTimeout(() => {
        toaster[method](message, DISPLAY_NAME, {
            timeOut: 6500,
            extendedTimeOut: 2500,
            closeButton: true,
            preventDuplicates: false,
            newestOnTop: true,
        });
    }, 40);
    return true;
}

function addLog(message, level = 'info') {
    const method = level === 'error' ? 'error' : level === 'warning' ? 'warn' : 'info';
    console[method](`[${DISPLAY_NAME}] ${message}`);
}

function providerFromSource(source) {
    return Object.values(PROVIDERS).find(provider => provider.source === source) || null;
}

function currentProvider() {
    return PROVIDERS[settings.selectedProvider] || PROVIDERS.makersuite;
}

function getSecrets(provider) {
    const value = secret_state[provider.secretKey];
    return Array.isArray(value) ? value : [];
}

function getActiveSecret(provider) {
    return getSecrets(provider).find(secret => secret.active) || null;
}

function getDisplayName(secret) {
    if (!secret) return 'ไม่พบคีย์ที่ใช้งานอยู่';
    const label = String(secret.label || '').trim();
    return label || secret.value || `Key ${String(secret.id).slice(0, 8)}`;
}

function safeNumber(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

function pruneCooldowns() {
    const now = Date.now();
    for (const providerId of Object.keys(settings.cooldowns || {})) {
        const providerCooldowns = settings.cooldowns[providerId] || {};
        for (const [id, expiry] of Object.entries(providerCooldowns)) {
            if (!Number.isFinite(Number(expiry)) || Number(expiry) <= now) {
                delete providerCooldowns[id];
            }
        }
    }
}

function cooldownRemaining(providerId, secretId) {
    const expiry = Number(settings.cooldowns?.[providerId]?.[secretId] || 0);
    return Math.max(0, expiry - Date.now());
}

function formatRemaining(milliseconds) {
    if (milliseconds <= 0) return '';
    const seconds = Math.ceil(milliseconds / 1000);
    if (seconds < 60) return `${seconds} วินาที`;
    const minutes = Math.ceil(seconds / 60);
    if (minutes < 60) return `${minutes} นาที`;
    const hours = Math.ceil(minutes / 60);
    return `${hours} ชั่วโมง`;
}

function classifyFailure(status, bodyText = '') {
    const text = String(bodyText || '').toLowerCase();

    const creditPattern = /(insufficient\s+(credits?|balance)|payment\s+required|not\s+enough\s+credits?|credit\s+limit)/i;
    const quotaPattern = /(resource_exhausted|quota|rate[\s_-]*limit|too\s+many\s+requests|requests?\s+per\s+(minute|day)|tokens?\s+per\s+(minute|day)|capacity)/i;
    const authPattern = /(unauthenticated|unauthorized|forbidden|permission[_\s-]*denied|invalid\s+(api\s*)?key|api\s*key\s*(is\s*)?not\s*valid|expired\s+(api\s*)?key|revoked\s+(api\s*)?key|authentication\s+failed)/i;

    if (status === 402 || creditPattern.test(text)) return { kind: 'credit', label: 'เครดิตไม่พอ' };
    if (status === 429 || quotaPattern.test(text)) return { kind: 'quota', label: 'โควต้าหรือ rate limit เต็ม' };
    if ([401, 403].includes(status) || authPattern.test(text)) return { kind: 'auth', label: 'คีย์ถูกปฏิเสธหรือไม่มีสิทธิ์' };
    if ([500, 502, 503, 504].includes(status)) return { kind: 'server', label: `เซิร์ฟเวอร์ขัดข้อง (${status})` };
    return { kind: 'other', label: `ข้อผิดพลาด HTTP ${status}` };
}

function isRotationEnabled(failure) {
    switch (failure.kind) {
        case 'auth': return settings.rotateAuthErrors;
        case 'quota': return settings.rotateQuotaErrors;
        case 'credit': return settings.rotateCreditErrors;
        case 'server': return settings.rotateServerErrors;
        default: return false;
    }
}

function getCooldownDuration(failure) {
    switch (failure.kind) {
        case 'auth': return safeNumber(settings.authCooldownMinutes, 1440, 1, 10080) * 60_000;
        case 'quota': return safeNumber(settings.quotaCooldownSeconds, 90, 5, 86400) * 1000;
        case 'credit': return safeNumber(settings.creditCooldownMinutes, 60, 1, 10080) * 60_000;
        case 'server': return safeNumber(settings.serverCooldownSeconds, 20, 5, 3600) * 1000;
        default: return 0;
    }
}

function markCooldown(provider, secretId, failure) {
    if (!secretId) return;
    settings.cooldowns[provider.id] ??= {};
    settings.cooldowns[provider.id][secretId] = Date.now() + getCooldownDuration(failure);
    persistSettings();
}

function clearCooldown(provider, secretId) {
    if (settings.cooldowns?.[provider.id]) {
        delete settings.cooldowns[provider.id][secretId];
        persistSettings();
    }
}

function enqueueRotation(providerId, task) {
    const previous = rotationLocks.get(providerId) || Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    let queued;
    queued = next.finally(() => {
        if (rotationLocks.get(providerId) === queued) rotationLocks.delete(providerId);
    });
    rotationLocks.set(providerId, queued);
    return queued;
}

async function secretRequest(path, body) {
    const response = await fetch(`/api/secrets/${path}`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Secret action ${path} failed: ${response.status}`);
    return response;
}

/**
 * Rotates a key without SillyTavern's built-in $('#main_api').trigger('change').
 * The server reads the active key on each request, so disconnecting the UI is unnecessary.
 */
async function rotateSecretSilently(provider, id, emitEvent = true) {
    await secretRequest('rotate', { key: provider.secretKey, id });
    await readSecretState();
    if (emitEvent) await eventSource.emit(event_types.SECRET_ROTATED, provider.secretKey);
}

async function deleteSecretSilently(provider, id) {
    await secretRequest('delete', { key: provider.secretKey, id });
}

async function rotateAfterFailure(provider, failedSecretId, failure) {
    return enqueueRotation(provider.id, async () => {
        await readSecretState();
        pruneCooldowns();

        const secrets = getSecrets(provider);
        if (secrets.length < 2) {
            addLog(`${provider.label}: ไม่มีคีย์สำรองให้สลับ`, 'warning');
            return { switched: false, reason: 'no-backup' };
        }

        const active = secrets.find(secret => secret.active) || null;
        if (failedSecretId && active && active.id !== failedSecretId) {
            return { switched: true, alreadySwitched: true, next: active };
        }

        if (failedSecretId) markCooldown(provider, failedSecretId, failure);

        const activeIndex = Math.max(0, secrets.findIndex(secret => secret.active));
        const ordered = secrets.slice(activeIndex + 1).concat(secrets.slice(0, activeIndex + 1));
        const next = ordered.find(secret => !secret.active && cooldownRemaining(provider.id, secret.id) <= 0);

        if (!next) {
            const nearest = secrets
                .map(secret => cooldownRemaining(provider.id, secret.id))
                .filter(value => value > 0)
                .sort((a, b) => a - b)[0];
            const suffix = nearest ? ` คีย์ถัดไปจะพ้นพักในประมาณ ${formatRemaining(nearest)}` : '';
            addLog(`${provider.label}: คีย์สำรองทุกอันอยู่ในช่วงพัก.${suffix}`, 'warning');
            notify('warning', `${provider.label}: ยังไม่มีคีย์สำรองที่พร้อมใช้งาน${suffix}`);
            return { switched: false, reason: 'all-cooling-down' };
        }

        await rotateSecretSilently(provider, next.id);

        settings.lastEvent = {
            provider: provider.id,
            fromId: failedSecretId || active?.id || null,
            toId: next.id,
            reason: failure.kind,
            reasonLabel: failure.label,
            time: new Date().toISOString(),
        };
        persistSettings();

        const message = `${provider.label}: สลับไปใช้ ${getDisplayName(next)} เพราะ ${failure.label}`;
        addLog(message, 'info');
        notify('info', message);
        renderAll();
        return { switched: true, next };
    });
}

async function manualRotate(provider) {
    await readSecretState();
    pruneCooldowns();
    const secrets = getSecrets(provider);
    if (secrets.length < 2) {
        notify('warning', `${provider.label} ยังไม่มีคีย์สำรอง`);
        return;
    }

    const activeIndex = Math.max(0, secrets.findIndex(secret => secret.active));
    const ordered = secrets.slice(activeIndex + 1).concat(secrets.slice(0, activeIndex + 1));
    const next = ordered.find(secret => !secret.active && cooldownRemaining(provider.id, secret.id) <= 0);
    if (!next) {
        notify('warning', 'คีย์สำรองทุกอันยังอยู่ในช่วงพัก');
        return;
    }

    await rotateSecretSilently(provider, next.id);
    notify('success', `สลับไป ${getDisplayName(next)} แล้ว`);
    renderAll();
}

function getRequestUrl(input) {
    try {
        if (typeof input === 'string') return new URL(input, location.origin);
        if (input instanceof URL) return input;
        if (input instanceof Request) return new URL(input.url, location.origin);
    } catch {
        return null;
    }
    return null;
}

function parseRequestBody(init) {
    if (!init || typeof init.body !== 'string') return null;
    try {
        return JSON.parse(init.body);
    } catch {
        return null;
    }
}

async function inspectErrorBody(response) {
    try {
        return await response.clone().text();
    } catch {
        return '';
    }
}

function wait(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function keyFlowFetch(input, init) {
    const url = getRequestUrl(input);
    const body = parseRequestBody(init);
    const provider = body ? providerFromSource(body.chat_completion_source) : null;

    if (!settings?.enabled || !url || url.pathname !== GENERATE_PATH || !provider) {
        return originalFetch(input, init);
    }

    const activeAtStart = getActiveSecret(provider);
    const response = await originalFetch(input, init);
    if (response.ok) return response;

    const errorText = await inspectErrorBody(response);
    const failure = classifyFailure(response.status, errorText);
    if (!isRotationEnabled(failure)) return response;

    const result = await rotateAfterFailure(provider, activeAtStart?.id || null, failure);
    if (!result.switched || !settings.autoRetry) return response;

    const delayMs = safeNumber(settings.retryDelayMs, 400, 0, 5000);
    if (delayMs > 0) await wait(delayMs);

    // Call the captured fetch directly so a failed retry cannot enter an infinite loop.
    return originalFetch(input, init);
}

function installFetchInterceptor() {
    if (wrappedFetch) return;
    originalFetch = window.fetch.bind(window);
    wrappedFetch = keyFlowFetch;
    Object.defineProperty(wrappedFetch, '__tmrwKeyFlow', { value: true });
    window.fetch = wrappedFetch;
}

function uninstallFetchInterceptor() {
    if (wrappedFetch && window.fetch === wrappedFetch && originalFetch) window.fetch = originalFetch;
    wrappedFetch = null;
    originalFetch = null;
}

function validateKey(provider, value) {
    const key = String(value || '').trim();
    if (!key) return { valid: false, warning: 'คีย์ว่าง' };
    const familiar = provider.commonPrefixes.some(prefix => key.startsWith(prefix));
    return {
        valid: true,
        warning: familiar ? '' : `รูปแบบไม่เหมือนคีย์ ${provider.label} ที่พบบ่อย แต่จะบันทึกให้เพราะผู้ให้บริการอาจเปลี่ยนรูปแบบได้`,
    };
}

function parseKeyLines(text, labelPrefix) {
    const lines = String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    return lines.map((line, index) => {
        const separatorIndex = line.indexOf('|');
        if (separatorIndex > 0) {
            return { label: line.slice(0, separatorIndex).trim(), value: line.slice(separatorIndex + 1).trim() };
        }
        const prefix = String(labelPrefix || '').trim();
        return { label: prefix ? `${prefix} ${index + 1}` : `${DISPLAY_NAME} ${index + 1}`, value: line };
    });
}

async function addKeysFromUi() {
    const provider = currentProvider();
    const textarea = uiRoot.querySelector('#keyflow-key-input');
    const labelInput = uiRoot.querySelector('#keyflow-label-prefix');
    const button = uiRoot.querySelector('#keyflow-add-keys');
    const entries = parseKeyLines(textarea.value, labelInput.value);

    if (!entries.length) {
        notify('warning', 'วาง API key อย่างน้อย 1 อันก่อน');
        return;
    }

    textarea.value = '';
    button.disabled = true;

    try {
        await readSecretState();
        const previousActiveId = getActiveSecret(provider)?.id || null;
        const createdIds = [];
        const warnings = [];

        for (const entry of entries) {
            const result = validateKey(provider, entry.value);
            if (!result.valid) continue;
            if (result.warning) warnings.push(result.warning);
            const id = await writeSecret(provider.secretKey, entry.value, entry.label);
            if (id) createdIds.push(id);
        }

        if (previousActiveId) await rotateSecretSilently(provider, previousActiveId);
        else if (createdIds.length > 1) await rotateSecretSilently(provider, createdIds[0]);

        await readSecretState();
        notify('success', `บันทึก ${createdIds.length} คีย์แล้ว`);
        if (warnings.length) notify('warning', warnings[0]);
        keyListState.page = 0;
        renderAll();
    } catch (error) {
        console.error(`[${DISPLAY_NAME}] Failed to add keys`, error);
        notify('error', 'บันทึกคีย์ไม่สำเร็จ ตรวจว่า SillyTavern เป็นรุ่นที่รองรับหลายคีย์', true);
    } finally {
        button.disabled = false;
    }
}

async function activateKey(provider, id) {
    await rotateSecretSilently(provider, id);
    clearCooldown(provider, id);
    notify('success', `เปลี่ยนคีย์หลักแล้ว`);
    renderAll();
}

async function removeKey(provider, id, label) {
    const confirmed = window.confirm(`ลบคีย์ “${label}” ออกจาก SillyTavern ใช่ไหม?`);
    if (!confirmed) return;
    await deleteSecretSilently(provider, id);
    clearCooldown(provider, id);
    await readSecretState();
    await eventSource.emit(event_types.SECRET_DELETED, provider.secretKey);
    notify('success', `ลบ ${label} แล้ว`);
    renderAll();
}

async function renameKey(provider, id, oldLabel) {
    const nextLabel = window.prompt('ตั้งชื่อคีย์ใหม่', oldLabel || '');
    if (!nextLabel?.trim()) return;
    await renameSecret(provider.secretKey, id, nextLabel.trim());
    renderAll();
}

async function bulkDeleteKeys(mode) {
    if (bulkOperationRunning) return;
    const provider = currentProvider();
    await readSecretState();
    const secrets = getSecrets(provider);
    if (!secrets.length) return;

    const active = secrets.find(secret => secret.active) || secrets[0];
    const targets = mode === 'keep-active'
        ? secrets.filter(secret => secret.id !== active.id)
        : secrets.slice();

    if (!targets.length) {
        notify('info', 'เหลือคีย์เดียวอยู่แล้ว');
        return;
    }

    const action = mode === 'keep-active'
        ? `เก็บ “${getDisplayName(active)}” ไว้ 1 คีย์ และลบอีก ${targets.length} คีย์`
        : `ลบ ${targets.length} คีย์ของ ${provider.label} ทั้งหมด`;
    if (!window.confirm(`${action} ใช่ไหม?\n\nการลบย้อนกลับไม่ได้`)) return;

    bulkOperationRunning = true;
    const progress = uiRoot.querySelector('#keyflow-cleanup-progress');
    const buttons = uiRoot.querySelectorAll('[data-keyflow-bulk]');
    buttons.forEach(button => { button.disabled = true; });

    try {
        for (let index = 0; index < targets.length; index++) {
            await deleteSecretSilently(provider, targets[index].id);
            if (settings.cooldowns?.[provider.id]) {
                delete settings.cooldowns[provider.id][targets[index].id];
            }
            if (progress) {
                progress.hidden = false;
                progress.textContent = `กำลังลบ ${index + 1}/${targets.length}… อย่าปิดหน้านี้`;
            }
            if ((index + 1) % 20 === 0) await wait(0);
        }

        persistSettings();
        await readSecretState();
        await eventSource.emit(event_types.SECRET_DELETED, provider.secretKey);
        keyListState.page = 0;
        notify('success', mode === 'keep-active' ? `ล้างคีย์เก่าแล้ว เหลือ 1 คีย์` : `ลบคีย์ทั้งหมดแล้ว`);
    } catch (error) {
        console.error(`[${DISPLAY_NAME}] Bulk key cleanup failed`, error);
        notify('error', 'ล้างคีย์ไม่ครบ กรุณากดรีเฟรชแล้วลองอีกครั้ง', true);
    } finally {
        bulkOperationRunning = false;
        buttons.forEach(button => { button.disabled = false; });
        if (progress) progress.hidden = true;
        renderAll();
    }
}

async function copyExposureFixCommand() {
    const command = `cd ~/SillyTavern || exit
cp config.yaml "config.yaml.backup-$(date +%Y%m%d-%H%M%S)"
sed -i -E 's/^([[:space:]]*allowKeysExposure:[[:space:]]*)true([[:space:]]*(#.*)?)$/\\1false\\2/' config.yaml
grep -n "allowKeysExposure" config.yaml
bash start.sh`;
    try {
        await navigator.clipboard.writeText(command);
        notify('success', 'คัดลอกคำสั่งแล้ว ปิด SillyTavern ใน Termux ก่อนวางคำสั่ง', true);
    } catch {
        window.prompt('คัดลอกคำสั่งนี้ไปวางใน Termux หลังปิด SillyTavern', command);
    }
}

function buildUi() {
    const container = document.querySelector('#extensions_settings2');
    if (!container || document.querySelector('#tmrw-keyflow-settings')) return null;

    const wrapper = document.createElement('div');
    wrapper.id = 'tmrw-keyflow-settings';
    wrapper.className = 'keyflow-extension inline-drawer';
    wrapper.innerHTML = `
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>${DISPLAY_NAME}</b>
            <span class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></span>
        </div>
        <div class="inline-drawer-content">
            <details id="keyflow-migration-tools" class="keyflow-warning" hidden>
                <summary><b>เครื่องมือย้ายจากส่วนเสริมเก่า</b></summary>
                <div id="keyflow-legacy-warning" class="keyflow-warning-item" hidden>
                    พบ ZerxzLib อยู่ด้วย กรุณาปิดหรือลบส่วนเสริมเดิม เพื่อไม่ให้สองส่วนเสริมสลับคีย์ชนกัน
                </div>
                <div id="keyflow-exposure-warning" class="keyflow-warning-item" hidden>
                    <div><b><code>allowKeysExposure</code> ยังเป็น <code>true</code></b><br>KeyFlow ไม่ต้องใช้ค่านี้ แนะนำให้เปลี่ยนกลับเป็น <code>false</code> แล้วรีสตาร์ต SillyTavern จากนั้นกลับมาหน้านี้ ระบบจะตรวจสอบให้อัตโนมัติ</div>
                    <button id="keyflow-copy-config-fix" type="button" class="menu_button">คัดลอกคำสั่ง Termux</button>
                </div>
                <div id="keyflow-overflow-warning" class="keyflow-warning-item" hidden>
                    <div id="keyflow-overflow-text"></div>
                    <div class="keyflow-actions-inline">
                        <button type="button" class="menu_button" data-keyflow-bulk="keep-active">เก็บคีย์ที่ใช้อยู่ 1 อัน</button>
                        <button type="button" class="menu_button keyflow-danger" data-keyflow-bulk="delete-all">ลบทั้งหมด</button>
                    </div>
                    <div id="keyflow-cleanup-progress" class="keyflow-progress" hidden></div>
                </div>
            </details>

            <div class="keyflow-summary-grid">
                <div class="keyflow-summary">
                    <span>สถานะ</span>
                    <strong id="keyflow-status">กำลังโหลด…</strong>
                </div>
                <div class="keyflow-summary">
                    <span>คีย์ที่ใช้อยู่</span>
                    <strong id="keyflow-active">—</strong>
                </div>
            </div>

            <label class="checkbox_label keyflow-switch-row" for="keyflow-enabled">
                <input id="keyflow-enabled" type="checkbox">
                <span>เปิด Smart Failover (คงคีย์เดิมไว้จนกว่าจะเกิดข้อผิดพลาด)</span>
            </label>

            <div class="keyflow-section">
                <label for="keyflow-provider"><b>ผู้ให้บริการ</b></label>
                <select id="keyflow-provider" class="text_pole">
                    <option value="makersuite">Google AI Studio</option>
                    <option value="openrouter">OpenRouter</option>
                </select>
            </div>

            <details class="keyflow-section">
                <summary><b>เพิ่ม API key</b></summary>
                <div class="keyflow-add-box">
                    <input id="keyflow-label-prefix" class="text_pole" type="text" placeholder="ชื่อชุด เช่น Google สำรอง (ไม่บังคับ)">
                    <textarea id="keyflow-key-input" class="text_pole" rows="4" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>
                    <div class="keyflow-muted">ใส่ 1 คีย์ต่อ 1 บรรทัด หรือใช้รูปแบบ <code>ชื่อ | คีย์</code> รองรับ <code>AIza…</code>, <code>AQ.…</code> และ <code>sk-or-…</code></div>
                    <button id="keyflow-add-keys" type="button" class="menu_button">เพิ่มคีย์</button>
                </div>
            </details>

            <details id="keyflow-key-manager" class="keyflow-section">
                <summary><b>จัดการคีย์ <span id="keyflow-key-count"></span></b></summary>
                <div class="keyflow-heading-row">
                    <input id="keyflow-key-search" class="text_pole keyflow-search" type="search" placeholder="ค้นหาชื่อคีย์">
                    <div class="keyflow-actions-inline">
                        <button id="keyflow-refresh" type="button" class="menu_button menu_button_icon" title="รีเฟรช"><i class="fa-solid fa-rotate"></i></button>
                        <button id="keyflow-next" type="button" class="menu_button">สลับคีย์ถัดไป</button>
                    </div>
                </div>
                <div id="keyflow-key-list" class="keyflow-key-list"></div>
                <div id="keyflow-pagination" class="keyflow-pagination">
                    <button id="keyflow-prev-page" type="button" class="menu_button">ก่อนหน้า</button>
                    <span id="keyflow-page-label"></span>
                    <button id="keyflow-next-page" type="button" class="menu_button">ถัดไป</button>
                    <label>แสดง
                        <select id="keyflow-page-size" class="text_pole">
                            <option value="5">5</option>
                            <option value="10">10</option>
                            <option value="20">20</option>
                            <option value="50">50</option>
                        </select>
                    </label>
                </div>
            </details>

            <details class="keyflow-section">
                <summary><b>ตั้งค่าการสลับอัตโนมัติ</b></summary>
                <div class="keyflow-options">
                    <label class="checkbox_label" for="keyflow-auto-retry"><input id="keyflow-auto-retry" type="checkbox"><span>ลองส่งข้อความเดิมใหม่ 1 ครั้งหลังสลับคีย์</span></label>
                    <label class="checkbox_label" for="keyflow-notifications"><input id="keyflow-notifications" type="checkbox"><span>แจ้งเตือนเมื่อสลับคีย์</span></label>
                    <label class="checkbox_label" for="keyflow-auth"><input id="keyflow-auth" type="checkbox"><span>สลับเมื่อคีย์ถูกปฏิเสธ (401/403/invalid key)</span></label>
                    <label class="checkbox_label" for="keyflow-quota"><input id="keyflow-quota" type="checkbox"><span>สลับเมื่อโควต้าหรือ rate limit เต็ม (429/quota)</span></label>
                    <label class="checkbox_label" for="keyflow-credit"><input id="keyflow-credit" type="checkbox"><span>สลับเมื่อเครดิต OpenRouter ไม่พอ (402)</span></label>
                    <label class="checkbox_label" for="keyflow-server"><input id="keyflow-server" type="checkbox"><span>สลับเมื่อผู้ให้บริการล่มชั่วคราว (5xx)</span></label>
                </div>
                <div class="keyflow-number-grid">
                    <label>พักคีย์เมื่อ 429 (วินาที)<input id="keyflow-quota-cooldown" class="text_pole" type="number" min="5" max="86400"></label>
                    <label>พักคีย์เมื่อ auth fail (นาที)<input id="keyflow-auth-cooldown" class="text_pole" type="number" min="1" max="10080"></label>
                    <label>พักคีย์เมื่อเครดิตหมด (นาที)<input id="keyflow-credit-cooldown" class="text_pole" type="number" min="1" max="10080"></label>
                    <label>หน่วงก่อนลองใหม่ (ms)<input id="keyflow-retry-delay" class="text_pole" type="number" min="0" max="5000"></label>
                </div>
            </details>
        </div>
    `;
    container.appendChild(wrapper);
    return wrapper;
}

function bindSetting(id, key, parser = value => value) {
    const element = uiRoot.querySelector(id);
    if (!element) return;
    const eventName = element.type === 'checkbox' ? 'change' : 'input';
    element.addEventListener(eventName, () => {
        settings[key] = parser(element.type === 'checkbox' ? element.checked : element.value);
        persistSettings();
        renderSummary();
    });
}

function bindUi() {
    uiRoot.querySelector('#keyflow-provider').addEventListener('change', event => {
        settings.selectedProvider = event.target.value;
        keyListState = { page: 0, query: '' };
        persistSettings();
        renderAll();
    });
    uiRoot.querySelector('#keyflow-add-keys').addEventListener('click', addKeysFromUi);
    uiRoot.querySelector('#keyflow-refresh').addEventListener('click', async () => {
        await refreshState();
        renderAll();
    });
    uiRoot.querySelector('#keyflow-next').addEventListener('click', () => manualRotate(currentProvider()));
    uiRoot.querySelector('#keyflow-copy-config-fix').addEventListener('click', copyExposureFixCommand);

    uiRoot.querySelectorAll('[data-keyflow-bulk]').forEach(button => {
        button.addEventListener('click', () => bulkDeleteKeys(button.dataset.keyflowBulk));
    });

    uiRoot.querySelector('#keyflow-key-search').addEventListener('input', event => {
        keyListState.query = event.target.value;
        keyListState.page = 0;
        renderKeyList();
    });
    uiRoot.querySelector('#keyflow-page-size').addEventListener('change', event => {
        settings.keyPageSize = safeNumber(event.target.value, 10, 5, 50);
        keyListState.page = 0;
        persistSettings();
        renderKeyList();
    });
    uiRoot.querySelector('#keyflow-prev-page').addEventListener('click', () => {
        keyListState.page = Math.max(0, keyListState.page - 1);
        renderKeyList();
    });
    uiRoot.querySelector('#keyflow-next-page').addEventListener('click', () => {
        keyListState.page += 1;
        renderKeyList();
    });

    bindSetting('#keyflow-enabled', 'enabled', Boolean);
    bindSetting('#keyflow-auto-retry', 'autoRetry', Boolean);
    bindSetting('#keyflow-notifications', 'notifications', Boolean);
    bindSetting('#keyflow-auth', 'rotateAuthErrors', Boolean);
    bindSetting('#keyflow-quota', 'rotateQuotaErrors', Boolean);
    bindSetting('#keyflow-credit', 'rotateCreditErrors', Boolean);
    bindSetting('#keyflow-server', 'rotateServerErrors', Boolean);
    bindSetting('#keyflow-quota-cooldown', 'quotaCooldownSeconds', value => safeNumber(value, 90, 5, 86400));
    bindSetting('#keyflow-auth-cooldown', 'authCooldownMinutes', value => safeNumber(value, 1440, 1, 10080));
    bindSetting('#keyflow-credit-cooldown', 'creditCooldownMinutes', value => safeNumber(value, 60, 1, 10080));
    bindSetting('#keyflow-retry-delay', 'retryDelayMs', value => safeNumber(value, 400, 0, 5000));
}

function populateSettingsControls() {
    const values = {
        '#keyflow-enabled': settings.enabled,
        '#keyflow-auto-retry': settings.autoRetry,
        '#keyflow-notifications': settings.notifications,
        '#keyflow-auth': settings.rotateAuthErrors,
        '#keyflow-quota': settings.rotateQuotaErrors,
        '#keyflow-credit': settings.rotateCreditErrors,
        '#keyflow-server': settings.rotateServerErrors,
        '#keyflow-quota-cooldown': settings.quotaCooldownSeconds,
        '#keyflow-auth-cooldown': settings.authCooldownMinutes,
        '#keyflow-credit-cooldown': settings.creditCooldownMinutes,
        '#keyflow-retry-delay': settings.retryDelayMs,
        '#keyflow-provider': settings.selectedProvider,
        '#keyflow-page-size': settings.keyPageSize,
    };
    for (const [selector, value] of Object.entries(values)) {
        const element = uiRoot.querySelector(selector);
        if (!element) continue;
        if (element.type === 'checkbox') element.checked = Boolean(value);
        else element.value = value;
    }
}

function renderSummary() {
    if (!uiRoot) return;
    const provider = currentProvider();
    const secrets = getSecrets(provider);
    const active = secrets.find(secret => secret.active) || null;
    const status = uiRoot.querySelector('#keyflow-status');

    if (legacyConflict) {
        status.textContent = 'พักการทำงาน · พบส่วนเสริมเก่า';
    } else {
        status.textContent = settings.enabled ? `เปิด · ${provider.label} · ${secrets.length} คีย์` : 'ปิด';
    }
    status.classList.toggle('keyflow-good', settings.enabled && !legacyConflict);
    uiRoot.querySelector('#keyflow-active').textContent = getDisplayName(active);
    uiRoot.querySelector('#keyflow-key-input').placeholder = `${provider.placeholder}\n${provider.placeholder}`;
    uiRoot.querySelector('#keyflow-key-count').textContent = `(${secrets.length})`;
}

function makeButton(text, className, handler, title = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = text;
    if (title) button.title = title;
    button.addEventListener('click', handler);
    return button;
}

function renderKeyList() {
    if (!uiRoot) return;
    pruneCooldowns();
    const provider = currentProvider();
    const list = uiRoot.querySelector('#keyflow-key-list');
    const pagination = uiRoot.querySelector('#keyflow-pagination');
    list.replaceChildren();

    const secrets = getSecrets(provider);
    const query = keyListState.query.trim().toLowerCase();
    const filtered = secrets.filter(secret => {
        if (!query) return true;
        return `${getDisplayName(secret)} ${secret.value || ''}`.toLowerCase().includes(query);
    });

    if (!filtered.length) {
        const empty = document.createElement('div');
        empty.className = 'keyflow-empty';
        empty.textContent = secrets.length
            ? 'ไม่พบคีย์ที่ตรงกับคำค้นหา'
            : `ยังไม่มี ${provider.label} key — เปิดหัวข้อ “เพิ่ม API key” เพื่อเพิ่มคีย์`;
        list.appendChild(empty);
        pagination.hidden = true;
        return;
    }

    const pageSize = safeNumber(settings.keyPageSize, 10, 5, 50);
    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
    keyListState.page = Math.min(keyListState.page, totalPages - 1);
    const start = keyListState.page * pageSize;
    const pageItems = filtered.slice(start, start + pageSize);

    for (const secret of pageItems) {
        const row = document.createElement('div');
        row.className = `keyflow-key-row${secret.active ? ' is-active' : ''}`;

        const meta = document.createElement('div');
        meta.className = 'keyflow-key-meta';
        const title = document.createElement('div');
        title.className = 'keyflow-key-title';
        title.textContent = getDisplayName(secret);

        if (secret.active) {
            const badge = document.createElement('span');
            badge.className = 'keyflow-badge';
            badge.textContent = 'กำลังใช้';
            title.appendChild(badge);
        }

        const masked = document.createElement('div');
        masked.className = 'keyflow-muted keyflow-masked';
        masked.textContent = secret.value || `ID: ${secret.id.slice(0, 8)}…`;
        meta.append(title, masked);

        const remaining = cooldownRemaining(provider.id, secret.id);
        if (remaining > 0) {
            const cooldown = document.createElement('div');
            cooldown.className = 'keyflow-cooldown';
            cooldown.textContent = `พักอีกประมาณ ${formatRemaining(remaining)}`;
            meta.appendChild(cooldown);
        }

        const actions = document.createElement('div');
        actions.className = 'keyflow-row-actions';
        if (!secret.active) actions.appendChild(makeButton('ใช้', 'menu_button', () => activateKey(provider, secret.id), 'ใช้คีย์นี้'));
        if (remaining > 0) actions.appendChild(makeButton('ยกเลิกพัก', 'menu_button', () => {
            clearCooldown(provider, secret.id);
            renderAll();
        }));
        actions.appendChild(makeButton('เปลี่ยนชื่อ', 'menu_button', () => renameKey(provider, secret.id, secret.label)));
        actions.appendChild(makeButton('ลบ', 'menu_button keyflow-danger', () => removeKey(provider, secret.id, getDisplayName(secret))));

        row.append(meta, actions);
        list.appendChild(row);
    }

    pagination.hidden = filtered.length <= pageSize;
    uiRoot.querySelector('#keyflow-page-label').textContent = `หน้า ${keyListState.page + 1}/${totalPages}`;
    uiRoot.querySelector('#keyflow-prev-page').disabled = keyListState.page <= 0;
    uiRoot.querySelector('#keyflow-next-page').disabled = keyListState.page >= totalPages - 1;
}

function detectLegacyExtension() {
    return Boolean(
        document.querySelector('gemini-layouts') ||
        document.querySelector('#api_key_makersuite_custom') ||
        [...document.querySelectorAll('.inline-drawer-header')].some(element => /zerxzlib/i.test(element.textContent || ''))
    );
}

function renderMigrationTools() {
    if (!uiRoot) return;
    const provider = currentProvider();
    const count = getSecrets(provider).length;
    const legacyFound = detectLegacyExtension();
    legacyConflict = legacyFound;
    const exposureFound = allowKeysExposure === true;
    const overflowFound = count >= LARGE_KEY_COUNT;
    const panel = uiRoot.querySelector('#keyflow-migration-tools');

    uiRoot.querySelector('#keyflow-legacy-warning').hidden = !legacyFound;
    uiRoot.querySelector('#keyflow-exposure-warning').hidden = !exposureFound;
    uiRoot.querySelector('#keyflow-overflow-warning').hidden = !overflowFound;
    uiRoot.querySelector('#keyflow-overflow-text').innerHTML = overflowFound
        ? `<b>พบ ${count} คีย์ของ ${provider.label}</b><br>อาจเป็นรายการซ้ำที่เกิดจาก ZerxzLib รุ่นเก่า คุณสามารถเก็บคีย์ที่กำลังใช้อยู่ไว้เพียงอันเดียวได้ในครั้งเดียว`
        : '';

    panel.hidden = !(legacyFound || exposureFound || overflowFound);
    if (!panel.hidden && !panel.dataset.autoOpened) {
        panel.open = overflowFound || exposureFound;
        panel.dataset.autoOpened = 'true';
    }
}

function renderAll() {
    if (!uiRoot) return;
    populateSettingsControls();
    renderMigrationTools();
    renderSummary();
    renderKeyList();
}

function subscribe(eventName, handler) {
    if (!eventName) return;
    eventSource.on(eventName, handler);
    subscriptions.push([eventName, handler]);
}

async function refreshExposureSetting() {
    try {
        const value = await canViewSecrets();
        if (typeof value !== 'boolean') return;
        const changed = allowKeysExposure !== value;
        allowKeysExposure = value;
        if (changed) renderMigrationTools();
    } catch {
        // Keep the previous value if the server is still restarting.
    }
}

function scheduleExposureRefresh() {
    clearTimeout(exposureRefreshTimer);
    exposureRefreshTimer = setTimeout(refreshExposureSetting, 1200);
}

function handleVisibilityChange() {
    if (document.visibilityState === 'visible') scheduleExposureRefresh();
}

async function refreshState() {
    await readSecretState();
    pruneCooldowns();
    await refreshExposureSetting();
}

async function refreshFromSecretEvent() {
    await readSecretState();
    renderAll();
}

export async function onActivate() {
    await initialize();
}

export function onDisable() {
    uninstallFetchInterceptor();
    clearTimeout(exposureRefreshTimer);
    exposureRefreshTimer = null;
    window.removeEventListener('focus', scheduleExposureRefresh);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    for (const [eventName, handler] of subscriptions.splice(0)) {
        eventSource.removeListener?.(eventName, handler);
    }
    uiRoot?.remove();
    uiRoot = null;
    initialized = false;
}

async function initialize() {
    if (initialized) return;
    initialized = true;
    loadSettings();

    try {
        await refreshState();
    } catch (error) {
        console.error(`[${DISPLAY_NAME}] Secret manager is unavailable`, error);
    }

    uiRoot = buildUi();
    if (!uiRoot) {
        initialized = false;
        return;
    }

    bindUi();
    renderAll();
    window.addEventListener('focus', scheduleExposureRefresh);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    if (!legacyConflict) {
        installFetchInterceptor();
    } else {
        notify('warning', 'พบส่วนเสริมสลับคีย์รุ่นเก่า จึงพัก KeyFlow ไว้ก่อน กรุณาปิดตัวเก่าแล้วรีโหลดหน้า', true);
    }

    subscribe(event_types.SECRET_WRITTEN, refreshFromSecretEvent);
    subscribe(event_types.SECRET_ROTATED, refreshFromSecretEvent);
    subscribe(event_types.SECRET_DELETED, refreshFromSecretEvent);
    subscribe(event_types.SECRET_EDITED, refreshFromSecretEvent);
}

if (document.readyState === 'loading') subscribe(event_types.APP_READY, initialize);
else queueMicrotask(initialize);
