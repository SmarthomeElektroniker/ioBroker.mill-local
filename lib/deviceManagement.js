'use strict';

/*
 * Device manager cards (@iobroker/dm-utils) for the running operation.
 *
 * On purpose only what is needed day to day: name, model, reachability, fault report, live values and
 * the controls that exist as states anyway (on/off, operation mode, target temperature). No configuration
 * actions (add/search/remove devices, change addresses, settings, manual refresh): that stays in the
 * instance settings.
 *
 * WHERE THE CONTROLS ARE. Everything is directly on the card, there is no control dialog:
 * - On/off is ONE toggle in the status line: an indicator bound to status.switchedOn whose symbol, text
 *   and tooltip follow the value live, and which triggers the action powerToggle. The admin loads the
 *   actions of a card only when the page opens, so the action decides on click in which direction to
 *   switch, and asks before it does.
 * - Operation mode (select) and target temperature (slider) are JSON-config rows of customInfo bound to
 *   their states. They stay usable while the heater is off; choosing a mode other than Off switches it on.
 *   Without a control dialog the admin never sends dm:deviceControlState, so there is no control that
 *   could miss a getStateHandler ("Device get state ... has no handler").
 *
 * HOW THEY WRITE. Every control writes its state with ack=false, exactly like a user in the object
 * browser or a script. The command then runs through the normal path of the adapter (onStateChange ->
 * lib/commands.js), so validation (only the documented operation modes reach the device - an unknown one
 * would switch it off), the "control disabled" switch and the read-back after the command apply unchanged.
 *
 * WHY THE NUMBERS ARE HTML. The admin draws a read-only number with unit "%" or with `max` as progress
 * bar, the value set apart below it (humidity, room temperature). A staticText with an HTML pattern per
 * language shows "label ... value unit" in one line instead.
 */

const { DeviceManagement } = require('@iobroker/dm-utils');
const { STATES } = require('./states');
const { COMMANDS, SWITCH_MODE } = require('./commands');
const { OPERATION_MODES } = require('./model');
const TEXT = require('./dmTexts');

/** Object names of lib/states.js, reused as labels (already translated into all languages) */
const NAME = Object.fromEntries(STATES.map(s => [s.id, s.common.name]));

/** Languages that write a decimal comma */
const DECIMAL_COMMA = ['de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk'];

/** The slider writes once it rests that long */
const SLIDER_DELAY_MS = 1000;

/** Action of the on/off toggle in the status line */
const POWER_TOGGLE = 'powerToggle';

/** Thermostat modes the toggle may switch on into (never "Off", never an unknown value) */
const THERMOSTAT_MODES = Object.keys(OPERATION_MODES).filter(m => m !== 'Off');
/** Switching on without a known previous mode */
const DEFAULT_ON_MODE = 'Control individually';

/** Error codes of the answers to the GUI (own range, dm-utils uses 1xx-3xx) */
const ERR_CONTROL_DISABLED = 901;
const ERR_UNKNOWN_DEVICE = 902;
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

// power symbol (Material Design Icons "power", Apache 2.0)
const POWER =
    '<path d="M16.56,5.44L15.11,6.89C16.84,7.94 18,9.83 18,12A6,6 0 0,1 12,18A6,6 0 0,1 6,12C6,9.83 7.16,7.94 ' +
    '8.88,6.88L7.44,5.44C5.36,6.88 4,9.28 4,12A8,8 0 0,0 12,20A8,8 0 0,0 20,12C20,9.28 18.64,6.88 ' +
    '16.56,5.44M13,3H11V13H13"/>';
const WINDOW = '<path fill-rule="evenodd" d="M4 3h16v18H4zm2 2v6h5V5zm7 0v6h5V5zm-7 8v6h5v-6zm7 0v6h5v-6z"/>';

/** On: warm orange, off: grey - readable on light and dark cards */
const ICON_ON = svgIcon(POWER, '#f57c00');
const ICON_OFF = svgIcon(POWER, '#8a8a8a');
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
 * @param {string} s Text
 * @returns {string} Text safe inside HTML
 */
const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * One line "label ... value unit" as HTML pattern per language, for a JSON-config staticText.
 * `_states.v` is the state from dependsOnStates. No curly braces inside the expression: the pattern
 * evaluation of the admin stops at them.
 *
 * @param {Record<string, string>} label Label per language
 * @param {string} unit Unit
 * @param {number} digits Decimal places
 * @returns {Record<string, string>} HTML per language
 */
function numberLineHtml(label, unit, digits) {
    const html = (lang, text) => {
        const value = `Number(_states.v?.val).toFixed(${digits})${DECIMAL_COMMA.includes(lang) ? ".replace('.', ',')" : ''}`;
        return (
            '<div style="display:flex;align-items:center;justify-content:space-between;width:100%;gap:8px;font-size:1rem">' +
            `<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(text)}</div>` +
            '<div style="display:flex;align-items:baseline;gap:4px;white-space:nowrap">' +
            `<span>\${${value}}</span>` +
            `<span style="opacity:0.7;font-size:smaller">${escapeHtml(unit)}</span></div></div>`
        );
    };
    return Object.fromEntries(Object.entries(label).map(([l, t]) => [l, html(l, t)]));
}

