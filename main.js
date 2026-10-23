'use strict';

/*
 * ioBroker adapter for Mill Generation 3 heaters and sockets via their local REST API.
 * No cloud: the adapter talks to the devices directly over HTTP (HTTPS with API key).
 */

const utils = require('@iobroker/adapter-core');
const { MillClient } = require('./lib/api');
const model = require('./lib/model');
const { CHANNELS, definitionsFor } = require('./lib/states');
const commands = require('./lib/commands');
const { EnergyCounter, dayKey } = require('./lib/energy');
const discovery = require('./lib/discovery');
const schedule = require('./lib/schedule');

/** Offline after this many failed polls in a row */
const FAILS_UNTIL_OFFLINE = 3;
/**
 * The documentation spells the unit "Farenheit" in its examples; the adapter uses "Fahrenheit".
 *
 * @param {unknown} x Reported unit
 * @returns {string} Celsius or Fahrenheit
 */
function normaliseUnit(x) {
    return /^fa/i.test(String(x)) ? 'Fahrenheit' : String(x);
}

/** Minimum pause between two re-discovery scans for the same device */
const REDISCOVER_PAUSE_MS = 30 * 60 * 1000;

/**
 * Runtime data of one configured device.
 */
class Device {
    /**
     * @param {{ip: string, name?: string, mac?: string, useApiKey?: boolean}} cfg Row of the device table
     * @param {string} apiKey Instance-wide API key
     * @param {number} timeoutMs Request timeout
     * @param {{setTimeout: (cb: () => void, ms: number) => unknown, clearTimeout: (t: unknown) => void}} timer Adapter timers
     */
    constructor(cfg, apiKey, timeoutMs, timer) {
        this.timerApi = timer;
        this.cfg = cfg;
        this.ip = String(cfg.ip || '').trim();
        this.id = model.macId(cfg.mac);
        this.client = new MillClient({ host: this.ip, timeoutMs, apiKey: cfg.useApiKey ? apiKey : '', timer });
        this.timeoutMs = timeoutMs;
        this.apiKey = cfg.useApiKey ? apiKey : '';
        this.caps = {};
        this.kind = model.KIND.UNKNOWN;
        this.ready = false;
        this.online = false;
        this.fails = 0;
        this.cycle = 0;
        this.mode = '';
        this.lastActiveMode = 'Control individually';
        this.lastRediscover = 0;
        this.wrongDeviceLogged = false;
        this.offlineLogged = false;
        this.energy = null;
        this.timer = null;
        this.polling = false;
        /** Incremented by every command; readings started before a command are not mirrored */
        this.writeSeq = 0;
        this.refreshPending = false;
        /** IDs whose state must be rewritten even if unchanged (after a failed command) */
        this.forceIds = new Set();
    }

    /** @param {string} ip New address */
    setIp(ip) {
        this.ip = ip;
        this.client = new MillClient({
            host: ip,
            timeoutMs: this.timeoutMs,
            apiKey: this.apiKey,
            timer: this.timerApi,
        });
    }
}

