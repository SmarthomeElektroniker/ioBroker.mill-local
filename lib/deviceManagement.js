'use strict';

/*
 * Device manager cards (@iobroker/dm-utils) for the running operation.
 *
 * On purpose only what is needed day to day: name, reachability, fault report, live values and the
 * controls that exist as states anyway (target temperature, operation mode, on/off). No configuration
 * actions (add/search/remove devices, change addresses, settings): that stays in the instance settings.
 *
 * Every control writes its state with ack=false, exactly like a user in the object browser or a script.
 * The command then runs through the normal path of the adapter (onStateChange -> lib/commands.js), so
 * validation, the "control disabled" switch and the read-back after the command apply unchanged.
 */

const { DeviceManagement } = require('@iobroker/dm-utils');
const { STATES } = require('./states');
const { COMMANDS, validate, SWITCH_MODE } = require('./commands');
const { OPERATION_MODES } = require('./model');
const TEXT = require('./dmTexts');

/** Object names of lib/states.js, reused as labels (already translated into all languages) */
const NAME = Object.fromEntries(STATES.map(s => [s.id, s.common.name]));

/** A number field sends every keystroke; the device only gets the value once the input rests */
const INPUT_DELAY_MS = 1500;

/**
 * Card contents, in this order. `type` is the control type while the value can be written.
 * Values that cannot be written (read-only states, control disabled) are shown as info.
 */
const CARD_CONTROLS = [
    { rel: 'sensor.temperature', type: 'info' },
    { rel: 'sensor.humidity', type: 'info' },
    { rel: 'control.targetTemperature', type: 'number', delayed: true },
    { rel: 'control.operationMode', type: 'select' },
    { rel: 'control.power', type: 'switch' },
    { rel: 'status.power', type: 'info' },
    { rel: 'energy.today', type: 'info' },
];

/** Values shown directly on the card (read only), in this order */
const CARD_INFO = ['sensor.temperature', 'sensor.humidity', 'control.targetTemperature', 'control.operationMode'];

/** Error codes of the answers to the GUI (own range, dm-utils uses 1xx-3xx) */
const ERR_CONTROL_DISABLED = 901;
const ERR_INVALID_VALUE = 902;
const ERR_NO_VALUE = 903;
const ERR_WRITE_FAILED = 904;

/**
 * @param {string} body SVG elements
 * @param {string} color Fill colour
 * @returns {string} data URL of a 24x24 icon
 */
