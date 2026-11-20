'use strict';

/*
 * Simulated Mill Generation 3 device for the tests and for a demo instance (test/simulator.js).
 *
 * Modelled on a real Wi-Fi Socket Gen 3 (firmware 0x230421) and the official API description
 * (github.com/Mill-International-AS/Generation_3_REST_API). Behaviour verified on the real socket:
 * - POST /operation-mode acknowledges ANY value with "ok" and switches the device OFF for an unknown one
 * - the device reports the off mode as "OFF"; set_temperature is 0 while off
 * - set-temperature-in-independent-mode-now 99 / 0 forces the relay (control signal 100 % / 0 %)
 * - /reboot never answers, the device is gone for a few seconds
 * - display unit only in the spelling "Farenheit"; 404 answers are plain text
 * - switched_on stayed false on the socket while its relay was closed
 * - weekly program and timers only run with a valid time (NTP after the start)
 *
 * NOT verified (no such device available): the model names of the oil and convection heaters (assumed;
 * the panel name is the example of the documentation), their nominal power, and the exact controller.
 * The simulated controller is a plain hysteresis around the active target temperature.
 */
const http = require('node:http');

const KINDS = {
    socket: {
        name: 'Mill HeaterGen3Socket',
        nominalW: 1000,
        humidity: true,
        missing: ['oil-heater-power', 'limited-heating-power', 'pid-parameters'],
    },
    // example name of the API documentation
    panel: {
        name: 'panel heater gen. 3',
        nominalW: 800,
        humidity: false,
        missing: ['oil-heater-power', 'additional-socket-mode'],
    },
    // assumed name
    oil: {
        name: 'Mill OilHeaterGen3',
        nominalW: 1500,
        humidity: false,
        missing: ['limited-heating-power', 'pid-parameters', 'additional-socket-mode'],
    },
    // assumed name
    convection: {
        name: 'Mill ConvectionHeaterGen3',
        nominalW: 1200,
        humidity: false,
        missing: ['oil-heater-power', 'limited-heating-power', 'pid-parameters', 'additional-socket-mode'],
    },
};

/** Operation modes the device knows; everything else switches it off (the trap) */
const DEVICE_MODES = ['Control individually', 'Weekly program', 'Independent device'];

/**
 * Local minutes since 1970 ("local unix timestamp" of the device).
 *
 * @param {number} ms Real time in ms
 * @param {number} offsetMin Time zone offset of the device in minutes (1440 = not set -> UTC)
 * @returns {number} Local minutes
 */
const localMinutes = (ms, offsetMin) => Math.floor(ms / 60000) + (offsetMin === 1440 ? 0 : offsetMin);

/**
 * @param {number} localMin Local minutes since 1970
 * @returns {number} Minutes since Monday 00:00
 */
const minuteOfWeek = localMin => {
    // 1970-01-01 was a Thursday = day 3 when Monday is day 0
    const day = (Math.floor(localMin / 1440) + 3) % 7;
    return day * 1440 + (localMin % 1440);
};

/**
 * @param {object} [opts] Options
 * @param {'socket'|'panel'|'oil'|'convection'} [opts.kind] Device kind (default socket)
 * @param {string} [opts.name] Model name (default by kind)
 * @param {string} [opts.customName] Name set by the user
 * @param {string} [opts.mac] MAC address
 * @param {string[]} [opts.missing] Endpoints answering 404 (default by kind)
 * @param {number} [opts.nominalW] Nominal power in W
 * @param {number} [opts.delayMs] Answer delay
 * @param {number} [opts.port] Port (default: any free one)
 * @param {string} [opts.bind] Address to listen on (default 127.0.0.1)
 * @param {boolean} [opts.physics] Room temperature follows heating and losses (demo)
 * @param {number} [opts.tickMs] Step of the physics (default 1000 ms)
 * @param {number} [opts.rebootMs] How long the device is gone after /reboot (default 3000 ms)
 * @param {() => number} [opts.now] Clock in ms (default Date.now plus state.clockShiftMs)
 */
