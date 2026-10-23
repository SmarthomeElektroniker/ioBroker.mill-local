'use strict';

/**
 * Object model of one Mill device. All IDs relative to the device object `<mac>`.
 *
 * Every value exists exactly once. Writable values (see lib/commands.js) carry the actual
 * device value with ack=true and are display and actuator at the same time:
 * - control.*  : what is changed in daily use (target temperature, operation mode, on/off)
 * - settings.* : configuration of the device
 * `need` names a capability the state depends on (probed at start-up).
 */

const { commonFor, COMMANDS } = require('./commands');
const NAMES = require('./names');

/**
 * Object name in all eleven languages.
 *
 * @param {string} en English text (key of lib/names.js)
 * @param {string} de German text
 * @returns {Record<string, string>} Translated name
 */
const n = (en, de) => {
    const more = NAMES[en];
    if (!more) {
        throw new Error(`Missing translation for "${en}"`);
    }
    return { en, de, ...more };
};

const ro = (type, role, name, extra = {}) => ({ type, role, name, read: true, write: false, ...extra });

/** Channels of a device */
const CHANNELS = {
    info: n('Device information', 'Geräteinformationen'),
    sensor: n('Sensors', 'Sensoren'),
    status: n('Status', 'Zustand'),
    control: n('Control', 'Steuerung'),
    settings: n('Settings', 'Einstellungen'),
    energy: n('Energy (estimated)', 'Energie (geschätzt)'),
};

const temp = (name, extra = {}) => ro('number', 'level.temperature', name, { unit: '°C', ...extra });

