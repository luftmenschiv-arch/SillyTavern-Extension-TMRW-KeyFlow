import {
    eventSource,
    event_types,
    getRequestHeaders,
    saveSettingsDebounced,
} from '../../../../script.js';
import { extension_settings, extensionNames } from '../../../extensions.js';
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
const EXTENSION_VERSION = '1.3.4';
const GENERATE_PATH = '/api/backends/chat-completions/generate';
const LARGE_KEY_COUNT = 30;
const MAX_DIAGNOSTICS = 2;
const MAX_ERROR_DETAIL_LENGTH = 360;

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
    followChatCompletionSource: true,
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
    diagnostics: [],
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
let diagnosticTestToken = null;
let diagnosticTestRunning = false;
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
    settings.diagnostics = Array.isArray(loaded.diagnostics) ? loaded.diagnostics.slice(0, MAX_DIAGNOSTICS) : [];
    pruneCooldowns();
    persistSettings();
}

function persistSettings() {
    extension_settings[EXTENSION_NAME] = settings;
    saveSettingsDebounced();
}

function getToastContainer() {
    let container = document.querySelector('#tmrw-keyflow-toast-container');
    if (container) return container;

    container = document.createElement('div');
    container.id = 'tmrw-keyflow-toast-container';
    container.className = 'keyflow-toast-container';
    container.setAttribute('aria-live', 'polite');
    container.setAttribute('aria-atomic', 'false');
    document.body.appendChild(container);
    return container;
}

function showKeyFlowToast(type, message) {
    const container = getToastContainer();
    const toast = document.createElement('div');
    toast.className = `keyflow-toast is-${['success', 'warning', 'error'].includes(type) ? type : 'info'}`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');

    const content = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = DISPLAY_NAME;
    const body = document.createElement('div');
    body.textContent = message;
    content.append(title, body);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'keyflow-toast-close';
    close.setAttribute('aria-label', 'ปิดการแจ้งเตือน');
    close.textContent = '×';

    const remove = () => {
        toast.classList.add('is-leaving');
        setTimeout(() => toast.remove(), 180);
    };
    close.addEventListener('click', remove);
    toast.append(content, close);
    container.prepend(toast);

    while (container.children.length > 3) container.lastElementChild?.remove();
    setTimeout(remove, 6500);
}

