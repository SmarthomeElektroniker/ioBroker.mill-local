'use strict';

/*
 * Device manager cards with a fake adapter: the dm:* messages run through @iobroker/dm-utils exactly
 * like from the admin GUI. No real device is involved; writes are only recorded.
 */

const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { definitionsFor } = require('../../lib/states');
const { MillDeviceManagement, MODE_OPTIONS, INPUT_DELAY_MS } = require('../../lib/deviceManagement');
const TEXT = require('../../lib/dmTexts');

const NS = 'mill-local.0';
const MAC = 'aabbccddeeff';
const LANGUAGES = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];
/** Action/control IDs that would be configuration tasks - none of them may appear on a card */
const CONFIG_IDS = ['add', 'new', 'newDevice', 'discover', 'search', 'delete', 'pair', 'pairDevice', 'unpair'];

/**
 * @param {{allowControl?: boolean, caps?: Record<string, boolean>, devices?: object[]}} [opt] Options
 */
function fakeAdapter(opt = {}) {
    const allowControl = opt.allowControl !== false;
    const a = new EventEmitter();
    a.namespace = NS;
    a.allowControl = allowControl;
    a.log = { debug() {}, info() {}, warn() {}, error() {} };
    a.objects = {};
    a.states = {};
    a.writes = [];
    a.replies = [];
    a.timers = [];
    for (const d of definitionsFor(opt.caps || {}, allowControl)) {
        a.objects[`${NS}.${MAC}.${d.id}`] = { _id: `${NS}.${MAC}.${d.id}`, type: 'state', common: d.common };
    }
    const st = (val, ack = true) => ({ val, ack, ts: 1000, lc: 1000, from: `system.adapter.${NS}`, q: 0 });
    a.states[`${NS}.${MAC}.sensor.temperature`] = st(21.4);
    a.states[`${NS}.${MAC}.control.targetTemperature`] = st(21);
    a.states[`${NS}.${MAC}.control.operationMode`] = st('Control individually');
    a.states[`${NS}.${MAC}.control.power`] = st(true);
    a.states[`${NS}.${MAC}.status.power`] = st(830);
    a.devices = opt.devices || [
        { id: MAC, ip: '192.0.2.10', kind: 'panel', cfg: { name: 'Bad' } },
        { id: '', ip: '192.0.2.11', kind: 'unknown', cfg: { name: 'Neu' } },
    ];
    a.getForeignObjectsAsync = async pattern => {
        const prefix = pattern.replace(/\*$/, '');
        return Object.fromEntries(Object.entries(a.objects).filter(([id]) => id.startsWith(prefix)));
    };
    a.getForeignStateAsync = async id => a.states[id] || null;
    a.setForeignStateAsync = async (id, val, ack) => {
        a.writes.push({ id, val, ack });
        a.states[id] = { val, ack, ts: Date.now(), lc: Date.now(), from: `system.adapter.${NS}`, q: 0 };
    };
    a.setTimeout = (cb, ms) => {
        const t = { cb, ms, done: false };
        a.timers.push(t);
        return t;
    };
    a.clearTimeout = t => {
        t.done = true;
    };
    a.runTimers = () => {
        for (const t of a.timers.filter(x => !x.done)) {
            t.done = true;
            t.cb();
        }
    };
    a.sendTo = (to, command, message, callback) => a.replies.push({ to, command, message, callback });
    return a;
}

let msgId = 0;
/**
 * Sends a dm:* message like the GUI and waits for the answer.
 *
 * @param {any} a Fake adapter
 * @param {string} command Command
 * @param {unknown} message Payload
 */
async function ask(a, command, message) {
    const before = a.replies.length;
    a.emit('message', { _id: ++msgId, command, message, from: 'system.adapter.admin.0', callback: { id: msgId } });
    for (let i = 0; i < 50 && a.replies.length === before; i++) {
        await new Promise(r => setImmediate(r));
    }
    assert.ok(a.replies.length > before, `no answer to ${command}`);
    // the answer must survive the message transport
    return JSON.parse(JSON.stringify(a.replies[a.replies.length - 1].message));
}

