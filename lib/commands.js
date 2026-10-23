'use strict';

/**
 * All values the adapter can write to a Mill Generation 3 device, with validation and the
 * request(s) the local API needs. One table, used for the object definitions (write flag,
 * min/max/states) and for executing commands.
 *
 * Every value is validated BEFORE anything is sent: the device acknowledges nonsense with
 * {"status":"ok"} - an unknown operation mode even switches it off.
 *
 * "Switch" is an operation mode of the adapter, not of the device: the device runs in
 * "Independent device" and the relay is forced on or off with set-temperature-in-independent-mode-now
 * 99 / 0 (verified on a Wi-Fi Socket Gen 3: 99 = control signal 100 %, 0 = 0 %). No temperature control.
 *
 * Not offered on purpose (see README): set-api-key (irreversible without factory reset), soft/hard reset,
 * ota-update (needs a firmware URL and internet), device-config (Wi-Fi), ablecloud-message, max-heater-power
 * (power meter calibration, cannot be read back).
 */

const { OPERATION_MODES, OIL_POWER_LEVELS, PREDICTIVE_TYPES } = require('./model');
const schedule = require('./schedule');

/**
 * @param {string} path Endpoint
 * @param {object} body JSON body
 * @returns {{path: string, body: object}} Request
 */
const post = (path, body) => ({ path, body });

const DISPLAY_UNITS = ['Celsius', 'Fahrenheit'];

/** Adapter mode without temperature control, see above */
const SWITCH_MODE = 'Switch';
/** Values of set-temperature-in-independent-mode-now that force the relay */
const RELAY_ON = 99;
const RELAY_OFF = 0;

/** Operation modes that can be written: the four of the device plus "Switch" */
const MODES = [...Object.keys(OPERATION_MODES), SWITCH_MODE];

/**
 * Requests that put the device into "Switch" with the relay on or off.
 *
 * @param {boolean} on Relay on
 * @returns {Array<{path: string, body: object}>} Requests
 */
const switchTo = on => [
    post('operation-mode', { mode: 'Independent device' }),
    post('set-temperature-in-independent-mode-now', { temperature: on ? RELAY_ON : RELAY_OFF }),
];

/**
 * Requests for an operation mode including "Switch".
 *
 * @param {string} mode Mode
 * @param {boolean} relayOn Relay state to use for "Switch"
 * @param {number} [normal] Normal temperature (to leave a forced relay in "Independent device")
 * @returns {Array<{path: string, body: object}>} Requests
 */
const modeRequests = (mode, relayOn, normal) => {
    if (mode === SWITCH_MODE) {
        return switchTo(relayOn);
    }
    const out = [post('operation-mode', { mode })];
    // a relay forced by "Switch" (99 / 0) would stay - set the Normal temperature again
    if (mode === 'Independent device' && Number.isFinite(normal) && normal > RELAY_OFF && normal < RELAY_ON) {
        out.push(post('set-temperature-in-independent-mode-now', { temperature: normal }));
    }
    return out;
};

/**
 * Builds the complete open-window parameter set (the endpoint wants all fields).
 *
 * @param {object} cur Current answer of GET /open-window
 * @param {object} change Changed fields
 */
const openWindowBody = (cur, change) => ({
    drop_temperature_threshold: cur.drop_temperature_threshold,
    drop_time_range: cur.drop_time_range,
    enabled: !!cur.enabled,
    increase_temperature_threshold: cur.increase_temperature_threshold,
    increase_time_range: cur.increase_time_range,
    max_time: cur.max_time,
    ...change,
});

/**
 * Command table. Keys are the state IDs below the device object.
 * - type/min/max/step/states: validation, also copied into the object definition
 * - need: capability the value depends on
 * - fresh: endpoint read right before writing (its answer is passed to `build`)
 * - build(value, ctx, fresh): returns the request list
 */
