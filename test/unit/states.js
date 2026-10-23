'use strict';

const assert = require('node:assert');
const { STATES, CHANNELS, definitionsFor } = require('../../lib/states');

const ALL_CAPS = { humidity: true, oilPower: true, limitedPower: true, socketMode: true, pid: true, hysteresis: true };
const LANGUAGES = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];

// Roles that require common.write = true resp. false (ioBroker state roles, checked by the repository checker)
const needsWrite = role => /^(level|switch|button)(\.|$)/.test(role);
const needsReadOnly = role => /^(value|indicator|sensor)(\.|$)/.test(role);

describe('object model', () => {
    for (const allow of [true, false]) {
        describe(`control ${allow ? 'enabled' : 'disabled'}`, () => {
            const defs = definitionsFor(ALL_CAPS, allow);

            it('uses roles that match the write flag', () => {
                for (const d of defs) {
                    const { role, write, read } = d.common;
                    assert.ok(role && role !== 'state', `${d.id}: generic role`);
                    assert.ok(!/^level\.mode$/.test(role), `${d.id}: level.mode is not a valid role`);
                    if (needsWrite(role)) {
                        assert.strictEqual(write, true, `${d.id}: role ${role} needs write=true`);
                    }
                    if (needsReadOnly(role)) {
                        assert.strictEqual(write, false, `${d.id}: role ${role} needs write=false`);
                    }
                    if (/^button/.test(role)) {
                        assert.strictEqual(read, false, `${d.id}: buttons are not readable`);
                    }
                }
            });

            it('names every state and channel in all eleven languages', () => {
                for (const name of [...defs.map(d => d.common.name), ...Object.values(CHANNELS)]) {
                    assert.deepStrictEqual(Object.keys(name).sort(), [...LANGUAGES].sort(), JSON.stringify(name));
                    for (const l of LANGUAGES.filter(x => x !== 'en')) {
                        assert.ok(name[l], `${name.en}: ${l} missing`);
                        assert.notStrictEqual(name[l], name.en, `${name.en}: ${l} is not translated`);
                    }
                }
            });
        });
    }

    it('drops the restart button and makes settings read-only without control', () => {
        const ids = definitionsFor(ALL_CAPS, false).map(d => d.id);
        assert.ok(!ids.includes('control.restart'));
        assert.ok(ids.includes('refresh'), 'reading the device stays possible');
        const target = definitionsFor(ALL_CAPS, false).find(d => d.id === 'control.targetTemperature');
        assert.strictEqual(target.common.write, false);
        assert.strictEqual(target.common.role, 'value.temperature');
        const writable = definitionsFor(ALL_CAPS, true).find(d => d.id === 'control.targetTemperature');
        assert.strictEqual(writable.common.role, 'level.temperature');
    });

    it('leaves out values of capabilities a device does not have', () => {
        const ids = definitionsFor({}, true).map(d => d.id);
        assert.ok(!ids.includes('sensor.humidity'));
        assert.ok(!ids.includes('settings.pidKp'));
        assert.ok(STATES.length > ids.length);
    });
});