const STATES = [
    // info
    { id: 'info.model', common: ro('string', 'info.name', n('Model name', 'Modellname'), { def: '' }) },
    { id: 'info.customName', common: ro('string', 'info.name', n('Custom name', 'Eigener Name'), { def: '' }) },
    {
        id: 'info.type',
        common: ro('string', 'text', n('Device kind', 'Geräteart'), {
            def: 'unknown',
            states: {
                panel: 'panel',
                convection: 'convection',
                oil: 'oil',
                socket: 'socket',
                storage: 'storage',
                unknown: 'unknown',
            },
        }),
    },
    {
        id: 'info.firmware',
        common: ro('string', 'info.firmware', n('API/firmware version', 'API-/Firmwareversion'), { def: '' }),
    },
    { id: 'info.mac', common: ro('string', 'info.mac', n('MAC address', 'MAC-Adresse'), { def: '' }) },
    { id: 'info.ip', common: ro('string', 'info.ip', n('IP address', 'IP-Adresse'), { def: '' }) },
    { id: 'info.online', common: ro('boolean', 'indicator.reachable', n('Reachable', 'Erreichbar'), { def: false }) },
    {
        id: 'info.operationKey',
        common: ro('string', 'text', n('Fault report of the device', 'Störungsmeldung des Geräts'), { def: '' }),
    },
    {
        id: 'info.lastUpdate',
        common: ro('number', 'date', n('Last successful poll', 'Letzte erfolgreiche Abfrage'), { def: 0 }),
    },

    // sensor
    {
        id: 'sensor.temperature',
        common: ro('number', 'value.temperature', n('Room temperature', 'Raumtemperatur'), { unit: '°C', def: 0 }),
    },
    {
        id: 'sensor.temperatureRaw',
        common: ro(
            'number',
            'value.temperature',
            n('Room temperature without calibration', 'Raumtemperatur ohne Kalibrierung'),
            { unit: '°C', def: 0 },
        ),
    },
    {
        id: 'sensor.humidity',
        need: 'humidity',
        common: ro('number', 'value.humidity', n('Humidity', 'Luftfeuchtigkeit'), {
            unit: '%',
            min: 0,
            max: 100,
            def: 0,
        }),
    },

    // status (only values that cannot be set)
    {
        id: 'status.power',
        common: ro('number', 'value.power', n('Heating power', 'Heizleistung'), { unit: 'W', def: 0 }),
    },
    {
        id: 'status.controlSignal',
        common: ro('number', 'value', n('Control signal', 'Stellsignal'), { unit: '%', min: 0, max: 100, def: 0 }),
    },
    {
        id: 'status.openWindowActive',
        common: ro('boolean', 'sensor.window', n('Open window detected', 'Offenes Fenster erkannt'), { def: false }),
    },
    {
        id: 'status.cloudConnected',
        common: ro('boolean', 'indicator.connected', n('Connected to the Mill cloud', 'Mit der Mill-Cloud verbunden'), {
            def: false,
        }),
    },

    // control
    { id: 'control.targetTemperature', common: temp(n('Target temperature', 'Solltemperatur')) },
    { id: 'control.operationMode', common: ro('string', 'text', n('Operation mode', 'Betriebsart')) },
    {
        id: 'control.power',
        common: ro('boolean', 'switch.power', n('On/off (relay, manual mode)', 'Ein/Aus (Relais, manueller Modus)')),
    },
    {
        id: 'control.restart',
        common: {
            type: 'boolean',
            role: 'button',
            name: n('Restart the device', 'Gerät neu starten'),
            read: false,
            write: true,
            def: false,
        },
    },

    // settings
    {
        id: 'settings.calibrationOffset',
        common: ro('number', 'level', n('Temperature calibration offset', 'Temperatur-Kalibrierung'), { unit: '°C' }),
    },
    { id: 'settings.childLock', common: ro('boolean', 'switch.lock', n('Child lock', 'Kindersicherung')) },
    { id: 'settings.commercialLock', common: ro('boolean', 'switch.lock', n('Commercial lock', 'Gewerbesperre')) },
    { id: 'settings.displayUnit', common: ro('string', 'text', n('Display unit', 'Anzeigeeinheit')) },
    {
        id: 'settings.predictiveHeating',
        common: ro('string', 'text', n('Predictive heating', 'Vorausschauendes Heizen')),
    },
    {
        id: 'settings.cloudCommunication',
        common: ro(
            'boolean',
            'switch.enable',
            n('Cloud communication allowed (after restart)', 'Cloud-Kommunikation erlaubt (nach Neustart)'),
        ),
    },
    { id: 'settings.regulatorType', common: ro('string', 'text', n('Controller type', 'Reglerart')) },
    {
        id: 'settings.timezoneOffset',
        common: ro(
            'number',
            'level',
            n('Time zone offset (1440 = not set)', 'Zeitzonen-Versatz (1440 = nicht gesetzt)'),
            {
                unit: 'min',
            },
        ),
    },
    {
        id: 'settings.weeklyProgram',
        common: ro('string', 'json', n('Weekly program (JSON)', 'Wochenprogramm (JSON)'), { def: '[]' }),
    },
    {
        id: 'settings.timers',
        common: ro('string', 'json', n('One-off timers (JSON)', 'Einzeltimer (JSON)'), { def: '[]' }),
    },
    { id: 'settings.vacation', common: ro('string', 'json', n('Vacation (JSON)', 'Urlaub (JSON)'), { def: '{}' }) },
    {
        id: 'settings.commercialLockMin',
        common: temp(n('Commercial lock: lowest temperature', 'Gewerbesperre: niedrigste Temperatur')),
    },
    {
        id: 'settings.commercialLockMax',
        common: temp(n('Commercial lock: highest temperature', 'Gewerbesperre: höchste Temperatur')),
    },
    {
        id: 'settings.pidKp',
        need: 'pid',
        common: ro('number', 'level', n('PID: proportional gain', 'PID: Proportionalanteil')),
    },
    {
        id: 'settings.pidKi',
        need: 'pid',
        common: ro('number', 'level', n('PID: integral gain', 'PID: Integralanteil')),
    },
    {
        id: 'settings.pidKd',
        need: 'pid',
        common: ro('number', 'level', n('PID: derivative gain', 'PID: Differentialanteil')),
    },
    {
        id: 'settings.pidKdFilterN',
        need: 'pid',
        common: ro('number', 'level', n('PID: derivative filter', 'PID: Filter des Differentialanteils')),
    },
    {
        id: 'settings.pidWindupLimit',
        need: 'pid',
        common: ro('number', 'level', n('PID: windup limit', 'PID: Begrenzung des Integralanteils'), { unit: '%' }),
    },
    {
        id: 'settings.hysteresisUpper',
        need: 'hysteresis',
        common: ro('number', 'level', n('Hysteresis above target', 'Hysterese über Soll'), { unit: '°C' }),
    },
    {
        id: 'settings.hysteresisLower',
        need: 'hysteresis',
        common: ro('number', 'level', n('Hysteresis below target', 'Hysterese unter Soll'), { unit: '°C' }),
    },
    { id: 'settings.temperatureComfort', common: temp(n('Temperature "Comfort"', 'Temperatur „Komfort“')) },
    { id: 'settings.temperatureSleep', common: temp(n('Temperature "Sleep"', 'Temperatur „Schlafen“')) },
    { id: 'settings.temperatureAway', common: temp(n('Temperature "Away"', 'Temperatur „Abwesend“')) },
    {
        id: 'settings.oilHeaterPower',
        need: 'oilPower',
        common: ro('number', 'level', n('Oil heater power level', 'Leistungsstufe Ölradiator'), { unit: '%' }),
    },
    {
        id: 'settings.limitedHeatingPower',
        need: 'limitedPower',
        common: ro('number', 'level', n('Power limit', 'Leistungsbegrenzung'), { unit: '%' }),
    },
    {
        id: 'settings.additionalSocketMode',
        need: 'socketMode',
        common: ro('number', 'level', n('Additional socket mode', 'Zusatzmodus Steckdose')),
    },
    {
        id: 'settings.openWindowDetection',
        common: ro('boolean', 'switch.enable', n('Open window detection', 'Fenster-offen-Erkennung')),
    },
    {
        id: 'settings.openWindowDropTemperature',
        common: ro('number', 'level', n('Open window: temperature drop', 'Fenster offen: Temperaturabfall'), {
            unit: '°C',
        }),
    },
    {
        id: 'settings.openWindowDropTime',
        common: ro('number', 'level', n('Open window: time for the drop', 'Fenster offen: Zeitraum des Abfalls'), {
            unit: 's',
        }),
    },
    {
        id: 'settings.openWindowIncreaseTemperature',
        common: ro('number', 'level', n('Open window: temperature rise', 'Fenster offen: Temperaturanstieg'), {
            unit: '°C',
        }),
    },
    {
        id: 'settings.openWindowIncreaseTime',
        common: ro('number', 'level', n('Open window: time for the rise', 'Fenster offen: Zeitraum des Anstiegs'), {
            unit: 's',
        }),
    },
    {
        id: 'settings.openWindowMaxTime',
        common: ro('number', 'level', n('Open window: maximum pause', 'Fenster offen: längste Pause'), { unit: 's' }),
    },

    // energy
    {
        id: 'energy.total',
        common: ro('number', 'value.energy.consumed', n('Energy total (estimated)', 'Energie gesamt (geschätzt)'), {
            unit: 'kWh',
            def: 0,
        }),
    },
    {
        id: 'energy.today',
        common: ro('number', 'value.energy.consumed', n('Energy today (estimated)', 'Energie heute (geschätzt)'), {
            unit: 'kWh',
            def: 0,
        }),
    },
    {
        id: 'energy.yesterday',
        common: ro(
            'number',
            'value.energy.consumed',
            n('Energy yesterday (estimated)', 'Energie gestern (geschätzt)'),
            { unit: 'kWh', def: 0 },
        ),
    },

    // always present, reads only
    {
        id: 'refresh',
        common: {
            type: 'boolean',
            role: 'button',
            name: n('Read the device now', 'Gerät jetzt abfragen'),
            read: false,
            write: true,
            def: false,
        },
    },
];

/**
 * Roles of writable values and their read-only counterparts, used while control is disabled
 * (level.* and switch.* require common.write = true).
 */
const READ_ONLY_ROLES = {
    'level.temperature': 'value.temperature',
    level: 'value',
    'switch.power': 'sensor.switch',
    'switch.lock': 'sensor.lock',
    'switch.enable': 'indicator',
};

/**
 * Definitions applicable to a device. Without control, buttons are left out and writable
 * values get read-only roles, with write flag and limits from the command table.
 *
 * @param {Record<string, boolean>} caps Capabilities
 * @param {boolean} allowWrite Control enabled
 * @returns {Array<{id: string, common: object}>} Definitions
 */
function definitionsFor(caps, allowWrite) {
    return STATES.filter(s => !s.need || caps[s.need])
        .filter(s => allowWrite || !(COMMANDS[s.id] && COMMANDS[s.id].button))
        .map(s => {
            const common = { ...s.common, ...commonFor(s.id, allowWrite) };
            if (!common.write && READ_ONLY_ROLES[common.role]) {
                common.role = READ_ONLY_ROLES[common.role];
            }
            return { id: s.id, common };
        });
}

module.exports = { CHANNELS, STATES, definitionsFor };