const COMMANDS = {
    'control.targetTemperature': {
        type: 'number',
        min: 5,
        max: 35,
        step: 0.5,
        build: (v, ctx) => [
            post('set-temperature', { type: 'Normal', value: v }),
            // in this mode the new value only takes effect with this extra call
            // ("Switch" keeps its forced relay; the value is used once the mode changes)
            ...(ctx.mode === 'Independent device'
                ? [post('set-temperature-in-independent-mode-now', { temperature: v })]
                : []),
        ],
    },
    'control.operationMode': {
        type: 'string',
        states: MODES,
        // "Switch" starts with the relay off
        build: (v, ctx) => modeRequests(v, false, ctx.normal),
    },
    'control.power': {
        type: 'boolean',
        // ON always switches on: manual mode "Switch" with the relay closed, regardless of thermostat,
        // weekly program and target temperature (no Mill mode does that by itself).
        // OFF switches off safely in every mode: "Switch" keeps the manual mode with the relay open,
        // every other mode goes to "Off".
        build: (v, ctx) => {
            if (v) {
                return switchTo(true);
            }
            return ctx.mode === SWITCH_MODE
                ? [post('set-temperature-in-independent-mode-now', { temperature: RELAY_OFF })]
                : [post('operation-mode', { mode: 'Off' })];
        },
    },
    'info.customName': {
        type: 'string',
        maxLength: 32,
        build: v => [post('set-custom-name', { device_name: v })],
    },
    'control.restart': {
        type: 'boolean',
        button: true,
        // the device restarts before it answers - a timeout or closed connection is the expected result
        noAnswer: true,
        build: () => [post('reboot', {})],
    },
    'settings.timezoneOffset': {
        type: 'number',
        // documented -840 ... 720; the device reports 1440 while no time zone is set
        min: -840,
        max: 1440,
        step: 15,
        build: v => [post('timezone-offset', { timezone_offset: v })],
    },
    'settings.regulatorType': {
        type: 'string',
        states: ['pid', 'hysteresis_or_slow_pid'],
        build: (v, ctx) => {
            // PID is meant for panel (and storage) heaters only
            if (v === 'pid' && !['panel', 'storage'].includes(ctx.kind)) {
                throw new Error('the PID controller is only available for panel heaters');
            }
            return [post('controller-type', { regulator_type: v })];
        },
    },
    'settings.commercialLockMin': {
        type: 'number',
        min: 5,
        max: 35,
        step: 0.5,
        fresh: 'commercial-lock-customization',
        build: (v, _ctx, cur) => [
            post('commercial-lock-customization', {
                enabled: !!cur.enabled,
                min_allowed_temp_in_commercial_lock: v,
                max_allowed_temp_in_commercial_lock: cur.max_allowed_temp_in_commercial_lock,
            }),
        ],
    },
    'settings.commercialLockMax': {
        type: 'number',
        min: 5,
        max: 35,
        step: 0.5,
        fresh: 'commercial-lock-customization',
        build: (v, _ctx, cur) => [
            post('commercial-lock-customization', {
                enabled: !!cur.enabled,
                min_allowed_temp_in_commercial_lock: cur.min_allowed_temp_in_commercial_lock,
                max_allowed_temp_in_commercial_lock: v,
            }),
        ],
    },
    ...pidCommands(),
    'settings.weeklyProgram': {
        type: 'string',
        check: raw => schedule.weeklyFromDevice(schedule.weeklyToDevice(raw).timers),
        build: v => [post('weekly-program', schedule.weeklyToDevice(v))],
    },
    'settings.timers': {
        type: 'string',
        check: raw => schedule.timersFromDevice(schedule.timersToDevice(raw).non_repeatable_timers),
        build: v => [post('non-repeatable-timers', schedule.timersToDevice(v))],
    },
    'settings.vacation': {
        type: 'string',
        check: raw => schedule.vacationFromDevice(schedule.vacationToDevice(raw)),
        build: v => [post('vacation-mode', schedule.vacationToDevice(v))],
    },
    'settings.calibrationOffset': {
        type: 'number',
        min: -10,
        max: 10,
        step: 0.1,
        build: v => [post('temperature-calibration-offset', { value: v })],
    },
    'settings.childLock': { type: 'boolean', build: v => [post('child-lock', { value: v })] },
    'settings.commercialLock': { type: 'boolean', build: v => [post('commercial-lock', { value: v })] },
    'settings.displayUnit': {
        type: 'string',
        states: DISPLAY_UNITS,
        // the device only accepts the spelling of its documentation, "Farenheit" ("Fahrenheit" is acknowledged and ignored)
        build: v => [post('display-unit', { value: v === 'Fahrenheit' ? 'Farenheit' : v })],
    },
    'settings.predictiveHeating': {
        type: 'string',
        states: PREDICTIVE_TYPES,
        build: v => [post('predictive-heating-type', { predictive_heating_type: v })],
    },
    'settings.cloudCommunication': {
        type: 'boolean',
        // takes effect after the next restart of the device
        build: v => [post('cloud-communication', { value: v })],
    },
    'settings.hysteresisUpper': {
        type: 'number',
        min: 0.1,
        max: 5,
        step: 0.1,
        need: 'hysteresis',
        fresh: 'hysteresis-parameters',
        build: (v, _ctx, cur) => [
            post('hysteresis-parameters', {
                temp_hysteresis_upper: v,
                temp_hysteresis_lower: cur.temp_hysteresis_lower,
            }),
        ],
    },
    'settings.hysteresisLower': {
        type: 'number',
        min: 0.1,
        max: 5,
        step: 0.1,
        need: 'hysteresis',
        fresh: 'hysteresis-parameters',
        build: (v, _ctx, cur) => [
            post('hysteresis-parameters', {
                temp_hysteresis_upper: cur.temp_hysteresis_upper,
                temp_hysteresis_lower: v,
            }),
        ],
    },
    'settings.temperatureComfort': {
        type: 'number',
        min: 5,
        max: 35,
        step: 0.5,
        build: v => [post('set-temperature', { type: 'Comfort', value: v })],
    },
    'settings.temperatureSleep': {
        type: 'number',
        min: 5,
        max: 35,
        step: 0.5,
        build: v => [post('set-temperature', { type: 'Sleep', value: v })],
    },
    'settings.temperatureAway': {
        type: 'number',
        min: 5,
        max: 35,
        step: 0.5,
        build: v => [post('set-temperature', { type: 'Away', value: v })],
    },
    'settings.oilHeaterPower': {
        type: 'number',
        states: OIL_POWER_LEVELS,
        need: 'oilPower',
        build: v => [post('oil-heater-power', { heating_level_percentage: v })],
    },
    'settings.limitedHeatingPower': {
        type: 'number',
        min: 10,
        max: 100,
        step: 1,
        need: 'limitedPower',
        build: v => [post('limited-heating-power', { limited_heating_power: v })],
    },
    'settings.additionalSocketMode': {
        type: 'number',
        min: 0,
        max: 4,
        step: 1,
        need: 'socketMode',
        build: v => [post('additional-socket-mode', { additional_mode: v })],
    },
    'settings.openWindowDetection': {
        type: 'boolean',
        fresh: 'open-window',
        build: (v, _ctx, cur) => [post('open-window', openWindowBody(cur, { enabled: v }))],
    },
    'settings.openWindowDropTemperature': {
        type: 'number',
        min: 0.5,
        max: 10,
        step: 0.5,
        fresh: 'open-window',
        build: (v, _ctx, cur) => [post('open-window', openWindowBody(cur, { drop_temperature_threshold: v }))],
    },
    'settings.openWindowDropTime': {
        type: 'number',
        min: 60,
        max: 3600,
        step: 60,
        fresh: 'open-window',
        build: (v, _ctx, cur) => [post('open-window', openWindowBody(cur, { drop_time_range: v }))],
    },
    'settings.openWindowIncreaseTemperature': {
        type: 'number',
        min: 0.5,
        max: 10,
        step: 0.5,
        fresh: 'open-window',
        build: (v, _ctx, cur) => [post('open-window', openWindowBody(cur, { increase_temperature_threshold: v }))],
    },
    'settings.openWindowIncreaseTime': {
        type: 'number',
        min: 60,
        max: 3600,
        step: 60,
        fresh: 'open-window',
        build: (v, _ctx, cur) => [post('open-window', openWindowBody(cur, { increase_time_range: v }))],
    },
    'settings.openWindowMaxTime': {
        type: 'number',
        min: 60,
        max: 86400,
        step: 60,
        fresh: 'open-window',
        build: (v, _ctx, cur) => [post('open-window', openWindowBody(cur, { max_time: v }))],
    },
};

