'use strict';

/**
 * Knowledge about Mill Generation 3 devices: device kinds, enumerations of the local API
 * and helpers that turn API answers into state values.
 *
 * Sources: the official API description of Mill International AS
 * (github.com/Mill-International-AS/Generation_3_REST_API) and observations on a real
 * Wi-Fi Socket Gen 3 (firmware 0x230421). Where the documentation and the device disagree,
 * the device wins - see the comments.
 */

/** Device kinds. The value is used as `info.type`. */
const KIND = {
    PANEL: 'panel',
    CONVECTION: 'convection',
    OIL: 'oil',
    SOCKET: 'socket',
    STORAGE: 'storage',
    UNKNOWN: 'unknown',
};

/**
 * Operation modes the adapter may write. The device acknowledges ANY string with
 * `{"status":"ok"}` and switches itself OFF for unknown values - so only these may be sent.
 * The device reports the off mode as "OFF", the documentation writes "Off"; both are accepted.
 */
const OPERATION_MODES = {
    'Control individually': 'Control individually',
    'Weekly program': 'Weekly program',
    'Independent device': 'Independent device',
    Off: 'Off',
};

/** Temperature types with a settable value (`Off` and `AlwaysHeating` have none). */
const TEMPERATURE_TYPES = ['Normal', 'Comfort', 'Sleep', 'Away'];

/** Allowed values of `oil-heater-power`. */
const OIL_POWER_LEVELS = [0, 40, 60, 100];

/** Predictive heating types. */
const PREDICTIVE_TYPES = ['Off', 'Simple', 'Advanced'];

/**
 * Determines the device kind from the model name of `GET /status`.
 * Known names: "Mill HeaterGen3Socket" (Wi-Fi Socket), "panel heater gen. 3" (documentation
 * example). Other names are matched by keywords; capability probing complements this.
 *
 * @param {string} name Model name reported by the device
 * @returns {string} One of KIND
 */
function kindFromName(name) {
    const n = String(name || '').toLowerCase();
    if (/socket|plug/.test(n)) {
        return KIND.SOCKET;
    }
    if (/oil/.test(n)) {
        return KIND.OIL;
    }
    if (/storage/.test(n)) {
        return KIND.STORAGE;
    }
    if (/convect/.test(n)) {
        return KIND.CONVECTION;
    }
    if (/panel/.test(n)) {
        return KIND.PANEL;
    }
    return KIND.UNKNOWN;
}

/**
 * Refines the kind with the probed optional endpoints when the name was not conclusive.
 *
 * @param {string} kind Kind from the name
 * @param {{oilPower?: boolean, limitedPower?: boolean, socketMode?: boolean, pid?: boolean}} caps Probed capabilities
 * @returns {string} Kind
 */
function refineKind(kind, caps) {
    if (kind !== KIND.UNKNOWN) {
        return kind;
    }
    if (caps.oilPower) {
        return KIND.OIL;
    }
    if (caps.socketMode) {
        return KIND.SOCKET;
    }
    if (caps.limitedPower || caps.pid) {
        return KIND.PANEL;
    }
    return KIND.UNKNOWN;
}

/**
 * Maps the reported operation mode to the writable spelling.
 *
 * @param {string} mode Mode as reported by the device
 * @returns {string} Normalised mode ("Off" for "OFF")
 */
function normaliseMode(mode) {
    const m = String(mode || '');
    if (m.toLowerCase() === 'off') {
        return 'Off';
    }
    return m;
}

/**
 * Interprets `open_window_active_now` of `/control-status`.
 * The documentation swaps the meaning of "Enabled active now" / "Enabled not active now" in
 * its table; the wording itself ("active now") is taken literally here.
 *
 * @param {string} text Reported text
 * @returns {{enabled: boolean, active: boolean}} Parsed flags
 */
function parseOpenWindow(text) {
    const t = String(text || '').toLowerCase();
    return {
        enabled: t.startsWith('enabled'),
        active: /(^|\s)active now/.test(t) && !/not active now/.test(t),
    };
}

/**
 * Rounds a float reported by the device (e.g. 19.200632095336914).
 *
 * @param {unknown} v Value
 * @param {number} [digits] Decimal places
 * @returns {number|null} Rounded value or null
 */
function round(v, digits = 1) {
    const n = Number(v);
    if (v === null || v === undefined || v === '' || !Number.isFinite(n)) {
        return null;
    }
    const f = 10 ** digits;
    return Math.round(n * f) / f;
}

/**
 * Normalises a MAC address to 12 lower-case hex digits (used as device ID).
 *
 * @param {string} mac MAC address in any notation
 * @returns {string} e.g. "94e686001234" or "" if invalid
 */
function macId(mac) {
    const m = String(mac || '')
        .toLowerCase()
        .replace(/[^0-9a-f]/g, '');
    return m.length === 12 ? m : '';
}

/**
 * Checks whether an answer of `GET /status` comes from a Mill Generation 3 device.
 *
 * @param {unknown} st Parsed JSON
 * @returns {boolean} True for a Mill device
 */
function isMillStatus(st) {
    return (
        !!st &&
        typeof st === 'object' &&
        typeof st.name === 'string' &&
        !!macId(st.mac_address) &&
        typeof st.version === 'string' &&
        /mill|gen\.? ?3/i.test(st.name)
    );
}

module.exports = {
    KIND,
    OPERATION_MODES,
    TEMPERATURE_TYPES,
    OIL_POWER_LEVELS,
    PREDICTIVE_TYPES,
    kindFromName,
    refineKind,
    normaliseMode,
    parseOpenWindow,
    round,
    macId,
    isMillStatus,
};