/**
 * Card of one Mill device. Without objects (never connected) only name and "disconnected".
 *
 * @param {object} p Parameters
 * @param {string} p.namespace Adapter namespace, e.g. mill-local.0
 * @param {string} p.deviceId Device ID in the GUI (MAC, or ip-<address> before the first connection)
 * @param {string} [p.objectId] Device object below the namespace (MAC), if it exists
 * @param {string} p.fallbackName Name if there is no device object
 * @param {string} p.ip Configured address
 * @param {string} p.kind Device kind (lib/model.js KIND)
 * @param {Record<string, ioBroker.Object>} p.objects Existing states of the device, relative ID -> object
 * @param {boolean} p.allowControl Control enabled in the instance settings
 * @param {(deviceId: string, context: object) => Promise<object>} [p.toggle] Handler of the on/off toggle
 * @returns {object} DeviceInfo
 */
function buildCard(p) {
    const icon = p.kind === 'socket' ? 'socket' : 'thermostat';
    if (!p.objectId) {
        return {
            id: p.deviceId,
            name: p.fallbackName || p.ip,
            icon,
            status: 'disconnected',
        };
    }
    const full = rel => `${p.namespace}.${p.objectId}.${rel}`;
    const has = rel => !!p.objects[rel];
    const writable = rel => {
        const obj = p.objects[rel];
        return !!(p.allowControl && obj && obj.common && obj.common.write && COMMANDS[rel]);
    };

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

    const indicators = [];
    const actions = [];
    if (has('status.switchedOn')) {
        const canSwitch = writable('control.power') && writable('control.operationMode');
        const off = {
            icon: ICON_OFF,
            text: TEXT.Off,
            tooltip: canSwitch ? TEXT['Switch on'] : NAME['status.switchedOn'],
        };
        const on = {
            icon: ICON_ON,
            text: TEXT.On,
            tooltip: canSwitch ? TEXT['Switch off'] : NAME['status.switchedOn'],
        };
        const toggle = {
            id: 'power',
            value: { stateId: full('status.switchedOn') },
            // "off" (false) stays visible: then the toggle shows "Off"
            hideIfEmpty: false,
            levels: [{ value: true, ...on }, { value: false, ...off }, off],
            ...off,
            order: 10,
        };
        if (canSwitch) {
            toggle.actionId = POWER_TOGGLE;
            const action = { id: POWER_TOGGLE, icon: ICON_OFF, description: TEXT['Switch on'] };
            if (p.toggle) {
                action.handler = (deviceId, context) => p.toggle(deviceId, context);
            }
            actions.push(action);
        }
        indicators.push(toggle);
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

    // The values of the running operation, directly on the card
    const items = {};
    const numberLine = (key, rel, unit, digits) => {
        if (!has(rel)) {
            return;
        }
        items[key] = {
            type: 'staticText',
            format: 'html',
            // func: pattern per language - only like this the admin evaluates ${...} in a language object
            text: { func: numberLineHtml(NAME[rel], unit, digits) },
            dependsOnStates: { v: full(rel) },
            hidden: "!(typeof _states.v?.val === 'number' && isFinite(_states.v.val))",
            xs: 12,
        };
    };
    numberLine('temperature', 'sensor.temperature', '°C', 1);
    numberLine('humidity', 'sensor.humidity', '%', 0);
    if (has('control.operationMode')) {
        const mode = {
            type: 'state',
            oid: full('control.operationMode'),
            foreign: true,
            label: NAME['control.operationMode'],
            control: 'select',
            options: MODE_OPTIONS,
            xs: 12,
        };
        if (!writable('control.operationMode')) {
            mode.readOnly = true;
        }
        items.operationMode = mode;
    }
    numberLine('targetTemperature', 'control.targetTemperature', '°C', 1);
    if (writable('control.targetTemperature')) {
        const def = COMMANDS['control.targetTemperature'];
        items.targetSlider = {
            type: 'state',
            oid: full('control.targetTemperature'),
            foreign: true,
            label: '',
            control: 'slider',
            min: def.min,
            max: def.max,
            step: def.step,
            unit: '°C',
            digits: 1,
            controlDelay: SLIDER_DELAY_MS,
            xs: 12,
        };
    }
    numberLine('power', 'status.power', 'W', 0);
    numberLine('energyToday', 'energy.today', 'kWh', 2);

    return {
        id: p.deviceId,
        name: { objectId: `${p.namespace}.${p.objectId}`, property: 'common.name' },
        // only the model; no manufacturer (always Mill) and no MAC address
        model: has('info.model') ? { stateId: full('info.model') } : undefined,
        icon,
        status,
        indicators,
        actions,
        customInfo: Object.keys(items).length ? { id: p.deviceId, schema: { type: 'panel', items } } : undefined,
    };
}

/**
 * What the toggle does from the current state. Pure, for tests.
 *
 * Off: control.power=false (operation mode Off, or the relay open in "Switch").
 * On: back into the last active mode - "Switch" closes the relay (control.power=true), a thermostat mode
 * is written as operation mode. Anything else (unknown, never seen) becomes "Control individually".
 *
 * @param {boolean} isOn Current value of status.switchedOn
 * @param {string} mode Current operation mode
 * @param {string} lastActiveMode Last mode other than Off
 * @returns {{rel: string, val: string|boolean, mode: string}} State to write and the resulting mode
 */
function toggleTarget(isOn, mode, lastActiveMode) {
    if (isOn) {
        return { rel: 'control.power', val: false, mode: mode === SWITCH_MODE ? SWITCH_MODE : 'Off' };
    }
    if (mode === SWITCH_MODE || (mode === 'Off' && lastActiveMode === SWITCH_MODE)) {
        return { rel: 'control.power', val: true, mode: SWITCH_MODE };
    }
    const target = THERMOSTAT_MODES.includes(lastActiveMode) ? lastActiveMode : DEFAULT_ON_MODE;
    return { rel: 'control.operationMode', val: target, mode: target };
}

/**
 * @param {Record<string, string>} texts Text per language with {name} and {mode}
 * @param {string} name Device name
 * @param {Record<string, string>} [mode] Mode label per language
 * @returns {Record<string, string>} Texts with the values filled in
 */
const question = (texts, name, mode) =>
    Object.fromEntries(
        Object.entries(texts).map(([l, t]) => [
            l,
            t.replace('{name}', name).replace('{mode}', mode ? mode[l] || mode.en : ''),
        ]),
    );

/**
 * Device manager of the adapter. Reads the device list of the running adapter (`adapter.devices`).
 */
class MillDeviceManagement extends DeviceManagement {
    /**
     * @returns {{apiVersion: 'v3'}} Instance information (no instance actions)
     */
    getInstanceInfo() {
        return { apiVersion: 'v3' };
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
            if (objectId) {
                const own = await this.adapter.getForeignObjectsAsync(`${prefix}*`, 'state');
                for (const [id, obj] of Object.entries(own || {})) {
                    objects[id.slice(prefix.length)] = obj;
                }
            }
            const exists = Object.keys(objects).length > 0;
            context.addDevice(
                buildCard({
                    namespace: ns,
                    deviceId: objectId || `ip-${dev.ip}`,
                    objectId: exists ? objectId : undefined,
                    fallbackName: (dev.cfg && dev.cfg.name) || '',
                    ip: dev.ip,
                    kind: dev.kind,
                    objects,
                    allowControl: !!this.adapter.allowControl,
                    toggle: (_deviceId, ctx) => this.togglePower(objectId, ctx),
                }),
            );
        }
    }

    /**
     * On/off toggle: reads the current state, asks and writes the command (ack=false).
     *
     * @param {string} objectId Device object (MAC)
     * @param {{showConfirmation: (text: ioBroker.StringOrTranslated) => Promise<boolean>}} context Action context
     * @returns {Promise<object>} Answer to the GUI
     */
    async togglePower(objectId, context) {
        if (!this.adapter.allowControl) {
            return fail(ERR_CONTROL_DISABLED, 'control is disabled in the instance settings');
        }
        const devices = Array.isArray(this.adapter.devices) ? this.adapter.devices : [];
        const dev = objectId ? devices.find(d => d.id === objectId) : undefined;
        if (!dev) {
            return fail(ERR_UNKNOWN_DEVICE, `unknown device ${objectId}`);
        }
        const base = `${this.adapter.namespace}.${objectId}`;
        const st = await this.adapter.getForeignStateAsync(`${base}.status.switchedOn`);
        const modeState = await this.adapter.getForeignStateAsync(`${base}.control.operationMode`);
        const mode = String(dev.mode || (modeState && modeState.val) || '');
        const target = toggleTarget(!!(st && st.val), mode, dev.lastActiveMode);

        const obj = await this.adapter.getForeignObjectAsync(base);
        let name = (obj && obj.common && obj.common.name) || (dev.cfg && dev.cfg.name) || objectId;
        if (typeof name === 'object') {
            name = name.en || Object.values(name)[0] || objectId;
        }
        const text =
            target.rel === 'control.power' && target.val === false
                ? question(TEXT['Confirm off'], String(name))
                : question(TEXT['Confirm on'], String(name), TEXT[target.mode] || { en: target.mode });
        if (!(await context.showConfirmation(text))) {
            return { refresh: 'none' };
        }
        try {
            await this.adapter.setForeignStateAsync(`${base}.${target.rel}`, target.val, false);
        } catch (err) {
            return fail(ERR_WRITE_FAILED, `${target.rel}: ${err && err.message}`);
        }
        // the indicator follows status.switchedOn by itself, the card needs no reload
        return { refresh: 'none' };
    }
}

module.exports = { MillDeviceManagement, buildCard, toggleTarget, numberLineHtml, MODE_OPTIONS, POWER_TOGGLE };
