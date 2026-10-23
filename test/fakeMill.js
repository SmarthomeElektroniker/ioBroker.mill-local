'use strict';

// Simulated Mill Generation 3 device, modelled on a real Wi-Fi Socket Gen 3 (firmware 0x230421).
const http = require('node:http');

/**
 * @param {object} [opts] Options
 * @param {string} [opts.name] Model name
 * @param {string} [opts.mac] MAC address
 * @param {string[]} [opts.missing] Endpoints answering 404
 * @param {number} [opts.delayMs] Answer delay
 */
function createFakeMill(opts = {}) {
    const state = {
        name: opts.name || 'Mill HeaterGen3Socket',
        mac: opts.mac || '94:E6:86:00:00:01',
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
        customName: 'Test',
        forced: null,
        weekly: [],
        oneOff: [],
        vacation: { start_timestamp: 0, end_timestamp: 0 },
        timezone: 1440,
        regulator: 'hysteresis_or_slow_pid',
        commercialLimits: { enabled: false, min_allowed_temp_in_commercial_lock: 16, max_allowed_temp_in_commercial_lock: 26 },
        openWindow: { active_now: false, drop_temperature_threshold: 5, drop_time_range: 900, enabled: false, increase_temperature_threshold: 3, increase_time_range: 900, max_time: 3600 },
        power: 0,
        requests: [],
        concurrent: 0,
        maxConcurrent: 0,
    };
    const missing = new Set(opts.missing || ['oil-heater-power', 'limited-heating-power', 'pid-parameters']);
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => (body += c));
        req.on('end', () => {
            state.concurrent++;
            state.maxConcurrent = Math.max(state.maxConcurrent, state.concurrent);
            const path = req.url.replace(/^\//, '');
            state.requests.push({ method: req.method, path, body, auth: req.headers.authentication });
            const send = (code, obj) => {
                setTimeout(() => {
                    state.concurrent--;
                    if (typeof obj === 'string') {
                        res.writeHead(code, { 'Content-Type': 'text/html' });
                        res.end(obj);
                    } else {
                        res.writeHead(code, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ...obj, status: obj.status || 'ok' }, null, '\t'));
                    }
                }, opts.delayMs || 0);
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
                    return send(200, { name: state.name, custom_name: state.customName, version: '0x230421', operation_key: '', mac_address: state.mac });
                case 'control-status':
                    return send(200, {
                        ambient_temperature: 19.200632095336914,
                        humidity: 61.00390625,
                        current_power: state.power,
                        control_signal: state.mode === 'Independent device' && state.forced !== null ? (state.forced >= 99 ? 100 : 0) : state.power ? 100 : 0,
                        lock_active: state.childLock ? 'Child lock' : 'No lock',
                        open_window_active_now: state.openWindow.enabled ? 'Enabled not active now' : 'Disabled not active now',
                        raw_ambient_temperature: 21.700632095336914,
                        set_temperature: state.mode === 'OFF' ? 0 : state.mode === 'Independent device' && state.forced !== null ? state.forced : state.temps.Normal,
                        switched_on: state.power > 0,
                        connected_to_cloud: false,
                        operation_mode: state.mode,
                    });
                case 'operation-mode':
                    if (get) {
                        return send(200, { mode: state.mode });
                    }
                    // like the real device: unknown modes are acknowledged and switch the device off
                    state.mode = ['Control individually', 'Weekly program', 'Independent device'].includes(json.mode) ? json.mode : 'OFF';
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
                    return send(200, get ? state.openWindow : {});
                case 'set-temperature-in-independent-mode-now':
                    state.forced = json.temperature >= 99 || json.temperature <= 0 ? json.temperature : null;
                    return send(200, {});
                case 'reboot':
                    // like the real device: restarts without answering
                    req.socket.destroy();
                    state.concurrent--;
                    state.reboots = (state.reboots || 0) + 1;
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
                    // like the real device: only "Celsius" and the misspelt "Farenheit" are taken
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
                    return send(200, get ? { non_repeatable_timers: state.oneOff, active: state.mode === 'Independent device' } : {});
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
                    return send(200, { value: 100 });
                case 'limited-heating-power':
                    return send(200, { limited_heating_power: 75 });
                default:
                    return send(404, 'This URI does not exist');
            }
        });
    });
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, state, host: `127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) });
        });
    });
}

module.exports = { createFakeMill };