function createFakeMill(opts = {}) {
    const kindName = opts.kind && KINDS[opts.kind] ? opts.kind : 'socket';
    const kind = KINDS[kindName];
    const state = {
        kind: kindName,
        name: opts.name || kind.name,
        mac: opts.mac || '94:E6:86:00:00:01',
        nominalW: opts.nominalW || kind.nominalW,
        mode: 'Control individually',
        temps: { Normal: 20, Comfort: 22, Sleep: 18, Away: 15 },
        childLock: false,
        commercialLock: false,
        calibration: -1.5,
        unit: 'Celsius',
        predictive: 'Off',
        cloud: false,
        hysteresis: { temp_hysteresis_upper: 0.5, temp_hysteresis_lower: 0.5 },
        socketMode: 0,
        oilPower: 100,
        limitedPower: 75,
        pid: { kp: 70, ki: 0.02, kd: 4500, kd_filter_N: 24, windup_limit_percentage: 75 },
        customName: opts.customName || 'Test',
        forced: null,
        weekly: [],
        oneOff: [],
        vacation: { start_timestamp: 0, end_timestamp: 0 },
        timezone: 1440,
        regulator: kindName === 'panel' ? 'pid' : 'hysteresis_or_slow_pid',
        commercialLimits: {
            enabled: false,
            min_allowed_temp_in_commercial_lock: 16,
            max_allowed_temp_in_commercial_lock: 26,
        },
        openWindow: {
            active_now: false,
            drop_temperature_threshold: 5,
            drop_time_range: 900,
            enabled: false,
            increase_temperature_threshold: 3,
            increase_time_range: 900,
            max_time: 3600,
        },
        /** Fault text of /status (operation_key), '' = none */
        operationKey: '',
        /** The window is open right now (counts only while the detection is enabled) */
        windowOpen: false,
        /** Heating power in W set by a test (null = from the control signal) */
        power: null,
        requests: [],
        ambient: 19.200632095336914,
        humidity: 61.00390625,
        /** Temperature the room cools down to (physics) */
        outside: 8,
        /** Shift of the device clock in ms (moves the weekly program without waiting) */
        clockShiftMs: 0,
        /** The device got its time via NTP; without it weekly program, timers and vacation do nothing */
        timeValid: true,
        /**
         * Answer of /control-status: valid, invalid-json, empty, api-error, http-error, not-mill,
         * hang (accepts and never answers)
         */
        responseMode: 'valid',
        /** Every connection is reset at once (device out of the Wi-Fi or unplugged) */
        offline: false,
        /** Extra answer delay per endpoint in ms */
        delays: {},
        concurrent: 0,
        maxConcurrent: 0,
        reboots: 0,
        hanging: [],
    };
    const now = opts.now || (() => Date.now() + state.clockShiftMs);
    const missing = new Set(opts.missing || kind.missing);
    const lm = () => localMinutes(now(), state.timezone);

    /** @returns {string} Type of the running weekly program period, '' if none */
    const weeklyType = () => {
        if (!state.timeValid || !Array.isArray(state.weekly) || !state.weekly.length) {
            return '';
        }
        const mow = minuteOfWeek(lm());
        const sorted = [...state.weekly].sort((a, b) => a.timestamp - b.timestamp);
        // the last entry before now; before the first entry of the week the last one of the week runs on
        const hit = sorted.filter(t => t.timestamp <= mow).pop() || sorted[sorted.length - 1];
        return hit.name;
    };
    /** @returns {string} Type of the last one-off timer that has passed, '' if none */
    const timerType = () => {
        if (!state.timeValid || !Array.isArray(state.oneOff) || !state.oneOff.length) {
            return '';
        }
        const t = lm();
        const hit = [...state.oneOff]
            .sort((a, b) => a.timestamp - b.timestamp)
            .filter(x => x.timestamp <= t)
            .pop();
        return hit ? hit.name : '';
    };
    const vacationActive = () => {
        const v = state.vacation;
        if (!state.timeValid || !v.start_timestamp) {
            return false;
        }
        const t = lm();
        return t >= v.start_timestamp && t < v.end_timestamp;
    };

    /**
     * What the device regulates to right now.
     *
     * @returns {{target: number, forced: boolean, period: string}} target 0 = off, 99 = heat permanently
     */
    const regulation = () => {
        if (state.mode === 'OFF') {
            return { target: 0, forced: true, period: 'Off' };
        }
        const typed = t => {
            if (t === 'Off') {
                return { target: 0, forced: true, period: t };
            }
            if (t === 'AlwaysHeating') {
                return { target: 99, forced: true, period: t };
            }
            return { target: state.temps[t] ?? state.temps.Normal, forced: false, period: t || 'Normal' };
        };
        if (state.mode === 'Independent device') {
            if (state.forced !== null) {
                return { target: state.forced, forced: true, period: 'forced' };
            }
            return typed(timerType() || 'Normal');
        }
        if (state.mode === 'Weekly program') {
            if (vacationActive()) {
                return typed('Away');
            }
            // without a valid time (or with an empty program) the device stays on Normal
            return typed(weeklyType() || 'Normal');
        }
        return typed('Normal');
    };

    let relay = false;
    /** @returns {number} Control signal in % (hysteresis controller) */
    const controlSignal = () => {
        const r = regulation();
        if (state.windowOpen && state.openWindow.enabled) {
            return 0;
        }
        if (r.forced) {
            relay = r.target >= 99;
        } else if (state.ambient < r.target - state.hysteresis.temp_hysteresis_lower) {
            relay = true;
        } else if (state.ambient > r.target + state.hysteresis.temp_hysteresis_upper) {
            relay = false;
        }
        return relay ? 100 : 0;
    };
    const powerShare = () =>
        kindName === 'oil' ? state.oilPower / 100 : kindName === 'panel' ? state.limitedPower / 100 : 1;
    const currentPower = () => {
        if (state.power !== null) {
            return state.power;
        }
        return controlSignal() > 0 ? Math.round(state.nominalW * powerShare() * 10) / 10 : 0;
    };

    // physics of the demo: heating warms the room, losses cool it towards the outside temperature
    let tick = null;
    if (opts.physics) {
        const dt = (opts.tickMs || 1000) / 1000;
        tick = setInterval(() => {
            const p = currentPower();
            const window = state.windowOpen ? 0.004 : 0;
            state.ambient += dt * ((p / 1000) * 0.004 - (state.ambient - state.outside) * (0.0002 + window));
            state.humidity = Math.min(70, Math.max(35, state.humidity + (Math.random() - 0.5) * 0.05));
        }, opts.tickMs || 1000);
        tick.unref();
    }

    const server = http.createServer((req, res) => {
        if (state.offline) {
            req.socket.destroy();
            return;
        }
        let body = '';
        req.on('data', c => (body += c));
        req.on('end', () => {
            state.concurrent++;
            state.maxConcurrent = Math.max(state.maxConcurrent, state.concurrent);
            const path = req.url.replace(/^\//, '');
            state.requests.push({ method: req.method, path, body, auth: req.headers.authentication });
            if (state.requests.length > 5000) {
                state.requests.splice(0, 1000);
            }
            const send = (code, obj) => {
                setTimeout(
                    () => {
                        state.concurrent--;
                        if (state.offline) {
                            req.socket.destroy();
                            return;
                        }
                        if (typeof obj === 'string') {
                            // a string with 200 is a raw (possibly broken) JSON answer, otherwise plain text
                            res.writeHead(code, { 'Content-Type': code === 200 ? 'application/json' : 'text/html' });
                            res.end(obj);
                            return;
                        }
                        res.writeHead(code, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ...obj, status: obj.status || 'ok' }, null, '\t'));
                    },
                    (opts.delayMs || 0) + (state.delays[path] || 0),
                );
            };
            if (missing.has(path)) {
                return send(404, 'This URI does not exist');
            }
            let json = {};
            if (body) {
                try {
                    json = JSON.parse(body);
                } catch {
                    return send(400, { status: 'Failed to parse message body' });
                }
            }
            const get = req.method === 'GET';
            switch (path) {
                case 'status':
                    return send(200, {
                        name: state.name,
                        custom_name: state.customName,
                        version: '0x230421',
                        operation_key: state.operationKey,
                        mac_address: state.mac,
                    });
                case 'control-status': {
                    switch (state.responseMode) {
                        case 'invalid-json':
                            return send(200, '{"ambient_temperature": 5, "operation_mode": ');
                        case 'empty':
                            return send(200, '');
                        case 'api-error':
                            return send(200, { status: 'Failed to read the sensors' });
                        case 'http-error':
                            return send(500, 'Internal error');
                        case 'not-mill':
                            return send(200, { hello: 'world' });
                        case 'hang':
                            // accepts the request and never answers
                            state.concurrent--;
                            state.hanging.push(res);
                            return undefined;
                    }
                    const r = regulation();
                    const signal = controlSignal();
                    const locks = [state.childLock && 'Child lock', state.commercialLock && 'Commercial lock'].filter(
                        Boolean,
                    );
                    const ow = state.openWindow.enabled
                        ? state.windowOpen
                            ? 'Enabled active now'
                            : 'Enabled not active now'
                        : 'Disabled not active now';
                    return send(200, {
                        ambient_temperature: state.ambient,
                        ...(kind.humidity ? { humidity: state.humidity } : {}),
                        current_power: currentPower(),
                        control_signal: signal,
                        lock_active: locks.length ? locks.join(', ') : 'No lock',
                        open_window_active_now: ow,
                        raw_ambient_temperature: state.ambient - state.calibration,
                        set_temperature: r.target,
                        switched_on: kindName === 'socket' ? false : signal > 0,
                        connected_to_cloud: false,
                        operation_mode: state.mode,
                    });
                }
                case 'operation-mode':
                    if (get) {
                        return send(200, { mode: state.mode });
                    }
                    // like the real device: unknown modes are acknowledged and switch the device off
                    state.mode = DEVICE_MODES.includes(json.mode) ? json.mode : 'OFF';
                    state.forced = null;
                    return send(200, {});
                case 'set-temperature':
                    if (get) {
                        return send(200, { value: state.temps[json.type] ?? 0 });
                    }
                    state.temps[json.type] = json.value;
                    return send(200, {});
                case 'child-lock':
                    if (!get) {
                        state.childLock = !!json.value;
                    }
                    return send(200, get ? { value: state.childLock } : {});
                case 'open-window':
                    if (!get) {
                        state.openWindow = { ...state.openWindow, ...json };
                    }
                    return send(
                        200,
                        get ? { ...state.openWindow, active_now: state.windowOpen && state.openWindow.enabled } : {},
                    );
                case 'set-temperature-in-independent-mode-now':
                    state.forced = json.temperature >= 99 || json.temperature <= 0 ? json.temperature : null;
                    return send(200, {});
                case 'reboot':
                    // like the real device: restarts without answering and is gone for a moment
                    req.socket.destroy();
                    state.concurrent--;
                    state.reboots++;
                    state.offline = true;
                    setTimeout(() => (state.offline = false), opts.rebootMs ?? 3000).unref();
                    return undefined;
                case 'timezone-offset':
                    if (!get) {
                        state.timezone = json.timezone_offset;
                    }
                    return send(200, get ? { timezone_offset: state.timezone } : {});
                case 'commercial-lock-customization':
                    if (!get) {
                        state.commercialLimits = { ...json };
                    }
                    return send(200, get ? state.commercialLimits : {});
                case 'temperature-calibration-offset':
                    if (!get) {
                        state.calibration = json.value;
                    }
                    return send(200, get ? { value: state.calibration } : {});
                case 'commercial-lock':
                    if (!get) {
                        state.commercialLock = !!json.value;
                    }
                    return send(200, get ? { value: state.commercialLock } : {});
                case 'display-unit':
                    if (!get && ['Celsius', 'Farenheit'].includes(json.value)) {
                        state.unit = json.value;
                    }
                    return send(200, get ? { value: state.unit } : {});
                case 'predictive-heating-type':
                    if (!get) {
                        state.predictive = json.predictive_heating_type;
                    }
                    return send(200, get ? { predictive_heating_type: state.predictive } : {});
                case 'set-custom-name':
                    state.customName = json.device_name;
                    return send(200, {});
                case 'controller-type':
                    if (!get) {
                        state.regulator = json.regulator_type;
                    }
                    return send(200, get ? { regulator_type: state.regulator } : {});
                case 'hysteresis-parameters':
                    if (!get) {
                        state.hysteresis = { ...json };
                    }
                    return send(200, get ? { ...state.hysteresis, regulator_type: 'hysteresis' } : {});
                case 'pid-parameters':
                    if (!get) {
                        state.pid = { ...state.pid, ...json };
                    }
                    return send(200, get ? state.pid : {});
                case 'cloud-communication':
                    if (!get) {
                        state.cloud = !!json.value;
                    }
                    return send(200, get ? { value: state.cloud } : {});
                case 'weekly-program':
                    if (!get) {
                        state.weekly = json.timers;
                    }
                    return send(200, get ? { timers: state.weekly, active: state.mode === 'Weekly program' } : {});
                case 'non-repeatable-timers':
                    if (!get) {
                        state.oneOff = json.non_repeatable_timers;
                    }
                    return send(
                        200,
                        get ? { non_repeatable_timers: state.oneOff, active: state.mode === 'Independent device' } : {},
                    );
                case 'vacation-mode':
                    if (!get) {
                        state.vacation = { start_timestamp: json.start_timestamp, end_timestamp: json.end_timestamp };
                    }
                    return send(200, get ? state.vacation : {});
                case 'additional-socket-mode':
                    if (!get) {
                        state.socketMode = json.additional_mode;
                    }
                    return send(200, get ? { additional_mode: state.socketMode } : {});
                case 'oil-heater-power':
                    if (!get) {
                        state.oilPower = Number(json.heating_level_percentage);
                    }
                    // the documented example answer uses "value"
                    return send(200, get ? { value: state.oilPower } : {});
                case 'limited-heating-power':
                    if (!get) {
                        state.limitedPower = Number(json.limited_heating_power);
                    }
                    return send(200, get ? { limited_heating_power: state.limitedPower } : {});
                default:
                    return send(404, 'This URI does not exist');
            }
        });
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(opts.port || 0, opts.bind || '127.0.0.1', () => {
            const bind = opts.bind && opts.bind !== '0.0.0.0' ? opts.bind : '127.0.0.1';
            resolve({
                server,
                state,
                regulation,
                host: `${bind}:${server.address().port}`,
                close: () =>
                    new Promise(r => {
                        if (tick) {
                            clearInterval(tick);
                        }
                        for (const h of state.hanging) {
                            h.destroy();
                        }
                        server.closeAllConnections();
                        server.close(() => r());
                    }),
            });
        });
    });
}

module.exports = { createFakeMill, KINDS, minuteOfWeek, localMinutes };