const svgIcon = (body, color) =>
    `data:image/svg+xml;base64,${Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="${color}">${body}</svg>`,
    ).toString('base64')}`;

const FLAME =
    '<path d="M12 2c.6 3.2 4.8 5.6 4.8 10.4A4.8 4.8 0 0 1 12 17.2a4.8 4.8 0 0 1-4.8-4.8c0-2.2 1.1-3.6 2.3-4.8.1 1.9 1 3.1 2.2 3.4-.4-3 .2-6 .3-9z"/><path d="M5 19h14v2H5z"/>';
const WINDOW = '<path fill-rule="evenodd" d="M4 3h16v18H4zm2 2v6h5V5zm7 0v6h5V5zm-7 8v6h5v-6zm7 0v6h5v-6z"/>';

const ICON_HEATING = svgIcon(FLAME, '#f57c00');
const ICON_NOT_HEATING = svgIcon(FLAME, '#9e9e9e');
const ICON_WINDOW = svgIcon(WINDOW, '#f57c00');

/** Options of the operation mode: the values the state accepts, with translated labels */
const MODE_OPTIONS = [...Object.keys(OPERATION_MODES), SWITCH_MODE].map(value => ({
    value,
    label: TEXT[value] || value,
}));

/**
 * @param {number} code Error code
 * @param {string} message Text
 * @returns {{error: {code: number, message: string}}} Error answer for the GUI
 */
const fail = (code, message) => ({ error: { code, message } });

/**
 * Card of one Mill device. Without objects (never connected) only name, address and "disconnected".
 *
 * @param {object} p Parameters
 * @param {string} p.namespace Adapter namespace, e.g. mill-local.0
 * @param {string} p.deviceId Device ID in the GUI (MAC, or ip-<address> before the first connection)
 * @param {string} [p.objectId] Device object below the namespace (MAC), if it exists
 * @param {string} p.fallbackName Name if there is no device object
 * @param {string} p.ip Configured address
 * @param {string} p.kind Device kind (lib/model.js KIND)
 * @param {Record<string, ioBroker.Object>} p.objects Existing states of the device, relative ID -> object
 * @param {Record<string, ioBroker.State | null | undefined>} p.states Current values, relative ID -> state
 * @param {boolean} p.allowControl Control enabled in the instance settings
 * @param {(rel: string, val: unknown, delayed: boolean) => Promise<object>} p.write Writes a control
 * @param {(rel: string) => Promise<object>} p.read Reads a control
 * @param {() => Promise<unknown>} p.refresh Requests a read of the device
 * @returns {object} DeviceInfo
 */
function buildCard(p) {
    if (!p.objectId) {
        return {
            id: p.deviceId,
            name: p.fallbackName || p.ip,
            identifier: p.ip,
            manufacturer: 'Mill',
            icon: 'thermostat',
            status: 'disconnected',
        };
    }
    const full = rel => `${p.namespace}.${p.objectId}.${rel}`;
    const has = rel => !!p.objects[rel];

    const controls = [];
    for (const c of CARD_CONTROLS) {
        const obj = p.objects[c.rel];
        if (!obj) {
            continue;
        }
        const common = obj.common || {};
        const writable = !!(p.allowControl && common.write && COMMANDS[c.rel]);
        const type = writable ? c.type : 'info';
        const ctl = {
            id: c.rel,
            type,
            label: NAME[c.rel],
            stateId: full(c.rel),
            getStateHandler: () => p.read(c.rel),
        };
        const state = p.states[c.rel];
        if (state) {
            ctl.state = state;
        }
        if (common.unit) {
            ctl.unit = common.unit;
        }
        if (type === 'number') {
            ctl.min = common.min;
            ctl.max = common.max;
            ctl.step = common.step;
        }
        if (type === 'select') {
            ctl.options = MODE_OPTIONS;
        }
        if (type === 'info') {
            // without it the admin glues label and value together ("Raumtemperatur20.72")
            ctl.showSemicolon = true;
        }
        if (type === 'info' && common.type === 'boolean') {
            ctl.textTrue = TEXT.On;
            ctl.textFalse = TEXT.Off;
        }
        if (writable) {
            ctl.handler = (_deviceId, _controlId, val) => p.write(c.rel, val, !!c.delayed);
        }
        controls.push(ctl);
    }

    const indicators = [];
    if (has('status.controlSignal')) {
        indicators.push({
            id: 'heating',
            value: { stateId: full('status.controlSignal') },
            showValue: true,
            unit: '%',
            hideIfEmpty: true,
            levels: [
                { max: 0, icon: ICON_NOT_HEATING, color: 'inactive', tooltip: TEXT['Not heating'] },
                { icon: ICON_HEATING, color: 'warning', tooltip: TEXT.Heating },
            ],
            label: TEXT.Heating,
            order: 10,
        });
    }
    if (has('status.openWindowActive')) {
        indicators.push({
            id: 'openWindow',
            value: { stateId: full('status.openWindowActive') },
            icon: ICON_WINDOW,
            colorOn: 'warning',
            tooltip: NAME['status.openWindowActive'],
            label: NAME['status.openWindowActive'],
            order: 20,
        });
    }

    const status = {};
    if (has('info.online')) {
        status.connection = {
            stateId: full('info.online'),
            mapping: { true: 'connected', false: 'disconnected' },
        };
    }
    if (has('info.operationKey')) {
        // empty while there is no fault, otherwise the fault text of the device
        status.warning = { stateId: full('info.operationKey') };
    }

    const actions = [];
    if (has('refresh')) {
        actions.push({
            id: 'refresh',
            icon: 'refresh',
            description: NAME.refresh,
            handler: async () => {
                await p.refresh();
                return { refresh: 'none' };
            },
        });
    }

    // The most important values directly on the card (read only). The controls above are only shown in
    // the control dialog of the admin; without these rows the card itself would show no measured value.
    const items = {};
    for (const rel of CARD_INFO) {
        const obj = p.objects[rel];
        if (!obj) {
            continue;
        }
        const common = obj.common || {};
        const item = {
            type: 'state',
            oid: full(rel),
            foreign: true,
            label: NAME[rel],
            readOnly: true,
            control: 'text',
            xs: 12,
        };
        if (common.unit) {
            item.unit = common.unit;
        }
        if (common.type === 'number' && rel !== 'control.operationMode') {
            item.digits = 1;
        }
        if (rel === 'control.operationMode') {
            item.control = 'select';
            item.options = MODE_OPTIONS;
        }
        items[`_${rel.replace(/\./g, '_')}`] = item;
    }

    return {
        id: p.deviceId,
        name: { objectId: `${p.namespace}.${p.objectId}`, property: 'common.name' },
        identifier: p.objectId,
        manufacturer: 'Mill',
        model: has('info.model') ? { stateId: full('info.model') } : undefined,
        icon: p.kind === 'socket' ? 'socket' : 'thermostat',
        status,
        indicators,
        controls,
        actions,
        customInfo: Object.keys(items).length ? { id: p.deviceId, schema: { type: 'panel', items } } : undefined,
    };
}

/**
 * Device manager of the adapter. Reads the device list of the running adapter (`adapter.devices`).
 */
class MillDeviceManagement extends DeviceManagement {
    /**
     * @param {import('@iobroker/adapter-core').AdapterInstance} adapter The adapter instance (MillLocal)
     */
    constructor(adapter) {
        super(adapter);
        /** Pending inputs of number fields: full state ID -> timer */
        this.pending = new Map();
    }

    /**
     * @returns {{apiVersion: 'v3', identifierLabel: ioBroker.StringOrTranslated}} Instance information
     */
    getInstanceInfo() {
        return {
            apiVersion: 'v3',
            identifierLabel: NAME['info.mac'],
        };
    }

    /**
     * @param {{addDevice: (d: object) => void, setTotalDevices: (n: number) => void}} context Load context
     */
    async loadDevices(context) {
        const devices = Array.isArray(this.adapter.devices) ? this.adapter.devices : [];
        context.setTotalDevices(devices.length);
        const ns = this.adapter.namespace;
        for (const dev of devices) {
            const objectId = dev.id || '';
            const prefix = `${ns}.${objectId}.`;
            const objects = {};
            const states = {};
            let exists = false;
            if (objectId) {
                const own = await this.adapter.getForeignObjectsAsync(`${prefix}*`, 'state');
                for (const [id, obj] of Object.entries(own || {})) {
                    objects[id.slice(prefix.length)] = obj;
                }
                exists = Object.keys(objects).length > 0;
                if (exists) {
                    for (const c of CARD_CONTROLS) {
                        if (objects[c.rel]) {
                            states[c.rel] = await this.adapter.getForeignStateAsync(`${prefix}${c.rel}`);
                        }
                    }
                }
            }
            context.addDevice(
                buildCard({
                    namespace: ns,
                    deviceId: objectId || `ip-${dev.ip}`,
                    objectId: exists ? objectId : undefined,
                    fallbackName: (dev.cfg && dev.cfg.name) || '',
                    ip: dev.ip,
                    kind: dev.kind,
                    objects,
                    states,
                    allowControl: !!this.adapter.allowControl,
                    write: (rel, val, delayed) => this.writeControl(objectId, rel, val, delayed),
                    read: rel => this.readControl(objectId, rel),
                    refresh: () => this.adapter.setForeignStateAsync(`${prefix}refresh`, true, false),
                }),
            );
        }
    }

    /**
     * @param {string} objectId Device object
     * @param {string} rel Relative state ID
     * @returns {Promise<object>} State or error answer
     */
    async readControl(objectId, rel) {
        const state = await this.adapter.getForeignStateAsync(`${this.adapter.namespace}.${objectId}.${rel}`);
        return state || fail(ERR_NO_VALUE, `${rel}: no value yet`);
    }

    /**
     * Writes a control as command (ack=false). Number fields are delayed until the input rests.
     *
     * @param {string} objectId Device object
     * @param {string} rel Relative state ID
     * @param {unknown} val New value from the GUI
     * @param {boolean} delayed Wait for the input to rest
     * @returns {Promise<object>} State or error answer
     */
    async writeControl(objectId, rel, val, delayed) {
        if (!this.adapter.allowControl) {
            return fail(ERR_CONTROL_DISABLED, 'control is disabled in the instance settings');
        }
        const id = `${this.adapter.namespace}.${objectId}.${rel}`;
        if (delayed) {
            const old = this.pending.get(id);
            if (old) {
                this.adapter.clearTimeout(old);
            }
            this.pending.set(
                id,
                this.adapter.setTimeout(() => {
                    this.pending.delete(id);
                    this.sendDelayed(id, rel, val).catch(err => this.log.warn(`${id}: ${err && err.message}`));
                }, INPUT_DELAY_MS),
            );
            // show the input until the command is sent; the subscription then shows the device value
            const now = Date.now();
            return { val, ack: false, ts: now, lc: now, from: `system.adapter.${this.adapter.namespace}`, q: 0 };
        }
        let v;
        try {
            v = validate(rel, val);
        } catch (err) {
            return fail(ERR_INVALID_VALUE, `${rel}: ${err && err.message}`);
        }
        try {
            await this.adapter.setForeignStateAsync(id, v, false);
        } catch (err) {
            return fail(ERR_WRITE_FAILED, `${rel}: ${err && err.message}`);
        }
        return (await this.adapter.getForeignStateAsync(id)) || fail(ERR_NO_VALUE, `${rel}: no value`);
    }

    /**
     * @param {string} id Full state ID
     * @param {string} rel Relative state ID
     * @param {unknown} val Last input
     */
    async sendDelayed(id, rel, val) {
        let v;
        try {
            v = validate(rel, val);
        } catch (err) {
            // half-typed numbers (e.g. "2" on the way to "21") end here when the input stops on them
            this.log.info(`${id}: input ${JSON.stringify(val)} from the device manager ignored: ${err && err.message}`);
            return;
        }
        await this.adapter.setForeignStateAsync(id, v, false);
    }
}

module.exports = { MillDeviceManagement, buildCard, CARD_CONTROLS, MODE_OPTIONS, INPUT_DELAY_MS };
