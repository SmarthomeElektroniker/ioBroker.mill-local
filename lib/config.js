'use strict';

/**
 * Checks the timing settings of the instance. The admin UI limits the fields, but the instance
 * object can be edited directly (or imported) - nonsense is not silently clamped: every corrected
 * value is reported as a clear warning with the value that is used instead.
 */

const { intervalMs } = require('./model');

/** Limits in seconds: [default, min, max] - the same as in admin/jsonConfig.json */
const LIMITS = {
    pollInterval: [30, 10, 3600],
    slowInterval: [600, 60, 86400],
    timeout: [5, 1, 30],
};

const LABEL = {
    pollInterval: 'Polling interval',
    slowInterval: 'Interval for settings',
    timeout: 'Request timeout',
};

/**
 * @param {unknown} value Configured value
 * @returns {boolean} Empty, not a number, zero or negative
 */
const invalid = value => {
    const n = Number(value);
    return (
        value === null ||
        value === undefined ||
        value === '' ||
        typeof value === 'boolean' ||
        !Number.isFinite(n) ||
        n <= 0
    );
};

/**
 * Effective timing values and warnings for the configured ones.
 *
 * @param {{pollInterval?: unknown, slowInterval?: unknown, timeout?: unknown}} cfg Instance configuration
 * @returns {{pollMs: number, slowMs: number, timeoutMs: number, warnings: string[]}} Values in ms and warnings
 */
function checkTiming(cfg) {
    const warnings = [];
    const ms = {};
    for (const [key, [def, min, max]] of Object.entries(LIMITS)) {
        const raw = cfg[key];
        ms[key] = intervalMs(invalid(raw) ? def : raw, def, min, max);
        const used = ms[key] / 1000;
        if (invalid(raw)) {
            warnings.push(`${LABEL[key]} "${raw}" is not a valid number of seconds - using the default of ${used} s`);
        } else if (Number(raw) !== used) {
            warnings.push(`${LABEL[key]} ${raw} s is outside the allowed range ${min} ... ${max} s - using ${used} s`);
        }
    }
    if (ms.timeout >= ms.pollInterval) {
        warnings.push(
            `Request timeout (${ms.timeout / 1000} s) is not shorter than the polling interval (${ms.pollInterval / 1000} s) - an unreachable device delays every cycle; choose a shorter timeout`,
        );
    }
    if (ms.slowInterval < ms.pollInterval) {
        warnings.push(
            `Interval for settings (${ms.slowInterval / 1000} s) is shorter than the polling interval (${ms.pollInterval / 1000} s) - the settings are read in every cycle`,
        );
    }
    return { pollMs: ms.pollInterval, slowMs: ms.slowInterval, timeoutMs: ms.timeout, warnings };
}

module.exports = { checkTiming, LIMITS };
