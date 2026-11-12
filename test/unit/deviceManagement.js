'use strict';

/*
 * Device manager cards with a fake adapter: the dm:* messages run through @iobroker/dm-utils exactly
 * like from the admin GUI. No real device is involved; writes are only recorded.
 */

const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { definitionsFor } = require('../../lib/states');
const { MillDeviceManagement, MODE_OPTIONS, toggleTarget, numberLineHtml } = require('../../lib/deviceManagement');
const TEXT = require('../../lib/dmTexts');

const NS = 'mill-local.0';
const MAC = 'aabbccddeeff';
const LANGUAGES = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];
/** Action/control IDs that would be configuration tasks - none of them may appear on a card */
const CONFIG_IDS = ['add', 'new', 'newDevice', 'discover', 'search', 'delete', 'pair', 'pairDevice', 'unpair'];

/**
 * @param {{allowControl?: boolean, caps?: Record<string, boolean>, devices?: object[], on?: boolean, mode?: string, lastActiveMode?: string}} [opt] Options
 */
function fakeAdapter(opt = {}) {
    const allowControl = opt.allowControl !== false;
    const a = new EventEmitter();
    a.namespace = NS;
    a.allowControl = allowControl;
    a.warnings = [];
    a.log = { debug() {}, info() {}, warn: m => a.warnings.push(m), error: m => a.warnings.push(m) };
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
    a.states[`${NS}.${MAC}.status.switchedOn`] = st(opt.on !== false);
    a.objects[`${NS}.${MAC}`] = { _id: `${NS}.${MAC}`, type: 'device', common: { name: 'Bad' } };
    a.devices = opt.devices || [
        {
            id: MAC,
            ip: '192.0.2.10',
            kind: 'panel',
            cfg: { name: 'Bad' },
            mode: opt.mode || 'Control individually',
            lastActiveMode: opt.lastActiveMode || 'Control individually',
        },
        { id: '', ip: '192.0.2.11', kind: 'unknown', cfg: { name: 'Neu' } },
    ];
    a.getForeignObjectsAsync = async pattern => {
        const prefix = pattern.replace(/\*$/, '');
        return Object.fromEntries(Object.entries(a.objects).filter(([id]) => id.startsWith(prefix)));
    };
    a.getForeignObjectAsync = async id => a.objects[id] || null;
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


/**
 * Clicks the on/off toggle like the GUI: action, confirmation dialog, answer.
 *
 * @param {any} a Fake adapter
 * @param {boolean} confirm Answer of the user
 * @returns {Promise<{question: any, result: any}>} Asked text and final answer
 */
async function clickToggle(a, confirm) {
    const asked = await ask(a, 'dm:deviceAction', { deviceId: MAC, actionId: 'powerToggle' });
    assert.strictEqual(asked.type, 'confirm', JSON.stringify(asked));
    const final = await ask(a, 'dm:actionProgress', { origin: asked.origin, confirm });
    assert.strictEqual(final.type, 'result');
    return { question: asked.confirm, result: final.result };
}

/**
 * Evaluates an HTML pattern of a staticText like the admin does (template string over _states).
 *
 * @param {string} html Pattern
 * @param {unknown} val Value of state v
 * @returns {string} Result
 */
const render = (html, val) => new Function('_states', `return \`${html}\`;`)({ v: { val } });

describe('device manager', () => {
    it('instance info: API v3, no instance actions, no identifier label', async () => {
        const a = fakeAdapter();
        new MillDeviceManagement(a);
        const info = await ask(a, 'dm:instanceInfo', null);
        assert.strictEqual(info.apiVersion, 'v3');
        assert.ok(!info.actions || info.actions.length === 0);
        assert.ok(!info.identifierLabel);
    });

    it('card: model only (no manufacturer, no MAC), toggle in the status line, values on the card', async () => {
        const a = fakeAdapter({ caps: { humidity: true } });
        const [card, unknown] = await load(a);
        assert.strictEqual(card.id, MAC);
        assert.deepStrictEqual(card.name, { objectId: `${NS}.${MAC}`, property: 'common.name' });
        assert.ok(!('manufacturer' in card) && !('identifier' in card), 'no manufacturer, no MAC');
        assert.ok(!JSON.stringify(card).includes('info.mac'), 'MAC state not on the card');
        assert.deepStrictEqual(card.model, { stateId: `${NS}.${MAC}.info.model` });
        assert.strictEqual(card.status.connection.stateId, `${NS}.${MAC}.info.online`);
        assert.strictEqual(card.status.warning.stateId, `${NS}.${MAC}.info.operationKey`);
        // no control dialog: the admin never asks for a control state
        assert.ok(!card.controls || card.controls.length === 0);
        // only the toggle, no refresh button
        assert.deepStrictEqual(
            card.actions.map(x => x.id),
            ['powerToggle'],
        );
        assert.deepStrictEqual(
            card.indicators.map(i => i.id),
            ['power', 'openWindow'],
        );
        const power = card.indicators[0];
        assert.strictEqual(power.value.stateId, `${NS}.${MAC}.status.switchedOn`);
        assert.strictEqual(power.actionId, 'powerToggle');
        assert.strictEqual(power.hideIfEmpty, false);
        assert.strictEqual(power.levels[0].value, true);
        assert.strictEqual(power.levels[0].text.de, 'Ein');
        assert.strictEqual(power.levels[0].tooltip.de, 'Ausschalten');
        assert.strictEqual(power.levels[1].value, false);
        assert.strictEqual(power.levels[1].text.de, 'Aus');
        assert.strictEqual(power.levels[1].tooltip.de, 'Einschalten');
        assert.notStrictEqual(power.levels[0].icon, power.levels[1].icon);

        const items = card.customInfo.schema.items;
        assert.deepStrictEqual(Object.keys(items), [
            'temperature',
            'humidity',
            'operationMode',
            'targetTemperature',
            'targetSlider',
            'power',
            'energyToday',
        ]);
        // numbers as text lines, never as a (read-only) state row that the admin draws as progress bar
        for (const key of ['temperature', 'humidity', 'targetTemperature', 'power', 'energyToday']) {
            assert.strictEqual(items[key].type, 'staticText', key);
            assert.strictEqual(items[key].format, 'html', key);
            assert.ok(items[key].dependsOnStates.v.startsWith(`${NS}.${MAC}.`), key);
        }
        assert.strictEqual(items.power.dependsOnStates.v, `${NS}.${MAC}.status.power`);
        assert.strictEqual(items.energyToday.dependsOnStates.v, `${NS}.${MAC}.energy.today`);
        assert.ok(render(items.humidity.text.func.de, 45.66).includes('>46<'));
        assert.ok(render(items.humidity.text.func.de, 45.66).includes('>%<'));
        assert.ok(render(items.power.text.func.de, 830).includes('>830<'));
        assert.ok(render(items.energyToday.text.func.de, 1.234).includes('>1,23<'));
        assert.ok(render(items.energyToday.text.func.en, 1.234).includes('>1.23<'));
        assert.ok(render(items.temperature.text.func.de, 20.62).includes('>20,6<'));
        assert.ok(render(items.power.text.func.de, 0).includes('Heizleistung'));

        // operation mode and target temperature: usable, also while the heater is off
        const mode = items.operationMode;
        assert.strictEqual(mode.type, 'state');
        assert.strictEqual(mode.control, 'select');
        assert.strictEqual(mode.oid, `${NS}.${MAC}.control.operationMode`);
        assert.ok(!mode.readOnly);
        assert.deepStrictEqual(
            mode.options.map(o => o.value),
            ['Control individually', 'Weekly program', 'Independent device', 'Off', 'Switch'],
        );
        const slider = items.targetSlider;
        assert.strictEqual(slider.control, 'slider');
        assert.strictEqual(slider.oid, `${NS}.${MAC}.control.targetTemperature`);
        assert.deepStrictEqual([slider.min, slider.max, slider.step], [5, 35, 0.5]);
        assert.ok(slider.controlDelay >= 500);

        // the device that never answered: name only, nothing to operate
        assert.strictEqual(unknown.id, 'ip-192.0.2.11');
        assert.strictEqual(unknown.name, 'Neu');
        assert.strictEqual(unknown.status, 'disconnected');
        assert.ok(!unknown.controls && !unknown.actions && !unknown.identifier);
    });

    it('card is the same while the heater is off (mode and target stay usable)', async () => {
        const [card] = await load(fakeAdapter({ on: false, mode: 'Off' }));
        assert.ok(!card.customInfo.schema.items.operationMode.readOnly);
        assert.ok(card.customInfo.schema.items.targetSlider);
    });

    it('offers no configuration action or control on any card', async () => {
        const cards = await load(fakeAdapter({ caps: { humidity: true, pid: true, oilPower: true } }));
        for (const card of cards) {
            for (const x of [...(card.actions || []), ...(card.controls || [])]) {
                assert.ok(!CONFIG_IDS.includes(x.id) && !CONFIG_IDS.includes(x.icon), `${x.id} on the card`);
                assert.ok(x.id !== 'refresh', 'no refresh button');
            }
            const oids = Object.values((card.customInfo && card.customInfo.schema.items) || {}).map(
                i => i.oid || (i.dependsOnStates && i.dependsOnStates.v) || '',
            );
            assert.ok(!oids.some(o => o.includes('.settings.') || o.includes('.info.')), oids.join());
        }
    });

    it('humidity only for devices that measure it', async () => {
        const [card] = await load(fakeAdapter());
        assert.ok(!card.customInfo.schema.items.humidity);
    });

    it('control disabled: values only, the toggle shows the state but switches nothing', async () => {
        const a = fakeAdapter({ allowControl: false });
        const [card] = await load(a);
        assert.deepStrictEqual(card.actions, []);
        assert.ok(!card.indicators[0].actionId);
        assert.strictEqual(card.indicators[0].levels[0].tooltip.de, 'Eingeschaltet');
        assert.strictEqual(card.customInfo.schema.items.operationMode.readOnly, true);
        assert.ok(!card.customInfo.schema.items.targetSlider);
        const r = await ask(a, 'dm:deviceAction', { deviceId: MAC, actionId: 'powerToggle' });
        assert.ok(r.result.error);
        assert.strictEqual(a.writes.length, 0);
    });

    it('toggle switches off after confirmation (control.power=false, ack=false)', async () => {
        const a = fakeAdapter();
        await load(a);
        const { question, result } = await clickToggle(a, true);
        assert.strictEqual(question.de, '„Bad“ ausschalten?');
        assert.deepStrictEqual(result, { refresh: 'none' });
        assert.deepStrictEqual(a.writes, [{ id: `${NS}.${MAC}.control.power`, val: false, ack: false }]);
    });

    it('toggle does nothing when the confirmation is cancelled', async () => {
        const a = fakeAdapter();
        await load(a);
        await clickToggle(a, false);
        assert.strictEqual(a.writes.length, 0);
    });

    it('toggle switches on into the last active mode and names it', async () => {
        const a = fakeAdapter({ on: false, mode: 'Off', lastActiveMode: 'Weekly program' });
        await load(a);
        const { question } = await clickToggle(a, true);
        assert.strictEqual(question.de, '„Bad“ einschalten (Wochenprogramm)?');
        assert.deepStrictEqual(a.writes, [
            { id: `${NS}.${MAC}.control.operationMode`, val: 'Weekly program', ack: false },
        ]);
    });

    it('toggle target: only documented modes, "Switch" via the relay', () => {
        assert.deepStrictEqual(toggleTarget(true, 'Control individually', 'Control individually'), {
            rel: 'control.power',
            val: false,
            mode: 'Off',
        });
        assert.deepStrictEqual(toggleTarget(true, 'Switch', 'Switch'), {
            rel: 'control.power',
            val: false,
            mode: 'Switch',
        });
        assert.deepStrictEqual(toggleTarget(false, 'Switch', 'Switch'), {
            rel: 'control.power',
            val: true,
            mode: 'Switch',
        });
        assert.deepStrictEqual(toggleTarget(false, 'Off', 'Switch'), {
            rel: 'control.power',
            val: true,
            mode: 'Switch',
        });
        assert.deepStrictEqual(toggleTarget(false, 'Off', 'Independent device'), {
            rel: 'control.operationMode',
            val: 'Independent device',
            mode: 'Independent device',
        });
        // unknown values would switch the real device off - never sent
        for (const last of ['Turbo', '', undefined, 'Off', 'OFF']) {
            assert.deepStrictEqual(toggleTarget(false, 'Off', last), {
                rel: 'control.operationMode',
                val: 'Control individually',
                mode: 'Control individually',
            });
        }
    });

    it('no warnings from dm-utils (e.g. "Device get state ... has no handler")', async () => {
        const a = fakeAdapter({ caps: { humidity: true } });
        const cards = await load(a);
        for (const card of cards) {
            for (const c of card.controls || []) {
                // a control would make the admin ask dm:deviceControlState
                const r = await ask(a, 'dm:deviceControlState', { deviceId: card.id, controlId: c.id });
                assert.ok(!r.result.error, `${c.id}: ${JSON.stringify(r.result)}`);
            }
        }
        await clickToggle(a, false);
        assert.deepStrictEqual(a.warnings, []);
    });

    it('number lines: no curly braces inside the expression, value right, unit beside it', () => {
        const html = numberLineHtml({ en: 'Humidity', de: 'Luftfeuchtigkeit' }, '%', 0);
        for (const h of Object.values(html)) {
            const expr = h.match(/\$\{(.*?)\}/g);
            assert.strictEqual(expr.length, 1);
            assert.ok(!expr[0].slice(2, -1).includes('{'));
        }
        assert.ok(render(html.de, 61.4).includes('Luftfeuchtigkeit'));
        assert.ok(render(html.de, 61.4).includes('>61<'));
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