class MillLocal extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options] Adapter options
     */
    constructor(options) {
        super({ ...options, name: 'mill-local' });
        this.devices = [];
        this.unloading = false;
        /** Adapter timers for the libraries (repository checker E5005) */
        this.timerApi = {
            setTimeout: (cb, ms) => this.setTimeout(cb, ms),
            clearTimeout: t => this.clearTimeout(t),
        };
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        await this.setState('info.connection', false, true);
        const cfg = this.config;
        // same limits as the admin UI, enforced here as well (the instance object can be edited directly)
        this.pollMs = model.intervalMs(cfg.pollInterval, 30, 10, 3600);
        this.slowEvery = Math.max(1, Math.round(model.intervalMs(cfg.slowInterval, 600, 60, 86400) / this.pollMs));
        this.timeoutMs = model.intervalMs(cfg.timeout, 5, 1, 30);
        this.allowControl = cfg.allowControl !== false;

        const rows = Array.isArray(cfg.devices) ? cfg.devices : [];
        const seen = new Set();
        for (const row of rows) {
            if (!row || row.enabled === false || !String(row.ip || '').trim()) {
                continue;
            }
            const key = String(row.ip).trim();
            if (seen.has(key)) {
                this.log.warn(`Device ${key} is listed twice - ignoring the second entry`);
                continue;
            }
            seen.add(key);
            this.devices.push(new Device(row, cfg.apiKey || '', this.timeoutMs, this.timerApi));
        }

        if (!this.devices.length) {
            this.log.warn(
                'No device configured. Enter the IP addresses in the instance settings or use "Search devices".',
            );
            return;
        }
        this.log.info(
            `Starting with ${this.devices.length} device(s), polling every ${this.pollMs / 1000} s, control ${
                this.allowControl ? 'enabled' : 'disabled'
            }`,
        );
        await this.removeStaleDevices(rows);
        for (const id of Object.keys(commands.COMMANDS)) {
            this.subscribeStates(`*.${id}`);
        }
        this.subscribeStates('*.refresh');

        // Stagger the start so several devices are not hit at the same moment
        this.devices.forEach((dev, i) => this.schedule(dev, 500 + i * 700));
    }

    /**
     * Deletes device objects whose MAC is no longer in the device table at all.
     *
     * @param {Array<{mac?: string}>} rows Device table (also disabled rows count)
     */
    async removeStaleDevices(rows) {
        const keep = new Set(rows.map(r => model.macId(r && r.mac)).filter(Boolean));
        // devices configured without MAC: their objects are only known by IP - keep everything that matches
        const ipOnly = new Set(rows.filter(r => r && !model.macId(r.mac)).map(r => String(r.ip || '').trim()));
        const objs = await this.getForeignObjectsAsync(`${this.namespace}.*`, 'device');
        for (const o of Object.values(objs || {})) {
            const id = o._id.slice(this.namespace.length + 1);
            if (!id || id.includes('.')) {
                continue;
            }
            if (keep.has(id)) {
                continue;
            }
            const ipState = await this.getStateAsync(`${id}.info.ip`);
            if (ipState && ipOnly.has(String(ipState.val))) {
                continue;
            }
            this.log.info(`Removing objects of device ${id}, it is no longer configured`);
            await this.delObjectAsync(id, { recursive: true });
        }
    }

    /**
     * @param {Device} dev Device
     * @param {number} ms Delay
     */
    schedule(dev, ms) {
        if (this.unloading) {
            return;
        }
        if (dev.timer) {
            this.clearTimeout(dev.timer);
        }
        dev.timer = this.setTimeout(() => {
            dev.timer = null;
            this.poll(dev).finally(() => this.schedule(dev, this.pollMs));
        }, ms);
    }

    /**
     * One polling cycle of a device.
     *
     * @param {Device} dev Device
     * @param {boolean} [forceSlow] Also read the settings
     */
    async poll(dev, forceSlow = false) {
        if (dev.polling || this.unloading) {
            return;
        }
        dev.polling = true;
        try {
            if (!dev.ready) {
                await this.initDevice(dev);
                if (!dev.ready) {
                    return;
                }
                forceSlow = true;
            }
            await this.pollFast(dev);
            if (forceSlow || dev.cycle % this.slowEvery === 0) {
                await this.pollSlow(dev);
            }
            dev.cycle++;
            await this.markOnline(dev, true);
        } catch (err) {
            await this.handleFailure(dev, err);
        } finally {
            dev.polling = false;
        }
        if (dev.refreshPending && !this.unloading) {
            // a command arrived while this cycle was running - read the device again
            dev.refreshPending = false;
            await this.poll(dev, true);
        }
    }

    /**
     * Requests a full read of a device, now or right after the running cycle.
     *
     * @param {Device} dev Device
     */
    async refreshAfterCommand(dev) {
        if (dev.polling) {
            dev.refreshPending = true;
            return;
        }
        await this.poll(dev, true);
    }

    /**
     * Reads /status, determines the device kind and capabilities and creates the objects.
     *
     * @param {Device} dev Device
     */
    async initDevice(dev) {
        let st;
        try {
            st = await dev.client.get('status');
        } catch (err) {
            await this.handleFailure(dev, err);
            return;
        }
        const mac = model.macId(st.mac_address);
        if (!model.isMillStatus(st) || !mac) {
            if (!dev.wrongDeviceLogged) {
                this.log.warn(`${dev.ip} answers, but not like a Mill Generation 3 device`);
                dev.wrongDeviceLogged = true;
            }
            await this.handleFailure(dev, new Error('not a Mill device'));
            return;
        }
        if (dev.id && dev.id !== mac) {
            if (!dev.wrongDeviceLogged) {
                this.log.warn(
                    `${dev.ip} is now a different Mill device (${mac} instead of ${dev.id}) - the address probably changed`,
                );
                dev.wrongDeviceLogged = true;
            }
            await this.handleFailure(dev, new Error('different device at this address'));
            return;
        }
        dev.wrongDeviceLogged = false;
        dev.id = mac;

        // probe optional endpoints; 404 = not supported by this kind/firmware
        const probe = async path => {
            try {
                await dev.client.get(path);
                return true;
            } catch (err) {
                if (err && err.httpStatus === 404) {
                    return false;
                }
                throw err;
            }
        };
        const control = await dev.client.get('control-status');
        dev.caps = {
            humidity: control.humidity !== undefined,
            oilPower: await probe('oil-heater-power'),
            limitedPower: await probe('limited-heating-power'),
            socketMode: await probe('additional-socket-mode'),
            pid: await probe('pid-parameters'),
            hysteresis: await probe('hysteresis-parameters'),
        };
        dev.kind = model.refineKind(model.kindFromName(st.name), dev.caps);

        await this.createObjects(dev, st);
        await this.restoreEnergy(dev);
        await this.setVal(dev, 'info.model', st.name);
        await this.setVal(dev, 'info.customName', st.custom_name || '');
        await this.setVal(dev, 'info.type', dev.kind);
        await this.setVal(dev, 'info.firmware', st.version);
        await this.setVal(dev, 'info.mac', mac);
        await this.setVal(dev, 'info.ip', dev.ip);
        await this.setVal(dev, 'info.operationKey', st.operation_key || '');
        dev.ready = true;
        this.log.info(
            `Connected to ${st.custom_name || st.name} (${dev.kind}, ${st.version}) at ${dev.ip}, ID ${mac}${
                dev.cfg.mac ? '' : ' - tip: add the MAC to the device table so the adapter can follow address changes'
            }`,
        );
    }

    /**
     * @param {Device} dev Device
     * @param {unknown} st Answer of /status
     */
    async createObjects(dev, st) {
        const label = dev.cfg.name || st.custom_name || st.name || dev.id;
        await this.extendObjectAsync(dev.id, {
            type: 'device',
            common: { name: label, statusStates: { onlineId: `${this.namespace}.${dev.id}.info.online` } },
            native: { mac: dev.id, model: st.name, kind: dev.kind },
        });
        const defs = definitionsFor(dev.caps, this.allowControl);
        for (const [ch, name] of Object.entries(CHANNELS)) {
            await this.extendObjectAsync(`${dev.id}.${ch}`, { type: 'channel', common: { name }, native: {} });
        }
        for (const d of defs) {
            await this.extendObjectAsync(`${dev.id}.${d.id}`, { type: 'state', common: d.common, native: {} });
        }
        await this.removeObsoleteStates(dev, new Set(defs.map(d => d.id)));
    }

    /**
     * Deletes states of a device that are no longer part of the object model (older versions
     * kept some values twice, e.g. status.operationMode next to control.operationMode).
     *
     * @param {Device} dev Device
     * @param {Set<string>} keep IDs below the device that are defined
     */
    async removeObsoleteStates(dev, keep) {
        const prefix = `${this.namespace}.${dev.id}.`;
        const objs = await this.getForeignObjectsAsync(`${prefix}*`, 'state');
        for (const id of Object.keys(objs || {})) {
            const rel = id.slice(prefix.length);
            if (!keep.has(rel)) {
                this.log.info(`Removing obsolete state ${dev.id}.${rel}`);
                await this.delObjectAsync(`${dev.id}.${rel}`);
            }
        }
    }

    /**
     * Restores the energy counters from the states.
     *
     * @param {Device} dev Device
     */
    async restoreEnergy(dev) {
        const get = async id => {
            const s = await this.getStateAsync(`${dev.id}.energy.${id}`);
            return s || null;
        };
        const total = await get('total');
        const today = await get('today');
        const yesterday = await get('yesterday');
        dev.energy = new EnergyCounter(
            {
                totalKwh: total ? Number(total.val) : 0,
                todayKwh: today ? Number(today.val) : 0,
                yesterdayKwh: yesterday ? Number(yesterday.val) : 0,
                day: today && today.ts ? dayKey(today.ts) : '',
            },
            Math.max(3 * this.pollMs, 120000),
        );
    }

    /**
     * Frequently changing values: /control-status.
     *
     * @param {Device} dev Device
     */
    async pollFast(dev) {
        const seq = dev.writeSeq;
        const c = await dev.client.get('control-status');
        const normal = await dev.client.get('set-temperature', { type: 'Normal' });
        const now = Date.now();
        const signal = model.round(c.control_signal, 1) ?? 0;
        let mode = model.normaliseMode(c.operation_mode);
        // "Switch" = Independent device with the relay forced via 99 / 0 (no temperature control)
        const forced = Number(c.set_temperature);
        if (mode === 'Independent device' && (forced >= commands.RELAY_ON || forced <= commands.RELAY_OFF)) {
            mode = commands.SWITCH_MODE;
        }
        if (dev.writeSeq === seq) {
            dev.mode = mode;
            if (mode && mode !== 'Off') {
                dev.lastActiveMode = mode;
            }
        }
        const power = model.round(c.current_power, 1) ?? 0;
        const ow = model.parseOpenWindow(c.open_window_active_now);
        await this.setVal(dev, 'sensor.temperature', model.round(c.ambient_temperature, 2));
        await this.setVal(dev, 'sensor.temperatureRaw', model.round(c.raw_ambient_temperature, 2));
        if (dev.caps.humidity) {
            await this.setVal(dev, 'sensor.humidity', model.round(c.humidity, 1));
        }
        await this.setVal(dev, 'status.power', power);
        // the relay follows the control signal; current_power stays 0 when nothing is plugged in,
        // and switched_on was false on a real socket while its relay was closed
        await this.setVal(dev, 'status.controlSignal', model.round(c.control_signal, 1));
        await this.setVal(dev, 'status.openWindowActive', ow.active);
        await this.setVal(dev, 'status.cloudConnected', !!c.connected_to_cloud);
        await this.setVal(dev, 'info.lastUpdate', now);

        if (dev.energy && dev.energy.add(power, now)) {
            await this.setVal(dev, 'energy.total', model.round(dev.energy.totalKwh, 4));
            await this.setVal(dev, 'energy.today', model.round(dev.energy.todayKwh, 4));
            await this.setVal(dev, 'energy.yesterday', model.round(dev.energy.yesterdayKwh, 4));
        }

        // writable values: device value with ack=true, unless a command was sent meanwhile
        // (the reading would be older than the command and turn the state back)
        // control-status reports 0 as set_temperature while the device is off, so the Normal value is read directly
        dev.normal = Number(normal.value);
        await this.mirror(dev, seq, 'control.targetTemperature', model.round(normal.value, 2));
        await this.mirror(dev, seq, 'control.operationMode', mode);
        // on/off shows the relay (current at the output), in every mode
        await this.mirror(dev, seq, 'control.power', mode !== 'Off' && signal > 0);
        await this.mirror(dev, seq, 'settings.openWindowDetection', ow.enabled);
    }

    /**
     * Rarely changing values. Single failures are tolerated (logged at debug level).
     *
     * @param {Device} dev Device
     */
    async pollSlow(dev) {
        const seq = dev.writeSeq;
        const read = async (path, body) => {
            try {
                return await dev.client.get(path, body);
            } catch (err) {
                if (err && (err.code === 'TIMEOUT' || err.code === 'NETWORK')) {
                    throw err;
                }
                this.log.debug(`${dev.id}: ${path} failed: ${err && err.message}`);
                return null;
            }
        };
        const v = async (path, key, id, conv = x => x) => {
            const r = await read(path);
            if (r && r[key] !== undefined) {
                await this.mirror(dev, seq, id, conv(r[key]));
            }
            return r;
        };
        const st = await read('status');
        if (st) {
            await this.mirror(dev, seq, 'info.customName', st.custom_name || '');
            await this.setVal(dev, 'info.firmware', st.version || '');
            await this.setVal(dev, 'info.operationKey', st.operation_key || '');
            if (st.operation_key) {
                this.log.warn(`${dev.id} reports a fault: ${st.operation_key}`);
            }
        }
        await v('temperature-calibration-offset', 'value', 'settings.calibrationOffset', x => model.round(x, 2));
        await v('child-lock', 'value', 'settings.childLock', x => !!x);
        await v('commercial-lock', 'value', 'settings.commercialLock', x => !!x);
        await v('display-unit', 'value', 'settings.displayUnit', x => normaliseUnit(x));
        await v('predictive-heating-type', 'predictive_heating_type', 'settings.predictiveHeating', String);
        await v('controller-type', 'regulator_type', 'settings.regulatorType', String);
        const tz = await read('timezone-offset');
        if (tz && tz.timezone_offset !== undefined) {
            let offset = Number(tz.timezone_offset);
            // weekly program, timers and vacation need the local time: keep the device's time zone in
            // line with the ioBroker host (also across daylight saving changes)
            const want = schedule.localOffset();
            if (this.config.syncTimezone !== false && this.allowControl && offset !== want && dev.writeSeq === seq) {
                try {
                    await dev.client.post('timezone-offset', { timezone_offset: want });
                    this.log.info(`${dev.id}: time zone offset set from ${offset} to ${want} min (ioBroker host time)`);
                    offset = want;
                } catch (err) {
                    this.log.warn(`${dev.id}: setting the time zone failed: ${err && err.message}`);
                }
            }
            await this.mirror(dev, seq, 'settings.timezoneOffset', offset);
        }
        const wp = await read('weekly-program');
        if (wp) {
            await this.mirror(dev, seq, 'settings.weeklyProgram', schedule.weeklyFromDevice(wp.timers));
        }
        const nt = await read('non-repeatable-timers');
        if (nt) {
            await this.mirror(dev, seq, 'settings.timers', schedule.timersFromDevice(nt.non_repeatable_timers));
        }
        const vac = await read('vacation-mode');
        if (vac) {
            await this.mirror(dev, seq, 'settings.vacation', schedule.vacationFromDevice(vac));
        }
        const cl = await read('commercial-lock-customization');
        if (cl) {
            await this.mirror(
                dev,
                seq,
                'settings.commercialLockMin',
                model.round(cl.min_allowed_temp_in_commercial_lock, 2),
            );
            await this.mirror(
                dev,
                seq,
                'settings.commercialLockMax',
                model.round(cl.max_allowed_temp_in_commercial_lock, 2),
            );
        }
        if (dev.caps.pid) {
            const pid = await read('pid-parameters');
            if (pid) {
                await this.mirror(dev, seq, 'settings.pidKp', Number(pid.kp));
                await this.mirror(dev, seq, 'settings.pidKi', Number(pid.ki));
                await this.mirror(dev, seq, 'settings.pidKd', Number(pid.kd));
                await this.mirror(dev, seq, 'settings.pidKdFilterN', Number(pid.kd_filter_N));
                await this.mirror(dev, seq, 'settings.pidWindupLimit', Number(pid.windup_limit_percentage));
            }
        }
        if (dev.caps.hysteresis) {
            const h = await read('hysteresis-parameters');
            if (h) {
                await this.mirror(dev, seq, 'settings.hysteresisUpper', model.round(h.temp_hysteresis_upper, 2));
                await this.mirror(dev, seq, 'settings.hysteresisLower', model.round(h.temp_hysteresis_lower, 2));
            }
        }
        await v('cloud-communication', 'value', 'settings.cloudCommunication', x => !!x);
        for (const t of ['Comfort', 'Sleep', 'Away']) {
            const r = await read('set-temperature', { type: t });
            if (r && r.value !== undefined) {
                await this.mirror(dev, seq, `settings.temperature${t}`, model.round(r.value, 2));
            }
        }
        const ow = await read('open-window');
        if (ow) {
            await this.mirror(dev, seq, 'settings.openWindowDetection', !!ow.enabled);
            await this.mirror(
                dev,
                seq,
                'settings.openWindowDropTemperature',
                model.round(ow.drop_temperature_threshold, 2),
            );
            await this.mirror(dev, seq, 'settings.openWindowDropTime', Number(ow.drop_time_range));
            await this.mirror(
                dev,
                seq,
                'settings.openWindowIncreaseTemperature',
                model.round(ow.increase_temperature_threshold, 2),
            );
            await this.mirror(dev, seq, 'settings.openWindowIncreaseTime', Number(ow.increase_time_range));
            await this.mirror(dev, seq, 'settings.openWindowMaxTime', Number(ow.max_time));
        }
        if (dev.caps.oilPower) {
            const r = await read('oil-heater-power');
            // documented as heating_level_percentage, example answer uses value
            const val = r ? (r.heating_level_percentage ?? r.value) : undefined;
            if (val !== undefined) {
                await this.mirror(dev, seq, 'settings.oilHeaterPower', Number(val));
            }
        }
        if (dev.caps.limitedPower) {
            const r = await read('limited-heating-power');
            if (r && r.limited_heating_power !== undefined) {
                await this.mirror(dev, seq, 'settings.limitedHeatingPower', Number(r.limited_heating_power));
            }
        }
        if (dev.caps.socketMode) {
            await v('additional-socket-mode', 'additional_mode', 'settings.additionalSocketMode', Number);
        }
    }

    /**
     * @param {Device} dev Device
     * @param {boolean} online Reachable
     */
    async markOnline(dev, online) {
        if (online) {
            dev.fails = 0;
            if (dev.offlineLogged) {
                this.log.info(`${dev.id} at ${dev.ip} is reachable again`);
                dev.offlineLogged = false;
            }
        }
        if (dev.online !== online) {
            dev.online = online;
            if (dev.id && dev.ready) {
                await this.setVal(dev, 'info.online', online);
            }
            await this.updateConnection();
        }
    }

    /**
     * @param {Device} dev Device
     * @param {unknown} err Error
     */
    async handleFailure(dev, err) {
        dev.fails++;
        if (dev.energy) {
            dev.energy.interrupt();
        }
        this.log.debug(`${dev.id || dev.ip}: poll failed (${dev.fails}): ${err && err.message}`);
        if (dev.fails >= FAILS_UNTIL_OFFLINE) {
            if (!dev.offlineLogged) {
                this.log.warn(`${dev.id || dev.ip} at ${dev.ip} does not answer: ${err && err.message}`);
                dev.offlineLogged = true;
            }
            await this.markOnline(dev, false);
            await this.maybeRediscover(dev);
        }
    }

    /**
     * Looks for a device with a known MAC in the configured networks after it went offline.
     *
     * @param {Device} dev Device
     */
    async maybeRediscover(dev) {
        if (!this.config.rediscover || !dev.id || this.unloading) {
            return;
        }
        if (Date.now() - dev.lastRediscover < REDISCOVER_PAUSE_MS) {
            return;
        }
        dev.lastRediscover = Date.now();
        let targets;
        try {
            targets = discovery.expandTargets(this.config.discoverNetworks || this.defaultNetwork(dev.cfg.ip));
        } catch (e) {
            this.log.warn(`Re-discovery: ${e.message}`);
            return;
        }
        this.log.info(`Searching ${targets.length} addresses for ${dev.id} ...`);
        const found = await discovery.scan(targets, {
            timeoutMs: 1500,
            parallel: 8,
            timer: this.timerApi,
            isCancelled: () => this.unloading,
            stopWhen: (_ip, mac) => mac === dev.id,
        });
        const hit = found.find(f => f.mac === dev.id);
        if (hit && hit.ip !== dev.ip) {
            this.log.info(
                `${dev.id} found at ${hit.ip} (configured: ${dev.cfg.ip}). Using the new address; please update the device table.`,
            );
            dev.setIp(hit.ip);
            dev.wrongDeviceLogged = false;
            if (dev.ready) {
                await this.setVal(dev, 'info.ip', hit.ip);
            }
            this.schedule(dev, 200);
        }
    }

    /**
     * @param {string} ip Address
     * @returns {string} Its /24 network
     */
    defaultNetwork(ip) {
        const p = String(ip || '').split('.');
        return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.0/24` : '';
    }

    async updateConnection() {
        const all = this.devices.length > 0 && this.devices.every(d => d.online);
        await this.setState('info.connection', all, true);
    }

    /**
     * Writes a state with ack=true, but only if the value changed (avoids load on the database).
     *
     * @param {Device} dev Device
     * @param {string} id Relative ID
     * @param {unknown} val Value
     */
    async setVal(dev, id, val) {
        if (val === null || val === undefined) {
            return;
        }
        await this.setStateChangedAsync(`${dev.id}.${id}`, { val, ack: true });
    }

    /**
     * Writes the device value of a writable state, unless a command was sent after the reading started.
     *
     * @param {Device} dev Device
     * @param {number} seq Value of dev.writeSeq when the reading started
     * @param {string} id Relative ID
     * @param {unknown} val Value
     */
    async mirror(dev, seq, id, val) {
        if (dev.writeSeq !== seq || val === null || val === undefined) {
            return;
        }
        if (dev.forceIds.has(id)) {
            dev.forceIds.delete(id);
            await this.setStateAsync(`${dev.id}.${id}`, { val, ack: true });
            return;
        }
        await this.setStateChangedAsync(`${dev.id}.${id}`, { val, ack: true });
    }

    /**
     * @param {string} id State ID
     * @param {ioBroker.State | null | undefined} state State
     */
    async onStateChange(id, state) {
        if (!state || state.ack) {
            return;
        }
        const rel = id.slice(this.namespace.length + 1);
        const [devId, ...rest] = rel.split('.');
        const sub = rest.join('.');
        const dev = this.devices.find(d => d.id === devId);
        if (!dev || !dev.ready) {
            this.log.warn(`Command for unknown or not yet connected device ${devId} ignored`);
            return;
        }
        if (sub === 'refresh') {
            await this.refreshAfterCommand(dev);
            return;
        }
        if (!commands.COMMANDS[sub]) {
            return;
        }
        if (!this.allowControl) {
            this.log.warn(`${dev.id}: ${sub} ignored - control is disabled in the instance settings`);
            dev.forceIds.add(sub);
            await this.refreshAfterCommand(dev);
            return;
        }
        // readings that started before this command must not overwrite its result
        dev.writeSeq++;
        try {
            const sent = await commands.execute(dev.client, sub, state.val, {
                mode: dev.mode,
                lastActiveMode: dev.lastActiveMode,
                kind: dev.kind,
                normal: dev.normal,
            });
            if (sub === 'control.operationMode') {
                dev.mode = String(sent);
            } else if (sub === 'control.power') {
                // ON always ends in the manual mode "Switch"; OFF in "Switch" keeps it, otherwise "Off"
                dev.mode = sent || dev.mode === commands.SWITCH_MODE ? commands.SWITCH_MODE : 'Off';
            }
            if (sub === 'control.restart') {
                this.log.info(`${dev.id}: restart requested, the device is unreachable for a few seconds`);
                await this.setStateAsync(id, { val: false, ack: true });
                dev.writeSeq++;
                return;
            }
            await this.setStateAsync(id, { val: sent, ack: true });
            this.log.info(`${dev.id}: ${sub} set to ${JSON.stringify(sent)}`);
        } catch (err) {
            this.log.warn(`${dev.id}: ${sub} = ${JSON.stringify(state.val)} rejected: ${err && err.message}`);
            // show the real value again
            dev.forceIds.add(sub);
        }
        dev.writeSeq++;
        await this.refreshAfterCommand(dev);
    }

    /**
     * Messages from the admin UI.
     *
     * @param {ioBroker.Message} obj Message
     */
    async onMessage(obj) {
        if (!obj || !obj.command) {
            return;
        }
        if (obj.command === 'discover') {
            const msg = obj.message && typeof obj.message === 'object' ? obj.message : {};
            let spec = String(msg.networks || this.config.discoverNetworks || '').trim();
            if (!spec || spec.includes('${')) {
                spec = String(this.config.discoverNetworks || '').trim();
            }
            if (!spec) {
                const first = this.devices[0];
                spec = first ? this.defaultNetwork(first.ip) : '';
            }
            let reply;
            try {
                if (!spec) {
                    throw new Error('Enter the network to search first, e.g. 192.168.1.0/24');
                }
                const targets = discovery.expandTargets(spec);
                this.log.info(`Searching ${targets.length} addresses for Mill devices (${spec}) ...`);
                const found = await discovery.scan(targets, {
                    timeoutMs: 1200,
                    parallel: 32,
                    timer: this.timerApi,
                    isCancelled: () => this.unloading,
                });
                const rows = Array.isArray(this.config.devices) ? this.config.devices.map(r => ({ ...r })) : [];
                let added = 0;
                for (const f of found) {
                    const row =
                        rows.find(r => model.macId(r.mac) === f.mac) || rows.find(r => String(r.ip).trim() === f.ip);
                    if (row) {
                        row.ip = f.ip;
                        row.mac = f.mac;
                        row.name = row.name || f.customName || f.name;
                    } else {
                        rows.push({
                            enabled: true,
                            name: f.customName || f.name,
                            ip: f.ip,
                            mac: f.mac,
                            useApiKey: false,
                        });
                        added++;
                    }
                }
                const text = found.length
                    ? `Found ${found.length} device(s), ${added} new: ${found.map(f => `${f.customName || f.name} (${f.ip})`).join(', ')}. Save to apply.`
                    : 'No Mill device found. Devices with an API key (HTTPS) cannot be found by the search.';
                this.log.info(text);
                reply = { native: { devices: rows }, result: text };
            } catch (err) {
                reply = { error: err.message };
            }
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, reply, obj.callback);
            }
        }
    }

    /**
     * @param {() => void} callback Done
     */
    onUnload(callback) {
        try {
            this.unloading = true;
            for (const d of this.devices) {
                if (d.timer) {
                    this.clearTimeout(d.timer);
                    d.timer = null;
                }
            }
            this.setState('info.connection', false, true).catch(() => {});
            callback();
        } catch {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = options => new MillLocal(options);
} else {
    new MillLocal();
}