/**
 * PID parameters (panel heaters only). The endpoint wants the complete set.
 *
 * @returns {Record<string, object>} Commands
 */
function pidCommands() {
    const fields = {
        pidKp: ['kp', 0, 10000, 0.01],
        pidKi: ['ki', 0, 100, 0.001],
        pidKd: ['kd', 0, 100000, 1],
        pidKdFilterN: ['kd_filter_N', 0, 1000, 0.1],
        pidWindupLimit: ['windup_limit_percentage', 0, 100, 1],
    };
    const out = {};
    for (const [id, [key, min, max, step]] of Object.entries(fields)) {
        out[`settings.${id}`] = {
            type: 'number',
            min,
            max,
            step,
            need: 'pid',
            fresh: 'pid-parameters',
            build: (v, _ctx, cur) => {
                const body = {};
                for (const [k] of Object.values(fields)) {
                    body[k] = cur[k];
                }
                body[key] = v;
                return [post('pid-parameters', body)];
            },
        };
    }
    return out;
}

/**
 * Validates and normalises a value for a command.
 *
 * @param {string} id State ID below the device
 * @param {unknown} raw Value written by the user
 * @returns {string|number|boolean} Normalised value
 */
function validate(id, raw) {
    const def = COMMANDS[id];
    if (!def) {
        throw new Error('not writable');
    }
    if (def.button) {
        return true;
    }
    if (def.check) {
        // JSON values: validated and normalised by their converter
        return def.check(raw);
    }
    if (def.type === 'boolean') {
        if (typeof raw === 'boolean') {
            return raw;
        }
        if (raw === 1 || raw === 0 || raw === 'true' || raw === 'false') {
            return raw === 1 || raw === 'true';
        }
        throw new Error('value must be true or false');
    }
    if (def.type === 'number') {
        const x = typeof raw === 'string' && raw.trim() !== '' ? Number(raw.replace(',', '.')) : Number(raw);
        if (raw === null || raw === '' || typeof raw === 'boolean' || !Number.isFinite(x)) {
            throw new Error('value must be a number');
        }
        if (def.states) {
            if (!def.states.includes(x)) {
                throw new Error(`allowed values: ${def.states.join(', ')}`);
            }
            return x;
        }
        if (x < def.min || x > def.max) {
            throw new Error(`value must be between ${def.min} and ${def.max}`);
        }
        const step = def.step || 0;
        // snap to the step, avoid binary noise like 17.499999
        const snapped = step ? Math.round(x / step) * step : x;
        return Math.round(snapped * 1000) / 1000;
    }
    // string
    let s = typeof raw === 'string' ? raw : raw === null || raw === undefined ? '' : String(raw);
    if (def.states) {
        // device reports "OFF", the documentation writes "Off"
        const hit = def.states.find(st => st.toLowerCase() === s.trim().toLowerCase());
        if (!hit) {
            throw new Error(`allowed values: ${def.states.join(', ')}`);
        }
        return hit;
    }
    s = s.trim();
    if (!s || (def.maxLength && s.length > def.maxLength)) {
        throw new Error(`text must have 1 to ${def.maxLength} characters`);
    }
    return s;
}