function notify(type, message, force = false) {
    if (!force && !settings.notifications && type !== 'error') return false;
    console.info(`[${DISPLAY_NAME}] ${message}`);
    setTimeout(() => showKeyFlowToast(type, message), 60);
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

function getCurrentChatCompletionSource() {
    return String(document.querySelector('#chat_completion_source')?.value || '');
}

function syncProviderFromChatCompletionSource(source, showNotification = false) {
    if (!settings?.followChatCompletionSource) return false;
    const provider = providerFromSource(String(source || ''));
    if (!provider || settings.selectedProvider === provider.id) return false;

    settings.selectedProvider = provider.id;
    keyListState = { page: 0, query: '' };
    persistSettings();
    renderAll();

    if (showNotification) {
        notify('info', `เปลี่ยนผู้ให้บริการเป็น ${provider.label} ตามแหล่งที่มาของ Chat Completion`);
    }
    return true;
}

function handleChatCompletionSourceChanged(source) {
    syncProviderFromChatCompletionSource(source, true);
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
    const contextPattern = /(context\s*(length|window)|maximum\s+context|too\s+many\s+tokens|token\s+limit|prompt\s+is\s+too\s+long|input\s+too\s+long)/i;
    const safetyPattern = /(safety|blocked|prohibited|content\s+filter|policy\s+violation|finish[_\s-]*reason.{0,20}safety)/i;
    const modelPattern = /(model\s+(not\s+found|does\s+not\s+exist|is\s+not\s+available)|unknown\s+model|unsupported\s+model|endpoint\s+not\s+found)/i;
    const timeoutPattern = /(timeout|timed\s*out|deadline\s+exceeded|gateway\s+timeout)/i;
    const retryPattern = /(max(?:imum)?\s+retries|retries\s+(reached|exceeded))/i;

    // Preserve v1.2.2 rotation behavior exactly. Detailed diagnostic codes below
    // do not change whether KeyFlow rotates a key.
    let kind = 'other';
    if (status === 402 || creditPattern.test(text)) kind = 'credit';
    else if (status === 429 || quotaPattern.test(text)) kind = 'quota';
    else if ([401, 403].includes(status) || authPattern.test(text)) kind = 'auth';
    else if ([500, 502, 503, 504].includes(status)) kind = 'server';

    if (retryPattern.test(text)) return { kind, code: 'max-retries', label: 'SillyTavern ลองซ้ำครบจำนวนแล้ว' };
    if (kind === 'credit') return { kind, code: 'credit', label: 'เครดิตไม่พอ' };
    if (kind === 'quota') return { kind, code: 'quota', label: 'โควต้าหรือ rate limit เต็ม' };
    if (kind === 'auth') return { kind, code: status === 403 ? 'permission' : 'auth', label: 'คีย์ถูกปฏิเสธหรือไม่มีสิทธิ์' };
    if (contextPattern.test(text) || status === 413) return { kind, code: 'context', label: 'ข้อความหรือบริบทยาวเกินขีดจำกัด' };
    if (safetyPattern.test(text)) return { kind, code: 'safety', label: 'คำขอถูกระบบความปลอดภัยปฏิเสธ' };
    if (modelPattern.test(text) || status === 404) return { kind, code: 'model', label: 'ไม่พบโมเดลหรือปลายทาง API' };
    if (status === 408) return { kind, code: 'timeout', label: 'คำขอหมดเวลา' };
    if (status === 502) return { kind, code: 'gateway', label: 'Gateway หรือ Reverse Proxy ติดต่อ API ไม่สำเร็จ' };
    if (status === 503) return { kind, code: 'unavailable', label: 'เซิร์ฟเวอร์ผู้ให้บริการไม่พร้อมใช้งาน' };
    if (status === 504) return { kind, code: 'timeout', label: 'Gateway หรือผู้ให้บริการตอบช้าเกินเวลา' };
    if (timeoutPattern.test(text)) return { kind, code: 'timeout', label: 'คำขอหรือการเชื่อมต่อหมดเวลา' };
    if (status === 529) return { kind, code: 'overloaded', label: 'ผู้ให้บริการมีผู้ใช้งานหนาแน่นเกินไป' };
    if (status >= 500) return { kind, code: 'server', label: `เซิร์ฟเวอร์ขัดข้อง (${status})` };
    return { kind, code: 'http', label: `ข้อผิดพลาด HTTP ${status}` };
}

function classifyThrownError(error) {
    const name = String(error?.name || 'Error');
    const message = String(error?.message || error || 'Unknown error');
    const text = `${name} ${message}`.toLowerCase();

    if (/aborterror|aborted|operation was aborted/.test(text)) {
        return { kind: 'other', code: 'aborted', label: 'คำขอถูกยกเลิกก่อนเสร็จ' };
    }
    if (/max(?:imum)?\s+retries|retries\s+(reached|exceeded)/.test(text)) {
        return { kind: 'other', code: 'max-retries', label: 'SillyTavern ลองซ้ำครบจำนวนแล้ว' };
    }
    if (/timeout|timed\s*out|deadline\s+exceeded/.test(text)) {
        return { kind: 'other', code: 'timeout', label: 'การเชื่อมต่อหมดเวลาโดยไม่มี HTTP status' };
    }
    if (/connection\s*(closed|reset|terminated)|socket\s+hang\s+up|premature\s+close|econnreset|broken\s+pipe/.test(text)) {
        return { kind: 'other', code: 'connection-closed', label: 'การเชื่อมต่อถูกตัดกลางทาง' };
    }
    if (/failed\s+to\s+fetch|networkerror|network\s+request\s+failed|load\s+failed|internet\s+disconnected|offline/.test(text)) {
        return { kind: 'other', code: 'network', label: 'เครือข่ายหรือเว็บโฮสต์เชื่อมต่อ API ไม่สำเร็จ' };
    }
    return { kind: 'other', code: 'client', label: 'เกิดข้อผิดพลาดก่อนรับ HTTP response' };
}

function redactSensitiveText(value) {
    let text = String(value || '');
    const replacements = [
        [/AIza[A-Za-z0-9_-]{15,}/g, '[REDACTED_GOOGLE_KEY]'],
        [/AQ\.[A-Za-z0-9._-]{10,}/g, '[REDACTED_GOOGLE_AUTH_KEY]'],
        [/sk-or-v1-[A-Za-z0-9_-]{10,}/gi, '[REDACTED_OPENROUTER_KEY]'],
        [/\bsk-[A-Za-z0-9_-]{15,}\b/g, '[REDACTED_API_KEY]'],
        [/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED_TOKEN]'],
        [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]'],
        [/((?:api[_-]?key|token|password|secret|cookie|authorization|prompt|messages?|content|request[_-]?body)\s*[=:]\s*)[^\s,;"']+/gi, '$1[REDACTED]'],
        [/([?&](?:key|api_key|token|access_token|auth|signature|prompt|message|content)=)[^&#\s]+/gi, '$1[REDACTED]'],
        [/("|').{120,}?\1/g, '[REDACTED_LONG_TEXT]'],
    ];
    for (const [pattern, replacement] of replacements) text = text.replace(pattern, replacement);
    return text;
}

function collapseDiagnosticText(value, maxLength = MAX_ERROR_DETAIL_LENGTH) {
    const text = redactSensitiveText(value)
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!text) return '';
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function extractSafeErrorDetail(bodyText, statusText = '') {
    const raw = String(bodyText || '').slice(0, 32_000);
    const candidates = [];
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            candidates.push(
                parsed?.error?.message,
                parsed?.error?.status,
                parsed?.error?.code,
                parsed?.error?.type,
                parsed?.message,
                parsed?.detail,
                parsed?.type,
            );
        } catch {
            // Plain-text/HTML bodies are intentionally omitted because a custom
            // proxy can echo user content. The HTTP status is still recorded.
        }
    }
    candidates.push(statusText);
    const detail = collapseDiagnosticText(candidates.filter(Boolean).join(' · '));
    const generic = !detail || /^(error|unknown error|internal server error|something went wrong|request failed|bad gateway|service unavailable)$/i.test(detail);
    return {
        detail: generic ? '' : detail,
        visibility: generic ? 'generic' : 'detailed',
    };
}

function getDeviceSummary() {
    const ua = String(navigator.userAgent || '');
    let device = 'Desktop';
    let system = 'Unknown OS';
    let browser = 'Unknown browser';

    if (/iPhone/i.test(ua)) device = 'iPhone';
    else if (/iPad/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) device = 'iPad';
    else if (/Android/i.test(ua)) device = 'Android device';
    else if (/Windows/i.test(ua)) device = 'PC';
    else if (/Macintosh|Mac OS X/i.test(ua)) device = 'Mac';
    else if (/Linux/i.test(ua)) device = 'Linux device';

    if (/iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) system = 'iOS/iPadOS';
    else if (/Android/i.test(ua)) system = 'Android';
    else if (/Windows NT/i.test(ua)) system = 'Windows';
    else if (/Mac OS X|Macintosh/i.test(ua)) system = 'macOS';
    else if (/Linux/i.test(ua)) system = 'Linux';

    if (/Edg\//i.test(ua)) browser = 'Edge';
    else if (/CriOS\//i.test(ua)) browser = 'Chrome';
    else if (/FxiOS\//i.test(ua)) browser = 'Firefox';
    else if (/OPR\//i.test(ua)) browser = 'Opera';
    else if (/Chrome\//i.test(ua)) browser = 'Chrome';
    else if (/Firefox\//i.test(ua)) browser = 'Firefox';
    else if (/Safari\//i.test(ua)) browser = 'Safari';

    return `${device} / ${system} / ${browser}`;
}

function createRequestId() {
    const now = new Date();
    const stamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const random = globalThis.crypto?.randomUUID?.().slice(0, 8) || Math.random().toString(36).slice(2, 10);
    return `KF-${stamp}-${random}`;
}

function diagnosticKeyLabel(secret) {
    if (!secret) return 'Unknown key';
    const label = String(secret.label || '').trim();
    if (label) return collapseDiagnosticText(label, 120);
    const masked = String(secret.value || '');
    const visibleEnd = masked.slice(-3).replace(/[^A-Za-z0-9]/g, '');
    return visibleEnd ? `Key ending ${visibleEnd}` : `Key ${String(secret.id || '').slice(0, 8) || 'unknown'}`;
}

function createDiagnosticRecord({ provider, body, activeSecret, requestType = 'chat', requestId = null, startedAt = Date.now() }) {
    return {
        id: requestId || createRequestId(),
        createdAt: new Date(startedAt).toISOString(),
        completedAt: null,
        requestType,
        provider: provider.id,
        providerLabel: provider.label,
        model: collapseDiagnosticText(body?.model || '', 120) || 'Unknown model',
        device: getDeviceSummary(),
        initial: null,
        rotation: {
            attempted: false,
            success: false,
            reason: 'not-needed',
            from: diagnosticKeyLabel(activeSecret),
            to: null,
        },
        retry: null,
        final: null,
        elapsedMs: 0,
        visibilityNote: '',
        maxRetriesDetected: false,
        notes: [],
    };
}

function makeHttpDiagnostic(response, failure, safeDetail) {
    const providerRequestId = collapseDiagnosticText(
        response.headers.get('x-request-id')
        || response.headers.get('request-id')
        || response.headers.get('x-goog-request-id')
        || response.headers.get('cf-ray')
        || '',
        120,
    );
    return {
        type: 'http',
        status: Number(response.status),
        statusText: collapseDiagnosticText(response.statusText || '', 100),
        causeCode: failure.code || failure.kind,
        cause: failure.label,
        detail: safeDetail.detail,
        providerRequestId,
    };
}

function makeNetworkDiagnostic(error, failure) {
    return {
        type: 'network',
        status: null,
        statusText: '',
        causeCode: failure.code || 'network',
        cause: failure.label,
        detail: collapseDiagnosticText(error?.message || error || '', MAX_ERROR_DETAIL_LENGTH),
    };
}

function finalizeDiagnostic(record, finalState, startedAt) {
    record.completedAt = new Date().toISOString();
    record.elapsedMs = Math.max(0, Date.now() - startedAt);
    record.final = finalState;
    return record;
}

function isDiagnosticProblem(result) {
    if (!result) return false;
    if (result.causeCode === 'success') return false;
    if (result.type === 'http') return Number(result.status || 0) >= 400 || result.causeCode !== 'success';
    return ['network', 'preflight'].includes(result.type) || Boolean(result.causeCode);
}

function isProblemRecord(record) {
    return Boolean(
        isDiagnosticProblem(record?.initial)
        || isDiagnosticProblem(record?.retry)
        || isDiagnosticProblem(record?.final)
        || record?.maxRetriesDetected
    );
}

function persistDiagnostic(record) {
    const safe = JSON.parse(JSON.stringify(record));
    const existing = (settings.diagnostics || []).filter(item => item.id !== safe.id);

    // Keep the panel focused: successful connection tests are announced by toast,
    // but only requests that actually had a problem remain in diagnostic history.
    settings.diagnostics = isProblemRecord(safe)
        ? [safe, ...existing].slice(0, MAX_DIAGNOSTICS)
        : existing.slice(0, MAX_DIAGNOSTICS);
    persistSettings();
    renderDiagnostics();
}

function updateDiagnostic(requestId, mutator) {
    const index = (settings.diagnostics || []).findIndex(item => item.id === requestId);
    if (index < 0) return false;
    const next = JSON.parse(JSON.stringify(settings.diagnostics[index]));
    mutator(next);
    settings.diagnostics[index] = next;
    persistSettings();
    renderDiagnostics();
    return true;
}

function getRotationReasonLabel(reason) {
    const labels = {
        'not-needed': 'ไม่จำเป็นต้องสลับ',
        'disabled': 'ปิดการสลับสำหรับข้อผิดพลาดประเภทนี้',
        'auto-retry-disabled': 'สลับคีย์แล้ว แต่ปิดการ Retry อัตโนมัติ',
        'no-backup': 'ไม่มีคีย์สำรอง',
        'all-cooling-down': 'คีย์สำรองทุกอันอยู่ใน Cooldown',
        'already-switched': 'คำขออื่นสลับคีย์ไปก่อนแล้ว',
        'rotate-failed': 'สลับคีย์ไม่สำเร็จ',
        'success': 'สลับคีย์สำเร็จ',
    };
    return labels[reason] || reason || 'Unknown';
}

function diagnosticOutcomeLabel(result) {
    if (!result) return 'Not sent';
    if (result.type === 'http') return `HTTP ${result.status}`;
    if (result.type === 'network') return 'No HTTP status / Network error';
    if (result.type === 'preflight') return 'Not sent';
    return result.type || 'Unknown';
}

function diagnosticOutcomeLabelTh(result) {
    if (!result) return 'ไม่ได้ส่งคำขอ';
    if (result.type === 'http') return `HTTP ${result.status}`;
    if (result.type === 'network') return 'ไม่มี HTTP status / ปัญหาเครือข่าย';
    if (result.type === 'preflight') return 'ยังไม่ได้ส่งคำขอ';
    return result.type || 'ไม่ทราบผล';
}

function getRotationReasonEnglish(reason) {
    const labels = {
        'not-needed': 'rotation was not needed',
        'disabled': 'rotation is disabled for this error type',
        'auto-retry-disabled': 'automatic retry is disabled',
        'no-backup': 'no backup key is available',
        'all-cooling-down': 'all backup keys are in cooldown',
        'already-switched': 'another request already rotated the key',
        'rotate-failed': 'key rotation failed',
        'success': 'key rotation succeeded',
    };
    return labels[reason] || reason || 'unknown reason';
}

function causeEnglish(code, fallback) {
    const labels = {
        auth: 'Invalid or rejected API key',
        permission: 'Permission denied',
        quota: 'Quota or rate limit',
        credit: 'Insufficient provider credits',
        context: 'Context or token limit exceeded',
        safety: 'Safety or content policy rejection',
        model: 'Model or API endpoint not found',
        timeout: 'Request or gateway timeout',
        gateway: 'Gateway or reverse proxy failure',
        unavailable: 'Provider server unavailable',
        overloaded: 'Provider overloaded',
        server: 'Provider or server error',
        network: 'Network or hosting connection failure',
        'connection-closed': 'Connection closed before completion',
        'max-retries': 'Maximum retries reached',
        aborted: 'Request was aborted',
        client: 'Error before an HTTP response was received',
        http: 'HTTP request failed',
        success: 'Request completed successfully',
        'unsupported-provider': 'Unsupported Chat Completion provider',
        'keyflow-disabled': 'KeyFlow is disabled',
        'legacy-conflict': 'KeyFlow paused because a legacy key-rotation extension is active',
        'missing-key': 'No active API key was found',
        'unsupported-client': 'This SillyTavern client cannot run the diagnostic test',
        'not-observed': 'The generation request did not reach the endpoint observed by KeyFlow',
        'response-format': 'Invalid or unexpected response format',
    };
    return labels[code] || fallback || 'Unknown';
}

function formatElapsed(milliseconds) {
    return `${(Number(milliseconds || 0) / 1000).toFixed(1)} seconds`;
}

function formatReportTime(value) {
    try {
        const date = new Date(value);
        const local = new Intl.DateTimeFormat('en-GB', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        }).format(date);
        const offsetMinutes = -date.getTimezoneOffset();
        const sign = offsetMinutes >= 0 ? '+' : '-';
        const hours = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, '0');
        const minutes = String(Math.abs(offsetMinutes) % 60).padStart(2, '0');
        return `${local} (UTC${sign}${hours}:${minutes})`;
    } catch {
        return String(value || 'Unknown time');
    }
}

function wrapReportText(value, width = 88, indent = '   ') {
    const text = collapseDiagnosticText(value, 1200);
    if (!text) return '';
    const words = text.split(/\s+/);
    const lines = [];
    let line = '';
    for (const word of words) {
        if (!line) {
            line = word;
            continue;
        }
        if ((indent.length + line.length + 1 + word.length) <= width) {
            line += ` ${word}`;
        } else {
            lines.push(`${indent}${line}`);
            line = word;
        }
    }
    if (line) lines.push(`${indent}${line}`);
    return lines.join('\n');
}

function getReportResult(record) {
    const initial = record.initial;
    const retry = record.retry;
    const finalResult = record.final || retry || initial;
    const recovered = isDiagnosticProblem(initial) && finalResult?.causeCode === 'success';

    if (recovered) {
        return {
            icon: '🟢',
            title: 'RECOVERED',
            description: 'The request succeeded after KeyFlow switched to a backup key.',
        };
    }
    if (record.rotation?.success && retry && isDiagnosticProblem(finalResult)) {
        return {
            icon: '🔴',
            title: 'FAILED',
            description: 'The original key failed, and the backup key failed as well.',
        };
    }
    if (record.rotation?.attempted && !record.rotation?.success) {
        return {
            icon: '🔴',
            title: 'FAILED',
            description: `KeyFlow detected the error but could not switch keys (${getRotationReasonEnglish(record.rotation.reason)}).`,
        };
    }
    return {
        icon: '🔴',
        title: 'FAILED',
        description: 'The request failed before it could be recovered.',
    };
}

function getPrimaryDiagnosticCause(record) {
    const finalResult = record.final || record.retry || record.initial;
    if (finalResult?.causeCode === 'success') return record.initial || finalResult;
    return finalResult || record.initial;
}

function getDiagnosticRecommendations(record) {
    const primary = getPrimaryDiagnosticCause(record);
    const code = primary?.causeCode || 'http';
    const provider = record.providerLabel || 'the provider';
    const suggestions = {
        quota: [
            `Check the quota or rate-limit dashboard for the project used by the failing key.`,
            `If separate quota pools are expected, confirm the backup keys belong to different provider projects.`,
            `Try a model available to the project's current tier, or wait for the quota window to reset.`,
        ],
        auth: [
            `Verify that the API key is still active and was copied without missing characters.`,
            `Confirm the required API is enabled for the key's project.`,
        ],
        permission: [
            `Check project permissions, API restrictions, and whether this model is allowed for the account.`,
            `Create or select a key with access to the requested model.`,
        ],
        credit: [
            `Check the ${provider} balance or spending limit.`,
            `Add credit or switch to a model/provider that is available within the current balance.`,
        ],
        context: [
            `Reduce chat history, context size, attached content, or maximum output tokens.`,
            `Try the same request with a model that supports a larger context window.`,
        ],
        safety: [
            `Review the provider's safety response and the selected safety settings.`,
            `Retry only after adjusting the request or using a model whose policy permits the content.`,
        ],
        model: [
            `Confirm the model ID still exists and is available through the selected provider.`,
            `Refresh the model list or choose another model before retrying.`,
        ],
        timeout: [
            `Retry once after the provider recovers.`,
            `For hosted SillyTavern, ask the host owner to check proxy and server timeout logs.`,
            `Long chats may need a smaller context or output limit.`,
        ],
        gateway: [
            `Check the reverse proxy or hosting service between SillyTavern and the API.`,
            `Ask the host owner for the server-side log matching the Request ID and time below.`,
        ],
        unavailable: [
            `The provider may be temporarily unavailable; retry later.`,
            `If it continues, check the provider status page and the hosting server log.`,
        ],
        overloaded: [
            `Wait briefly and retry, or select a less busy model/provider.`,
        ],
        server: [
            `Retry later and check whether the provider or hosting server is reporting an incident.`,
            `Ask the host owner to inspect server logs using the Request ID and timestamp below.`,
        ],
        network: [
            `Check the device connection and whether the hosted SillyTavern server can reach the API.`,
            `For rented hosting, ask the host owner to inspect outbound connection logs.`,
        ],
        'connection-closed': [
            `The connection ended before the response completed. Check proxy timeout and streaming support.`,
            `Retry with streaming disabled or a shorter response if the problem repeats.`,
        ],
        'max-retries': [
            `Look at the initial and retry causes in the request flow below; Max retries is usually the final symptom, not the root cause.`,
        ],
        'legacy-conflict': [
            `Disable the older key-rotation extension, reload SillyTavern, and test again.`,
        ],
        'missing-key': [
            `Add or activate a valid API key for the selected provider.`,
        ],
        'unsupported-provider': [
            `Select Google AI Studio or OpenRouter before testing KeyFlow.`,
        ],
        'not-observed': [
            `The hosting server may use a different API route that KeyFlow cannot observe. Ask the host owner which generation endpoint is used.`,
        ],
        'response-format': [
            `The server returned an unexpected response format. Check reverse proxy compatibility and server logs.`,
        ],
        client: [
            `Check the browser console or hosting server log because the failure occurred before a normal HTTP response was available.`,
        ],
        http: [
            `Use the HTTP status, sanitized detail, timestamp, and Request ID below to check provider or host logs.`,
        ],
    };
    return suggestions[code] || suggestions.http;
}

function formatDiagnosticReport(record) {
    const initial = record.initial;
    const retry = record.retry;
    const finalResult = record.final || retry || initial;
    const primaryCause = getPrimaryDiagnosticCause(record);
    const reportResult = getReportResult(record);
    const rotationText = record.rotation?.attempted
        ? record.rotation.success
            ? `SUCCESS: ${record.rotation.from || 'Unknown key'} → ${record.rotation.to || 'Unknown key'}${record.rotation.reason === 'auto-retry-disabled' ? ' (automatic retry disabled)' : ''}`
            : `FAILED: ${getRotationReasonEnglish(record.rotation.reason)}`
        : `NOT ATTEMPTED: ${getRotationReasonEnglish(record.rotation?.reason)}`;
    const providerRequestId = retry?.providerRequestId || initial?.providerRequestId;
    const detail = retry?.detail || initial?.detail;
    const recommendations = getDiagnosticRecommendations(record);
    const divider = '─'.repeat(54);

    const lines = [
        'TMRW—KeyFlow Diagnostic Report',
        divider,
        '',
        `${reportResult.icon} QUICK SUMMARY`,
        `Result       : ${reportResult.title}`,
        `What happened: ${reportResult.description}`,
        `Root cause   : ${causeEnglish(primaryCause?.causeCode, primaryCause?.cause)}`,
        '',
        '🔁 REQUEST FLOW',
        `1. Initial key : ${record.rotation?.from || 'Unknown key'}`,
        `   Request     : ${diagnosticOutcomeLabel(initial)}`,
        `   Cause       : ${causeEnglish(initial?.causeCode, initial?.cause)}`,
        '',
        `2. Key rotation: ${rotationText}`,
        '',
        `3. Backup key  : ${record.rotation?.to || 'Not used'}`,
        `   Retry       : ${diagnosticOutcomeLabel(retry)}`,
        `   Final cause : ${causeEnglish(finalResult?.causeCode, finalResult?.cause)}`,
        '',
        '🛠 SUGGESTED CHECKS',
        ...recommendations.map(item => `• ${item}`),
        '',
        '🧩 TECHNICAL DETAILS',
        `Provider     : ${record.providerLabel}`,
        `Model        : ${record.model}`,
        `Request type : ${record.requestType === 'test' ? 'Connection test' : 'Chat generation'}`,
        `Error layer  : ${initial?.type === 'http' ? 'HTTP response received from SillyTavern/host' : initial?.type === 'preflight' ? 'Request was not sent' : 'No HTTP response received'}`,
        `Elapsed time : ${formatElapsed(record.elapsedMs)}`,
        `Time         : ${formatReportTime(record.createdAt)}`,
        `Device       : ${record.device}`,
        `Request ID   : ${record.id}`,
    ];

    if (providerRequestId) lines.push(`Trace ID     : ${providerRequestId}`);
    if (record.maxRetriesDetected) lines.push('Max retries  : Detected');
    if (record.visibilityNote) {
        lines.push('', '⚠️ VISIBILITY LIMIT', `• ${record.visibilityNote}`);
    }
    if (detail) {
        lines.push('', '📄 SANITIZED ERROR DETAIL', wrapReportText(detail));
    }
    if (record.notes?.length) {
        lines.push('', '📝 NOTES', ...record.notes.map(note => `• ${collapseDiagnosticText(note, 500)}`));
    }
    lines.push(
        '',
        '🔒 PRIVACY',
        'Prompt, chat content, API keys, request body, cookies and tokens are not included.',
    );
    return lines.join('\n');
}

async function copyTextSafely(text, successMessage) {
    try {
        await navigator.clipboard.writeText(text);
        notify('success', successMessage, true);
    } catch {
        window.prompt('คัดลอกข้อความด้านล่าง', text);
    }
}

function isStreamingResponse(body, response) {
    return Boolean(body?.stream) || String(response.headers.get('content-type') || '').includes('text/event-stream');
}

function isJsonResponse(response) {
    return String(response.headers.get('content-type') || '').toLowerCase().includes('json');
}

async function monitorJsonResponse(response, record, startedAt, stage = 'initial', saveOnSuccess = false) {
    let clone;
    try {
        clone = response.clone();
    } catch {
        return;
    }

    try {
        const parsed = await clone.json();
        const rawError = parsed?.error || parsed?.errors?.[0] || null;
        if (rawError) {
            const detail = collapseDiagnosticText(
                rawError?.message
                || rawError?.detail
                || rawError?.type
                || (rawError?.code ? `Provider error code: ${rawError.code}` : 'Provider returned an error object without a safe message field'),
            );
            const failure = classifyFailure(200, detail);
            const result = {
                type: 'http',
                status: 200,
                statusText: 'Error payload after HTTP 200',
                causeCode: failure.code || 'response-format',
                cause: failure.code === 'http' ? 'เซิร์ฟเวอร์ส่ง Error payload แม้ HTTP status เป็น 200' : failure.label,
                detail,
                providerRequestId: '',
            };
            if (stage === 'retry') record.retry = result;
            else record.initial = result;
            finalizeDiagnostic(record, result, startedAt);
            persistDiagnostic(record);
            return;
        }

        if (saveOnSuccess) {
            const success = { type: 'http', status: response.status, statusText: response.statusText || 'OK', causeCode: 'success', cause: 'คำขอทดสอบสำเร็จ', detail: '', providerRequestId: '' };
            if (stage === 'retry') record.retry = success;
            else record.initial = success;
            finalizeDiagnostic(record, success, startedAt);
            persistDiagnostic(record);
        }
    } catch (error) {
        if (!saveOnSuccess && record.requestType !== 'test') {
            const result = {
                type: 'http',
                status: response.status,
                statusText: response.statusText || 'OK',
                causeCode: 'response-format',
                cause: 'รูปแบบคำตอบจากเซิร์ฟเวอร์ไม่ถูกต้องหรืออ่านไม่ได้',
                detail: collapseDiagnosticText(error?.message || error),
                providerRequestId: '',
            };
            if (stage === 'retry') record.retry = result;
            else record.initial = result;
            finalizeDiagnostic(record, result, startedAt);
            persistDiagnostic(record);
        } else if (saveOnSuccess) {
            const result = {
                type: 'http',
                status: response.status,
                statusText: response.statusText || 'OK',
                causeCode: 'response-format',
                cause: 'รูปแบบคำตอบจากเซิร์ฟเวอร์ไม่ถูกต้องหรืออ่านไม่ได้',
                detail: collapseDiagnosticText(error?.message || error),
                providerRequestId: '',
            };
            if (stage === 'retry') record.retry = result;
            else record.initial = result;
            finalizeDiagnostic(record, result, startedAt);
            persistDiagnostic(record);
        }
    }
}

function parseStreamErrorLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed || trimmed === 'data: [DONE]') return null;
    const payload = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
    if (!payload.startsWith('{') && !payload.startsWith('[')) return null;
    try {
        const parsed = JSON.parse(payload);
        const error = parsed?.error || parsed?.[0]?.error;
        if (!error) return null;
        return collapseDiagnosticText(
            error?.message
            || error?.detail
            || error?.type
            || (error?.code ? `Provider error code: ${error.code}` : 'Provider returned an error object without a safe message field'),
        );
    } catch {
        return null;
    }
}

async function monitorStreamingResponse(response, record, startedAt, stage = 'initial', saveOnSuccess = false) {
    let clone;
    try {
        clone = response.clone();
    } catch {
        return;
    }
    const reader = clone.body?.getReader?.();
    if (!reader) return;
    const decoder = new TextDecoder();
    let pending = '';
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            pending += decoder.decode(value, { stream: true });
            if (pending.length > 16_000) pending = pending.slice(-16_000);
            const lines = pending.split(/\r?\n/);
            pending = lines.pop() || '';
            for (const line of lines) {
                const streamError = parseStreamErrorLine(line);
                if (!streamError) continue;
                const failure = classifyFailure(200, streamError);
                const result = {
                    type: 'network',
                    status: 200,
                    statusText: 'Stream error after HTTP 200',
                    causeCode: failure.code || 'connection-closed',
                    cause: failure.label || 'เกิด Error กลางสตรีมหลัง HTTP 200',
                    detail: streamError,
                };
                if (stage === 'retry') record.retry = result;
                else {
                    record.initial = result;
                    record.notes.push('Error occurred after streaming began; KeyFlow did not rotate or retry to avoid duplicate output.');
                }
                finalizeDiagnostic(record, result, startedAt);
                persistDiagnostic(record);
                return;
            }
        }
        const trailingError = parseStreamErrorLine(pending);
        if (trailingError) {
            const failure = classifyFailure(200, trailingError);
            const result = {
                type: 'network',
                status: 200,
                statusText: 'Stream error after HTTP 200',
                causeCode: failure.code || 'connection-closed',
                cause: failure.label || 'เกิด Error กลางสตรีมหลัง HTTP 200',
                detail: trailingError,
            };
            if (stage === 'retry') record.retry = result;
            else {
                record.initial = result;
                record.notes.push('Error occurred after streaming began; KeyFlow did not rotate or retry to avoid duplicate output.');
            }
            finalizeDiagnostic(record, result, startedAt);
            persistDiagnostic(record);
            return;
        }
        if (saveOnSuccess) {
            const success = { type: 'http', status: response.status, statusText: response.statusText || 'OK', causeCode: 'success', cause: 'คำขอสำเร็จ', detail: '' };
            if (stage === 'retry') record.retry = success;
            else record.initial = success;
            finalizeDiagnostic(record, success, startedAt);
            persistDiagnostic(record);
        } else if (stage === 'retry') {
            updateDiagnostic(record.id, item => {
                const success = { type: 'http', status: response.status, statusText: response.statusText || 'OK', causeCode: 'success', cause: 'คำขอหลังสลับคีย์สำเร็จ', detail: '' };
                item.retry = success;
                item.final = success;
                item.completedAt = new Date().toISOString();
                item.elapsedMs = Math.max(0, Date.now() - startedAt);
            });
        }
    } catch (error) {
        const failure = classifyThrownError(error);
        if (failure.code === 'aborted' && record.requestType !== 'test') return;
        const result = makeNetworkDiagnostic(error, failure);
        if (stage === 'retry') record.retry = result;
        else record.initial = result;
        finalizeDiagnostic(record, result, startedAt);
        persistDiagnostic(record);
    }
}

function annotateMaxRetries(message) {
    const text = collapseDiagnosticText(message, MAX_ERROR_DETAIL_LENGTH);
    const latest = settings.diagnostics?.[0];
    const age = latest ? Date.now() - new Date(latest.createdAt).getTime() : Infinity;
    if (latest && age < 60_000) {
        updateDiagnostic(latest.id, item => {
            item.maxRetriesDetected = true;
            item.notes = Array.from(new Set([...(item.notes || []), text || 'SillyTavern reported maximum retries reached']));
            item.final = item.final || { type: 'network', status: null, statusText: '', causeCode: 'max-retries', cause: 'SillyTavern ลองซ้ำครบจำนวนแล้ว', detail: text };
        });
        return;
    }
    const provider = currentProvider();
    const active = getActiveSecret(provider);
    const record = createDiagnosticRecord({ provider, body: {}, activeSecret: active });
    const result = { type: 'network', status: null, statusText: '', causeCode: 'max-retries', cause: 'SillyTavern ลองซ้ำครบจำนวนแล้ว', detail: text };
    record.initial = result;
    record.maxRetriesDetected = true;
    finalizeDiagnostic(record, result, Date.now());
    persistDiagnostic(record);
}

function handleGlobalRejection(event) {
    const message = String(event?.reason?.message || event?.reason || '');
    if (/max(?:imum)?\s+retries|retries\s+(reached|exceeded)/i.test(message)) annotateMaxRetries(message);
}

function handleGlobalError(event) {
    const message = String(event?.error?.message || event?.message || '');
    if (/max(?:imum)?\s+retries|retries\s+(reached|exceeded)/i.test(message)) annotateMaxRetries(message);
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

    const startedAt = Date.now();
    const activeAtStart = getActiveSecret(provider);
    let requestType = 'chat';
    let requestId = null;
    if (diagnosticTestToken && !diagnosticTestToken.observed && diagnosticTestToken.providerId === provider.id) {
        diagnosticTestToken.observed = true;
        requestType = 'test';
        requestId = diagnosticTestToken.id;
    }
    const record = createDiagnosticRecord({ provider, body, activeSecret: activeAtStart, requestType, requestId, startedAt });

    let response;
    try {
        response = await originalFetch(input, init);
    } catch (error) {
        const failure = classifyThrownError(error);
        if (failure.code !== 'aborted' || requestType === 'test') {
            const result = makeNetworkDiagnostic(error, failure);
            record.initial = result;
            record.rotation.reason = 'not-needed';
            finalizeDiagnostic(record, result, startedAt);
            persistDiagnostic(record);
        }
        throw error;
    }

    if (response.ok) {
        if (isStreamingResponse(body, response)) {
            void monitorStreamingResponse(response, record, startedAt, 'initial', requestType === 'test');
        } else if (isJsonResponse(response)) {
            void monitorJsonResponse(response, record, startedAt, 'initial', requestType === 'test');
        } else if (requestType === 'test') {
            const success = { type: 'http', status: response.status, statusText: response.statusText || 'OK', causeCode: 'success', cause: 'คำขอทดสอบสำเร็จ', detail: '', providerRequestId: '' };
            record.initial = success;
            finalizeDiagnostic(record, success, startedAt);
            persistDiagnostic(record);
        }
        return response;
    }

    const errorText = await inspectErrorBody(response);
    const failure = classifyFailure(response.status, errorText);
    const safeDetail = extractSafeErrorDetail(errorText, response.statusText);
    record.initial = makeHttpDiagnostic(response, failure, safeDetail);
    if (safeDetail.visibility === 'generic') {
        record.visibilityNote = 'The SillyTavern or hosting server returned only a generic error and did not expose the upstream provider detail.';
    }

    if (!isRotationEnabled(failure)) {
        record.rotation.reason = 'disabled';
        finalizeDiagnostic(record, record.initial, startedAt);
        persistDiagnostic(record);
        return response;
    }

    record.rotation.attempted = true;
    let rotationResult;
    try {
        rotationResult = await rotateAfterFailure(provider, activeAtStart?.id || null, failure);
    } catch (error) {
        record.rotation.reason = 'rotate-failed';
        record.rotation.success = false;
        record.notes.push(`Rotation error: ${collapseDiagnosticText(error?.message || error)}`);
        finalizeDiagnostic(record, record.initial, startedAt);
        persistDiagnostic(record);
        return response;
    }

    if (!rotationResult.switched) {
        record.rotation.reason = rotationResult.reason || 'rotate-failed';
        finalizeDiagnostic(record, record.initial, startedAt);
        persistDiagnostic(record);
        return response;
    }

    record.rotation.success = true;
    record.rotation.reason = rotationResult.alreadySwitched ? 'already-switched' : 'success';
    record.rotation.to = diagnosticKeyLabel(rotationResult.next);

    if (!settings.autoRetry) {
        record.rotation.reason = 'auto-retry-disabled';
        finalizeDiagnostic(record, record.initial, startedAt);
        persistDiagnostic(record);
        return response;
    }

    const delayMs = safeNumber(settings.retryDelayMs, 400, 0, 5000);
    if (delayMs > 0) await wait(delayMs);

    let retryResponse;
    try {
        // Call the captured fetch directly so a failed retry cannot enter an infinite loop.
        retryResponse = await originalFetch(input, init);
    } catch (error) {
        const retryFailure = classifyThrownError(error);
        const retryResult = makeNetworkDiagnostic(error, retryFailure);
        record.retry = retryResult;
        finalizeDiagnostic(record, retryResult, startedAt);
        persistDiagnostic(record);
        throw error;
    }

    if (retryResponse.ok) {
        const success = { type: 'http', status: retryResponse.status, statusText: retryResponse.statusText || 'OK', causeCode: 'success', cause: 'คำขอหลังสลับคีย์สำเร็จ', detail: '' };
        record.retry = success;
        finalizeDiagnostic(record, success, startedAt);
        persistDiagnostic(record);
        if (isStreamingResponse(body, retryResponse)) {
            record.notes.push('HTTP 200 received; KeyFlow continued monitoring the response stream until completion.');
            persistDiagnostic(record);
            void monitorStreamingResponse(retryResponse, record, startedAt, 'retry', false);
        } else if (isJsonResponse(retryResponse)) {
            void monitorJsonResponse(retryResponse, record, startedAt, 'retry', false);
        }
        return retryResponse;
    }

    const retryErrorText = await inspectErrorBody(retryResponse);
    const retryFailure = classifyFailure(retryResponse.status, retryErrorText);
    const retrySafeDetail = extractSafeErrorDetail(retryErrorText, retryResponse.statusText);
    record.retry = makeHttpDiagnostic(retryResponse, retryFailure, retrySafeDetail);
    if (retrySafeDetail.visibility === 'generic' && !record.visibilityNote) {
        record.visibilityNote = 'The SillyTavern or hosting server returned only a generic error and did not expose the upstream provider detail.';
    }
    finalizeDiagnostic(record, record.retry, startedAt);
    persistDiagnostic(record);
    return retryResponse;
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


function getDiagnosticFinal(record) {
    return record?.final || record?.retry || record?.initial || null;
}

function formatDiagnosticTime(value) {
    try {
        return new Intl.DateTimeFormat('th-TH', {
            dateStyle: 'short',
            timeStyle: 'medium',
        }).format(new Date(value));
    } catch {
        return String(value || '');
    }
}

function appendDiagnosticField(container, label, value) {
    const row = document.createElement('div');
    row.className = 'keyflow-diagnostic-field';
    const term = document.createElement('span');
    term.className = 'keyflow-muted';
    term.textContent = label;
    const detail = document.createElement('strong');
    detail.textContent = String(value ?? '—');
    row.append(term, detail);
    container.appendChild(row);
}

function renderDiagnostics() {
    if (!uiRoot) return;
    const diagnostics = Array.isArray(settings.diagnostics) ? settings.diagnostics : [];
    const list = uiRoot.querySelector('#keyflow-diagnostic-list');
    const count = uiRoot.querySelector('#keyflow-diagnostic-count');
    const latestStatus = uiRoot.querySelector('#keyflow-diagnostic-status');
    const viewLatestButton = uiRoot.querySelector('#keyflow-view-latest-report');
    const clearButton = uiRoot.querySelector('#keyflow-clear-reports');
    if (!list || !count || !latestStatus) return;

    count.textContent = diagnostics.length ? `(${diagnostics.length})` : '';
    if (viewLatestButton) viewLatestButton.disabled = diagnostics.length === 0;
    clearButton.disabled = diagnostics.length === 0;
    list.replaceChildren();

    if (!diagnostics.length) {
        latestStatus.textContent = 'ยังไม่พบคำขอที่มีปัญหา';
        const empty = document.createElement('div');
        empty.className = 'keyflow-empty';
        empty.textContent = 'KeyFlow จะเก็บเฉพาะ 2 คำขอล่าสุดที่มีปัญหา คำขอทดสอบที่สำเร็จจะไม่ถูกเก็บ และจะไม่บันทึกพรอมพ์หรือ API key จริง';
        list.appendChild(empty);
        return;
    }

    const latest = diagnostics[0];
    const latestFinal = getDiagnosticFinal(latest);
    latestStatus.textContent = `${latest.providerLabel} · ${diagnosticOutcomeLabelTh(latestFinal)} · ${latestFinal?.cause || 'กำลังตรวจสอบ'}`;

    for (const record of diagnostics) {
        const finalResult = getDiagnosticFinal(record);
        const item = document.createElement('details');
        item.className = 'keyflow-diagnostic-item';

        const summary = document.createElement('summary');
        const summaryMain = document.createElement('span');
        summaryMain.className = 'keyflow-diagnostic-summary-main';
        const title = document.createElement('strong');
        title.textContent = `${record.providerLabel} · ${diagnosticOutcomeLabelTh(finalResult)}`;
        const subtitle = document.createElement('span');
        subtitle.className = 'keyflow-muted';
        subtitle.textContent = `${formatDiagnosticTime(record.createdAt)} · ${finalResult?.cause || 'กำลังตรวจสอบ'}`;
        summaryMain.append(title, subtitle);
        const typeBadge = document.createElement('span');
        typeBadge.className = 'keyflow-badge';
        typeBadge.textContent = record.requestType === 'test' ? 'ทดสอบ' : 'แชท';
        summary.append(summaryMain, typeBadge);

        const content = document.createElement('div');
        content.className = 'keyflow-diagnostic-content';
        appendDiagnosticField(content, 'สรุปเร็ว', finalResult?.cause || 'กำลังตรวจสอบ');
        appendDiagnosticField(content, 'เวลา', formatDiagnosticTime(record.createdAt));
        appendDiagnosticField(content, 'คำขอแรก', `${diagnosticOutcomeLabelTh(record.initial)} · ${record.initial?.cause || '—'}`);
        appendDiagnosticField(content, 'การสลับคีย์', record.rotation?.attempted
            ? record.rotation.success
                ? `สำเร็จ → ${record.rotation.to || 'Unknown key'}${record.rotation.reason === 'auto-retry-disabled' ? ' · ปิด Retry อัตโนมัติ' : ''}`
                : `ไม่สำเร็จ · ${getRotationReasonLabel(record.rotation.reason)}`
            : `ไม่ได้สลับ · ${getRotationReasonLabel(record.rotation?.reason)}`);
        appendDiagnosticField(content, 'คำขอหลังสลับ', record.retry ? `${diagnosticOutcomeLabelTh(record.retry)} · ${record.retry.cause}` : 'ไม่ได้ส่ง');
        appendDiagnosticField(content, 'Request ID', record.id);

        const actions = document.createElement('div');
        actions.className = 'keyflow-diagnostic-inline-actions';
        const viewButton = makeButton('ดูรายละเอียด', 'menu_button', () => openDiagnosticDialog(record.id));
        viewButton.classList.add('keyflow-diagnostic-view');
        actions.appendChild(viewButton);
        content.appendChild(actions);

        item.append(summary, content);
        list.appendChild(item);
    }
}


function getDiagnosticById(id) {
    return (settings.diagnostics || []).find(item => item.id === id) || null;
}

function closeDiagnosticDialog() {
    const dialog = uiRoot?.querySelector('#keyflow-report-dialog');
    if (!dialog) return;
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
}

function openDiagnosticDialog(requestId = null) {
    if (!uiRoot) return;
    const dialog = uiRoot.querySelector('#keyflow-report-dialog');
    const body = uiRoot.querySelector('#keyflow-report-body');
    const title = uiRoot.querySelector('#keyflow-report-title');
    const providerLabel = uiRoot.querySelector('#keyflow-report-provider');
    const actions = uiRoot.querySelector('#keyflow-report-actions');
    const copyCurrent = uiRoot.querySelector('#keyflow-report-copy-current');
    const copyAll = uiRoot.querySelector('#keyflow-report-copy-all');
    if (!dialog || !body || !title || !providerLabel || !actions) return;

    const diagnostics = settings.diagnostics || [];
    const record = requestId ? getDiagnosticById(requestId) : diagnostics[0];
    if (!record) {
        notify('warning', 'ยังไม่มีรายงานให้เปิดดู', true);
        return;
    }

    const text = formatDiagnosticReport(record);
    title.textContent = 'รายงานวิเคราะห์ปัญหา';
    providerLabel.textContent = record.providerLabel;
    body.textContent = text;
    copyCurrent.onclick = () => copyTextSafely(text, 'คัดลอกรายงานนี้แล้ว');
    copyAll.onclick = () => copyAllDiagnostics();
    const hasMultipleReports = diagnostics.length > 1;
    copyAll.hidden = !hasMultipleReports;
    copyAll.disabled = !hasMultipleReports;
    actions.classList.toggle('keyflow-report-actions-single', !hasMultipleReports);
    body.scrollTop = 0;

    if (typeof dialog.showModal === 'function') {
        dialog.showModal();
    } else {
        dialog.setAttribute('open', 'open');
    }
}

function createPreflightDiagnostic(provider, requestId, causeCode, cause, detail = '') {
    const startedAt = Date.now();
    const record = createDiagnosticRecord({ provider, body: {}, activeSecret: getActiveSecret(provider), requestType: 'test', requestId, startedAt });
    const result = { type: 'preflight', status: null, statusText: '', causeCode, cause, detail: collapseDiagnosticText(detail) };
    record.initial = result;
    record.rotation.reason = 'not-needed';
    finalizeDiagnostic(record, result, startedAt);
    persistDiagnostic(record);
    return record;
}

async function sendDiagnosticTest() {
    if (diagnosticTestRunning) return;
    const button = uiRoot.querySelector('#keyflow-send-test');
    const source = getCurrentChatCompletionSource();
    const provider = providerFromSource(source);
    const requestId = createRequestId();

    if (!provider) {
        createPreflightDiagnostic(currentProvider(), requestId, 'unsupported-provider', 'แหล่งที่มาของ Chat Completion ปัจจุบันยังไม่รองรับ', source || 'No Chat Completion source selected');
        notify('warning', 'เลือก Google AI Studio หรือ OpenRouter ก่อนส่งคำขอทดสอบ', true);
        return;
    }
    if (!settings.enabled) {
        createPreflightDiagnostic(provider, requestId, 'keyflow-disabled', 'KeyFlow ถูกปิดอยู่');
        notify('warning', 'เปิด Smart Failover ก่อนส่งคำขอทดสอบ', true);
        return;
    }
    if (legacyConflict) {
        createPreflightDiagnostic(provider, requestId, 'legacy-conflict', 'KeyFlow พักการทำงานเพราะพบส่วนเสริมเก่า');
        notify('warning', 'ปิด ZerxzLib และรีโหลดหน้าก่อนส่งคำขอทดสอบ', true);
        return;
    }
    if (!getActiveSecret(provider)) {
        createPreflightDiagnostic(provider, requestId, 'missing-key', 'ไม่พบ API key ที่กำลังใช้งาน');
        notify('warning', `${provider.label} ยังไม่มีคีย์ที่กำลังใช้งาน`, true);
        return;
    }

    const context = globalThis.SillyTavern?.getContext?.();
    if (typeof context?.generateRaw !== 'function') {
        createPreflightDiagnostic(provider, requestId, 'unsupported-client', 'SillyTavern รุ่นนี้ไม่เปิดฟังก์ชันส่งคำขอทดสอบให้ Extension');
        notify('error', 'ส่งคำขอทดสอบไม่ได้ใน SillyTavern รุ่นนี้', true);
        return;
    }

    diagnosticTestRunning = true;
    button.disabled = true;
    button.textContent = 'กำลังทดสอบ…';
    diagnosticTestToken = { id: requestId, providerId: provider.id, observed: false };

    try {
        await context.generateRaw({
            prompt: 'Reply with exactly one word: OK',
            responseLength: 8,
            trimNames: true,
        });
        await wait(50);
        if (!diagnosticTestToken.observed && !(settings.diagnostics || []).some(item => item.id === requestId)) {
            createPreflightDiagnostic(provider, requestId, 'not-observed', 'KeyFlow ไม่พบคำขอ Generation จากการทดสอบ', 'คำขออาจถูกหยุดก่อนถึง endpoint หรือเว็บโฮสต์ใช้เส้นทาง API ที่ต่างออกไป');
        }
    } catch (error) {
        await wait(50);
        if (!(settings.diagnostics || []).some(item => item.id === requestId)) {
            const failure = classifyThrownError(error);
            createPreflightDiagnostic(provider, requestId, failure.code, failure.label, error?.message || error);
        } else {
            updateDiagnostic(requestId, item => {
                const note = collapseDiagnosticText(error?.message || error);
                if (note) item.notes = Array.from(new Set([...(item.notes || []), `SillyTavern generation error: ${note}`]));
            });
        }
    } finally {
        diagnosticTestToken = null;
        diagnosticTestRunning = false;
        button.disabled = false;
        button.textContent = 'ส่งคำขอทดสอบ';
        renderDiagnostics();
    }
}

function viewLatestDiagnostic() {
    const latest = settings.diagnostics?.[0];
    if (!latest) return;
    openDiagnosticDialog(latest.id);
}

async function copyAllDiagnostics() {
    const diagnostics = settings.diagnostics || [];
    if (!diagnostics.length) return;
    const text = diagnostics.map(formatDiagnosticReport).join('\n\n' + '='.repeat(48) + '\n\n');
    await copyTextSafely(text, `คัดลอกรายงาน ${diagnostics.length} รายการแล้ว`);
}

function clearDiagnostics() {
    if (!settings.diagnostics?.length) return;
    if (!window.confirm('ล้างรายงานวิเคราะห์ปัญหาทั้งหมดใช่ไหม?')) return;
    settings.diagnostics = [];
    persistSettings();
    renderDiagnostics();
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
                <label class="checkbox_label keyflow-follow-source" for="keyflow-follow-source">
                    <input id="keyflow-follow-source" type="checkbox">
                    <span>เลือกผู้ให้บริการตามแหล่งที่มาของ Chat Completion อัตโนมัติ</span>
                </label>
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
                <details id="keyflow-bulk-tools" class="keyflow-bulk-tools" hidden>
                    <summary><b>เครื่องมือล้างคีย์จำนวนมาก</b></summary>
                    <div class="keyflow-bulk-content">
                        <div id="keyflow-overflow-text"></div>
                        <div class="keyflow-muted">ซ่อนไว้เพื่อป้องกันการกดพลาด และระบบจะถามยืนยันอีกครั้งก่อนลบ</div>
                        <div class="keyflow-actions-inline">
                            <button type="button" class="menu_button" data-keyflow-bulk="keep-active">เก็บคีย์ที่ใช้อยู่ 1 อัน</button>
                            <button type="button" class="menu_button keyflow-danger" data-keyflow-bulk="delete-all">ลบทั้งหมด</button>
                        </div>
                        <div id="keyflow-cleanup-progress" class="keyflow-progress" hidden></div>
                    </div>
                </details>
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

            <details id="keyflow-diagnostics" class="keyflow-section">
                <summary><b>ตรวจสอบคำขอล่าสุด <span id="keyflow-diagnostic-count"></span></b></summary>
                <div class="keyflow-diagnostic-overview">
                    <span class="keyflow-muted">สถานะล่าสุด</span>
                    <strong id="keyflow-diagnostic-status">ยังไม่พบคำขอที่มีปัญหา</strong>
                </div>
                <div class="keyflow-muted keyflow-diagnostic-privacy">เก็บเฉพาะ 2 ปัญหาล่าสุด พร้อมสาเหตุ ลำดับการสลับคีย์ เวลา Provider Model และข้อมูลอุปกรณ์แบบทั่วไป ไม่เก็บ Prompt, เนื้อหาแชท, API key จริง, Request body, Cookie หรือ Token</div>
                <div class="keyflow-diagnostic-actions">
                    <button id="keyflow-send-test" type="button" class="menu_button">ส่งคำขอทดสอบ</button>
                    <button id="keyflow-view-latest-report" type="button" class="menu_button">ดูรายละเอียดล่าสุด</button>
                    <button id="keyflow-clear-reports" type="button" class="menu_button keyflow-danger">ล้างรายงาน</button>
                </div>
                <div class="keyflow-muted keyflow-test-note">คำขอทดสอบจะใช้โมเดลที่เลือกอยู่และอาจใช้โควตาเล็กน้อย ผลทดสอบผ่านไม่ได้รับประกันว่าแชทยาวจะไม่ Timeout กดดูรายละเอียดเพื่ออ่านรายงานก่อน แล้วค่อยคัดลอกส่งให้คนช่วยหากยังแก้เองไม่ได้</div>
                <div id="keyflow-diagnostic-list" class="keyflow-diagnostic-list"></div>
            </details>

            <dialog id="keyflow-report-dialog" class="keyflow-report-dialog">
                <div class="keyflow-report-header">
                    <div class="keyflow-report-heading">
                        <span class="keyflow-report-eyebrow">TMRW—KeyFlow</span>
                        <strong id="keyflow-report-title">รายงานวิเคราะห์ปัญหา</strong>
                        <span id="keyflow-report-provider" class="keyflow-report-provider"></span>
                    </div>
                    <button id="keyflow-report-close-top" type="button" class="keyflow-report-close-icon" aria-label="ปิดหน้าต่างรายงาน">✕</button>
                </div>
                <pre id="keyflow-report-body" class="keyflow-report-body"></pre>
                <div id="keyflow-report-actions" class="keyflow-report-actions">
                    <button id="keyflow-report-copy-current" type="button" class="menu_button keyflow-report-primary">คัดลอกรายงานนี้</button>
                    <button id="keyflow-report-copy-all" type="button" class="menu_button keyflow-report-secondary">คัดลอกทั้งหมด</button>
                </div>
            </dialog>

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
    uiRoot.querySelector('#keyflow-follow-source').addEventListener('change', event => {
        settings.followChatCompletionSource = Boolean(event.target.checked);
        persistSettings();
        if (settings.followChatCompletionSource) {
            syncProviderFromChatCompletionSource(getCurrentChatCompletionSource(), true);
        }
        renderSummary();
    });
    uiRoot.querySelector('#keyflow-add-keys').addEventListener('click', addKeysFromUi);
    uiRoot.querySelector('#keyflow-refresh').addEventListener('click', async () => {
        await refreshState();
        renderAll();
    });
    uiRoot.querySelector('#keyflow-next').addEventListener('click', () => manualRotate(currentProvider()));
    uiRoot.querySelector('#keyflow-copy-config-fix').addEventListener('click', copyExposureFixCommand);
    uiRoot.querySelector('#keyflow-send-test').addEventListener('click', sendDiagnosticTest);
    uiRoot.querySelector('#keyflow-view-latest-report').addEventListener('click', viewLatestDiagnostic);
    uiRoot.querySelector('#keyflow-clear-reports').addEventListener('click', clearDiagnostics);
    uiRoot.querySelector('#keyflow-report-close')?.addEventListener('click', closeDiagnosticDialog);
    uiRoot.querySelector('#keyflow-report-close-top')?.addEventListener('click', closeDiagnosticDialog);
    uiRoot.querySelector('#keyflow-report-dialog')?.addEventListener('click', event => {
        const dialog = uiRoot.querySelector('#keyflow-report-dialog');
        if (event.target === dialog) closeDiagnosticDialog();
    });

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
        '#keyflow-follow-source': settings.followChatCompletionSource,
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
    // DOM nodes from a deleted extension can remain until the page is reloaded.
    // Use SillyTavern's installed/enabled extension registry instead of stale DOM markers.
    return extensionNames.some(name =>
        /zerxzlib/i.test(name) && !extension_settings.disabledExtensions.includes(name),
    );
}

function renderMigrationTools() {
    if (!uiRoot) return;
    const legacyFound = detectLegacyExtension();
    legacyConflict = legacyFound;
    const exposureFound = allowKeysExposure === true;
    const panel = uiRoot.querySelector('#keyflow-migration-tools');

    uiRoot.querySelector('#keyflow-legacy-warning').hidden = !legacyFound;
    uiRoot.querySelector('#keyflow-exposure-warning').hidden = !exposureFound;
    panel.hidden = !(legacyFound || exposureFound);

    if (legacyConflict) uninstallFetchInterceptor();
    else installFetchInterceptor();

    if (panel.hidden) {
        panel.open = false;
        delete panel.dataset.autoOpened;
    } else if (!panel.dataset.autoOpened) {
        panel.open = true;
        panel.dataset.autoOpened = 'true';
    }
}

function renderBulkTools() {
    if (!uiRoot) return;
    const provider = currentProvider();
    const count = getSecrets(provider).length;
    const bulkTools = uiRoot.querySelector('#keyflow-bulk-tools');
    const overflowFound = count >= LARGE_KEY_COUNT;

    bulkTools.hidden = !overflowFound;
    if (!overflowFound) bulkTools.open = false;
    uiRoot.querySelector('#keyflow-overflow-text').innerHTML = overflowFound
        ? `<b>พบ ${count} คีย์ของ ${provider.label}</b><br>เปิดหัวข้อนี้เมื่อต้องการเก็บคีย์ที่กำลังใช้อยู่เพียง 1 อัน หรือลบทั้งหมด`
        : '';
}

function renderAll() {
    if (!uiRoot) return;
    populateSettingsControls();
    renderMigrationTools();
    renderBulkTools();
    renderSummary();
    renderKeyList();
    renderDiagnostics();
}

function subscribe(eventName, handler) {
    if (!eventName) return;
    eventSource.on(eventName, handler);
    subscriptions.push([eventName, handler]);
}

async function refreshExposureSetting(forceRender = false) {
    try {
        const value = await canViewSecrets();
        if (typeof value !== 'boolean') return;
        const changed = allowKeysExposure !== value;
        allowKeysExposure = value;
        if (changed || forceRender) renderMigrationTools();

        // Keep checking while the warning is visible. This clears stale warnings
        // automatically after the user edits config.yaml and restarts the server.
        if (allowKeysExposure === true) scheduleExposureRefresh(3000);
    } catch {
        // Keep the previous value if the server is still restarting.
        scheduleExposureRefresh(3000);
    }
}

function scheduleExposureRefresh(delay = 1200) {
    clearTimeout(exposureRefreshTimer);
    exposureRefreshTimer = setTimeout(() => refreshExposureSetting(), delay);
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
    window.removeEventListener('unhandledrejection', handleGlobalRejection);
    window.removeEventListener('error', handleGlobalError);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    for (const [eventName, handler] of subscriptions.splice(0)) {
        eventSource.removeListener?.(eventName, handler);
    }
    uiRoot?.remove();
    document.querySelector('#tmrw-keyflow-toast-container')?.remove();
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
    syncProviderFromChatCompletionSource(getCurrentChatCompletionSource(), false);
    renderAll();
    window.addEventListener('focus', scheduleExposureRefresh);
    window.addEventListener('unhandledrejection', handleGlobalRejection);
    window.addEventListener('error', handleGlobalError);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    if (!legacyConflict) {
        installFetchInterceptor();
    } else {
        notify('warning', 'พบส่วนเสริมสลับคีย์รุ่นเก่า จึงพัก KeyFlow ไว้ก่อน กรุณาปิดตัวเก่าแล้วรีโหลดหน้า', true);
    }

    subscribe(event_types.CHATCOMPLETION_SOURCE_CHANGED, handleChatCompletionSourceChanged);
    subscribe(event_types.SECRET_WRITTEN, refreshFromSecretEvent);
    subscribe(event_types.SECRET_ROTATED, refreshFromSecretEvent);
    subscribe(event_types.SECRET_DELETED, refreshFromSecretEvent);
    subscribe(event_types.SECRET_EDITED, refreshFromSecretEvent);
}

if (document.readyState === 'loading') subscribe(event_types.APP_READY, initialize);
else queueMicrotask(initialize);
