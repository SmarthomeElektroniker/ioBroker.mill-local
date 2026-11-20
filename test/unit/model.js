'use strict';

const assert = require('node:assert');
const m = require('../../lib/model');

describe('model', () => {
    it('detects the device kind from the model name', () => {
        assert.strictEqual(m.kindFromName('Mill HeaterGen3Socket'), 'socket');
        assert.strictEqual(m.kindFromName('panel heater gen. 3'), 'panel');
        assert.strictEqual(m.kindFromName('Mill OilHeaterGen3'), 'oil');
        assert.strictEqual(m.kindFromName('Mill ConvectionHeaterGen3'), 'convection');
        assert.strictEqual(m.kindFromName('Mill something'), 'unknown');
    });

    it('refines an unknown kind from the probed endpoints', () => {
        assert.strictEqual(m.refineKind('unknown', { oilPower: true }), 'oil');
        assert.strictEqual(m.refineKind('unknown', { socketMode: true }), 'socket');
        assert.strictEqual(m.refineKind('unknown', { limitedPower: true }), 'panel');
        assert.strictEqual(m.refineKind('socket', { oilPower: true }), 'socket');
    });

    it('normalises the off mode', () => {
        assert.strictEqual(m.normaliseMode('OFF'), 'Off');
        assert.strictEqual(m.normaliseMode('Off'), 'Off');
        assert.strictEqual(m.normaliseMode('Weekly program'), 'Weekly program');
        assert.ok(!m.OPERATION_MODES.Quatsch);
    });

    it('parses the open window text', () => {
        assert.deepStrictEqual(m.parseOpenWindow('Disabled not active now'), { enabled: false, active: false });
        assert.deepStrictEqual(m.parseOpenWindow('Enabled not active now'), { enabled: true, active: false });
        assert.deepStrictEqual(m.parseOpenWindow('Enabled active now'), { enabled: true, active: true });
    });

    it('rounds device floats and rejects garbage', () => {
        assert.strictEqual(m.round(19.200632095336914, 2), 19.2);
        assert.strictEqual(m.round('x'), null);
        assert.strictEqual(m.round(undefined), null);
    });

    it('normalises MAC addresses and recognises Mill status answers', () => {
        assert.strictEqual(m.macId('94:E6:86:00:12:34'), '94e686001234');
        assert.strictEqual(m.macId('foo'), '');
        assert.ok(m.isMillStatus({ name: 'Mill HeaterGen3Socket', version: '0x230421', mac_address: '94:E6:86:00:12:34' }));
        assert.ok(!m.isMillStatus({ name: 'Shelly', version: '1', mac_address: '94:E6:86:00:12:34' }));
    });

    it('validates configured intervals against the limits and the timer ceiling', () => {
        assert.strictEqual(m.intervalMs(30, 30, 10, 3600), 30000);
        assert.strictEqual(m.intervalMs('45', 30, 10, 3600), 45000);
        // empty, invalid, zero or negative values fall back to the default
        for (const bad of [undefined, null, '', 'x', 0, -5, NaN, Infinity]) {
            assert.strictEqual(m.intervalMs(bad, 30, 10, 3600), 30000, String(bad));
        }
        assert.strictEqual(m.intervalMs(1, 30, 10, 3600), 10000);
        assert.strictEqual(m.intervalMs(999999, 30, 10, 3600), 3600000);
        // even a range beyond the timer limit never yields a longer delay
        assert.strictEqual(m.intervalMs(1e12, 30, 10, 1e12), m.MAX_TIMER_MS);
    });

    it('reports the active target temperature, never 0 while off', () => {
        assert.strictEqual(m.activeTargetTemperature(17, 'Control individually'), 17);
        assert.strictEqual(m.activeTargetTemperature(21.5000001, 'Weekly program'), 21.5);
        assert.strictEqual(m.activeTargetTemperature(19, 'Independent device'), 19);
        assert.strictEqual(m.activeTargetTemperature(0, 'Off'), null);
        assert.strictEqual(m.activeTargetTemperature(17, 'Off'), null);
        assert.strictEqual(m.activeTargetTemperature(99, 'Switch'), null);
        assert.strictEqual(m.activeTargetTemperature(0, 'Switch'), null);
        assert.strictEqual(m.activeTargetTemperature(0, 'Control individually'), null);
        assert.strictEqual(m.activeTargetTemperature(undefined, 'Control individually'), null);
        assert.strictEqual(m.activeTargetTemperature(17, ''), null);
    });
});

describe('schedule.lastTimerType', () => {
    const assert = require('node:assert');
    const { lastTimerType, wallToMinutes } = require('../../lib/schedule');
    it('returns the type of the latest timer that has passed, in the time zone of the device', () => {
        const now = Date.UTC(2026, 10, 20, 12, 0);
        const timers = [
            { name: 'Off', timestamp: wallToMinutes('2026-11-20T12:30') },
            { name: 'AlwaysHeating', timestamp: wallToMinutes('2026-11-20T11:00') },
            { name: 'Normal', timestamp: wallToMinutes('2026-11-20T09:00') },
        ];
        // UTC device: 12:00 local -> AlwaysHeating (11:00) ran last
        assert.strictEqual(lastTimerType(timers, 1440, now), 'AlwaysHeating');
        // CET device: 13:00 local -> the Off timer (12:30) has passed
        assert.strictEqual(lastTimerType(timers, 60, now), 'Off');
        assert.strictEqual(lastTimerType([], 60, now), '');
        assert.strictEqual(lastTimerType(undefined, 60, now), '');
        assert.strictEqual(lastTimerType(timers, -600, now), '');
    });
});