/**
 * Executes a command: validates, reads fresh parameters if needed and sends the request(s).
 *
 * @param {{get: (path: string, body?: object) => Promise<object>, post: (path: string, body?: object) => Promise<object>}} client Mill client
 * @param {string} id State ID below the device
 * @param {unknown} raw Value
 * @param {{mode?: string, lastActiveMode?: string, kind?: string, normal?: number}} ctx Current device context
 * @returns {Promise<string|number|boolean>} The value that was sent
 */
async function execute(client, id, raw, ctx) {
    const v = validate(id, raw);
    const def = COMMANDS[id];
    const cur = def.fresh ? await client.get(def.fresh) : undefined;
    for (const r of def.build(v, ctx, cur)) {
        try {
            await client.post(r.path, r.body);
        } catch (err) {
            if (!(def.noAnswer && err && (err.code === 'TIMEOUT' || err.code === 'NETWORK'))) {
                throw err;
            }
        }
    }
    return v;
}

/**
 * Object properties derived from the command table (write flag, limits, states).
 *
 * @param {string} id State ID below the device
 * @param {boolean} allowWrite Control enabled in the instance settings
 * @returns {object} Partial common
 */
function commonFor(id, allowWrite) {
    const def = COMMANDS[id];
    if (!def) {
        return {};
    }
    const c = { write: !!allowWrite };
    if (def.button) {
        return c;
    }
    if (def.type === 'number' && !def.states) {
        Object.assign(c, { min: def.min, max: def.max, step: def.step });
    }
    if (def.states) {
        c.states = Object.fromEntries(def.states.map(s => [s, def.type === 'number' ? `${s} %` : s]));
    }
    return c;
}

module.exports = { COMMANDS, validate, execute, commonFor, DISPLAY_UNITS, SWITCH_MODE, RELAY_ON, RELAY_OFF };