/**
 * @param {any} a Fake adapter
 * @returns {Promise<object[]>} Device cards as the GUI receives them
 */
async function load(a) {
    new MillDeviceManagement(a);
    const r = await ask(a, 'dm:loadDevices', null);
    return r.add;
}

describe('device manager', () => {
    it('instance info: API v3 and no instance actions (no search, no add)', async () => {
        const a = fakeAdapter();
        new MillDeviceManagement(a);
        const info = await ask(a, 'dm:instanceInfo', null);
        assert.strictEqual(info.apiVersion, 'v3');
        assert.ok(!info.actions || info.actions.length === 0);
    });

    it('card shows operation, live values and the daily controls', async () => {
        const a = fakeAdapter({ caps: { humidity: true } });
        const [card, unknown] = await load(a);
        assert.strictEqual(card.id, MAC);
        assert.deepStrictEqual(card.name, { objectId: `${NS}.${MAC}`, property: 'common.name' });
        assert.strictEqual(card.status.connection.stateId, `${NS}.${MAC}.info.online`);
        assert.strictEqual(card.status.warning.stateId, `${NS}.${MAC}.info.operationKey`);
        assert.deepStrictEqual(
            card.controls.map(c => [c.id, c.type]),
            [
                ['sensor.temperature', 'info'],
                ['sensor.humidity', 'info'],
                ['control.targetTemperature', 'number'],
                ['control.operationMode', 'select'],
                ['control.power', 'switch'],
                ['status.power', 'info'],
                ['energy.today', 'info'],
            ],
        );
        for (const c of card.controls) {
            assert.strictEqual(c.stateId, `${NS}.${MAC}.${c.id}`);
            assert.ok(c.label && c.label.de, `${c.id}: label`);
        }
        const target = card.controls.find(c => c.id === 'control.targetTemperature');
        assert.deepStrictEqual([target.min, target.max, target.step, target.unit], [5, 35, 0.5, '°C']);
        assert.strictEqual(target.state.val, 21);
        assert.deepStrictEqual(
            card.controls.find(c => c.id === 'control.operationMode').options.map(o => o.value),
            ['Control individually', 'Weekly program', 'Independent device', 'Off', 'Switch'],
        );
        assert.deepStrictEqual(
            card.indicators.map(i => i.id),
            ['heating', 'openWindow'],
        );
        // only reading the device, no configuration
        assert.deepStrictEqual(
            card.actions.map(x => x.id),
            ['refresh'],
        );
        // the device that never answered: name and address, nothing to operate
        assert.strictEqual(unknown.id, 'ip-192.0.2.11');
        assert.strictEqual(unknown.name, 'Neu');
        assert.strictEqual(unknown.status, 'disconnected');
        assert.ok(!unknown.controls && !unknown.actions);
    });

    it('offers no configuration action or control on any card', async () => {
        const cards = await load(fakeAdapter({ caps: { humidity: true, pid: true, oilPower: true } }));
        for (const card of cards) {
            for (const x of [...(card.actions || []), ...(card.controls || [])]) {
                assert.ok(!CONFIG_IDS.includes(x.id) && !CONFIG_IDS.includes(x.icon), `${x.id} on the card`);
                assert.ok(!x.id.startsWith('settings.') && !x.id.startsWith('info.'), `${x.id} on the card`);
            }
        }
    });

    it('humidity only for devices that measure it', async () => {
        const [card] = await load(fakeAdapter());
        assert.ok(!card.controls.some(c => c.id === 'sensor.humidity'));
    });

    it('control disabled: values only, writing rejected', async () => {
        const a = fakeAdapter({ allowControl: false });
        const [card] = await load(a);
        assert.ok(card.controls.every(c => c.type === 'info'));
        const power = card.controls.find(c => c.id === 'control.power');
        assert.strictEqual(power.textTrue.de, 'Ein');
        const r = await ask(a, 'dm:deviceControl', { deviceId: MAC, controlId: 'control.power', state: false });
        assert.ok(r.result.error, 'control without handler must fail');
        assert.strictEqual(a.writes.length, 0);
    });

    it('switch and select write the state as command (ack=false)', async () => {
        const a = fakeAdapter();
        await load(a);
        let r = await ask(a, 'dm:deviceControl', { deviceId: MAC, controlId: 'control.power', state: false });
        assert.strictEqual(r.result.state.val, false);
        r = await ask(a, 'dm:deviceControl', {
            deviceId: MAC,
            controlId: 'control.operationMode',
            state: 'Weekly program',
        });
        assert.strictEqual(r.result.state.val, 'Weekly program');
        assert.deepStrictEqual(a.writes, [
            { id: `${NS}.${MAC}.control.power`, val: false, ack: false },
            { id: `${NS}.${MAC}.control.operationMode`, val: 'Weekly program', ack: false },
        ]);
    });

    it('an unknown operation mode is rejected before anything is written', async () => {
        const a = fakeAdapter();
        await load(a);
        const r = await ask(a, 'dm:deviceControl', {
            deviceId: MAC,
            controlId: 'control.operationMode',
            state: 'Turbo',
        });
        assert.ok(r.result.error);
        assert.strictEqual(a.writes.length, 0);
    });

    it('target temperature is sent once, after the input rests', async () => {
        const a = fakeAdapter();
        await load(a);
        for (const v of [2, 21, 21.5]) {
            const r = await ask(a, 'dm:deviceControl', {
                deviceId: MAC,
                controlId: 'control.targetTemperature',
                state: v,
            });
            assert.strictEqual(r.result.state.val, v);
        }
        assert.strictEqual(a.writes.length, 0, 'nothing sent while typing');
        assert.ok(a.timers.every(t => t.ms === INPUT_DELAY_MS));
        a.runTimers();
        await new Promise(r => setImmediate(r));
        assert.deepStrictEqual(a.writes, [{ id: `${NS}.${MAC}.control.targetTemperature`, val: 21.5, ack: false }]);
    });

    it('a half-typed temperature out of range is not sent', async () => {
        const a = fakeAdapter();
        await load(a);
        await ask(a, 'dm:deviceControl', { deviceId: MAC, controlId: 'control.targetTemperature', state: 2 });
        a.runTimers();
        await new Promise(r => setImmediate(r));
        assert.strictEqual(a.writes.length, 0);
    });

    it('reads the current value for the GUI and refreshes on request', async () => {
        const a = fakeAdapter();
        await load(a);
        let r = await ask(a, 'dm:deviceControlState', { deviceId: MAC, controlId: 'sensor.temperature' });
        assert.strictEqual(r.result.state.val, 21.4);
        r = await ask(a, 'dm:deviceAction', { deviceId: MAC, actionId: 'refresh' });
        assert.deepStrictEqual(r.result, { refresh: 'none' });
        assert.deepStrictEqual(a.writes, [{ id: `${NS}.${MAC}.refresh`, val: true, ack: false }]);
    });

    it('no devices: empty list', async () => {
        assert.deepStrictEqual(await load(fakeAdapter({ devices: [] })), []);
    });

    it('card texts are translated into all languages', () => {
        for (const [key, t] of Object.entries(TEXT)) {
            for (const l of LANGUAGES) {
                assert.ok(t[l], `${key}: ${l} missing`);
                if (l !== 'en') {
                    assert.notStrictEqual(t[l], t.en, `${key}: ${l} is not translated`);
                }
            }
        }
        assert.ok(MODE_OPTIONS.every(o => typeof o.label === 'object'));
    });
});
