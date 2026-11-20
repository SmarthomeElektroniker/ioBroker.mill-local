const path = require('node:path');
const assert = require('node:assert');
const { tests } = require('@iobroker/testing');
const { createFakeMill } = require('./fakeMill');

// Starts a temporary js-controller, installs the adapter and checks that it starts cleanly
// without any configured device. Locally: IOB_CONTROLLER=latest npm run test:integration
tests.integration(path.join(__dirname, '..'), {
    controllerVersion: process.env.IOB_CONTROLLER || undefined,

    defineAdditionalTests({ suite }) {
        suite('Against a simulated Mill socket', getHarness => {
            let fake;
            before(async () => {
                fake = await createFakeMill({ mac: '94:E6:86:00:00:01', delayMs: 100 });
            });
            after(async () => {
                await fake.close();
            });

            it('reads the device and executes validated commands', async function () {
                this.timeout(60000);
                const harness = getHarness();
                await harness.changeAdapterConfig('mill-local', {
                    native: {
                        devices: [{ enabled: true, name: 'Sim', ip: fake.host, mac: '', useApiKey: false }],
                        pollInterval: 10,
                        slowInterval: 60,
                        timeout: 2,
                        allowControl: true,
                        rediscover: false,
                    },
                });
                const dev = 'mill-local.0.94e686000001';
                // a duplicate from 0.1.x that must be removed on start
                await harness.objects.setObjectAsync(`${dev}.status.operationMode`, {
                    type: 'state',
                    common: { type: 'string', role: 'text', name: 'old', read: true, write: false },
                    native: {},
                });
                await harness.startAdapterAndWait();
                const waitFor = async (id, pred, ms = 15000) => {
                    const end = Date.now() + ms;
                    for (;;) {
                        const s = await harness.states.getStateAsync(id);
                        if (s && s.ack && pred(s.val)) {
                            return s;
                        }
                        if (Date.now() > end) {
                            throw new Error(`${id} did not reach the expected value, last: ${JSON.stringify(s)}`);
                        }
                        await new Promise(r => setTimeout(r, 300));
                    }
                };
                await waitFor(`${dev}.sensor.temperature`, v => v === 19.2);
                await waitFor(`${dev}.info.type`, v => v === 'socket');
                await waitFor(`${dev}.info.online`, v => v === true);
                await waitFor('mill-local.0.info.connection', v => v === true);
                await waitFor(`${dev}.settings.temperatureComfort`, v => v === 22);
                await waitFor(`${dev}.settings.calibrationOffset`, v => v === -1.5);
                await waitFor(`${dev}.status.lockActive`, v => v === 'No lock');
                await waitFor(`${dev}.status.activeTargetTemperature`, v => v === 20);
                assert.ok(
                    !(await harness.objects.getObjectAsync(`${dev}.settings.oilHeaterPower`)),
                    'socket has no oil power',
                );
                assert.ok(!(await harness.objects.getObjectAsync(`${dev}.status.operationMode`)), 'duplicate removed');
                const cal = await harness.objects.getObjectAsync(`${dev}.settings.calibrationOffset`);
                assert.strictEqual(cal.common.write, true, 'settings are writable');

                await harness.states.setStateAsync(`${dev}.control.targetTemperature`, { val: 18.5, ack: false });
                await waitFor(`${dev}.control.targetTemperature`, v => v === 18.5);
                assert.strictEqual(fake.state.temps.Normal, 18.5);

                // invalid mode must not be sent (the real device would switch itself off)
                const before = fake.state.requests.filter(r => r.method === 'POST').length;
                await harness.states.setStateAsync(`${dev}.control.operationMode`, { val: 'Nonsense', ack: false });
                await new Promise(r => setTimeout(r, 1500));
                assert.strictEqual(fake.state.requests.filter(r => r.method === 'POST').length, before);
                assert.strictEqual(fake.state.mode, 'Control individually');

                // ON in a thermostat mode: already on, nothing changes - no permanent heating
                await harness.states.setStateAsync(`${dev}.control.power`, { val: true, ack: false });
                await waitFor(`${dev}.control.power`, v => v === true);
                await new Promise(r => setTimeout(r, 1000));
                assert.strictEqual(fake.state.mode, 'Control individually');
                assert.strictEqual(fake.state.forced, null);
                // OFF in a thermostat mode: operation mode Off
                await harness.states.setStateAsync(`${dev}.control.power`, { val: false, ack: false });
                await waitFor(`${dev}.control.operationMode`, v => v === 'Off');
                await waitFor(`${dev}.control.power`, v => v === false);
                assert.strictEqual(fake.state.mode, 'OFF');
                // ON from Off: back into the last thermostat mode
                await harness.states.setStateAsync(`${dev}.control.power`, { val: true, ack: false });
                await waitFor(`${dev}.control.operationMode`, v => v === 'Control individually');
                await waitFor(`${dev}.control.power`, v => v === true);
                assert.strictEqual(fake.state.mode, 'Control individually');
                assert.strictEqual(fake.state.forced, null);
                // permanent heating only via the operation mode "Switch": there control.power is the relay
                await harness.states.setStateAsync(`${dev}.control.operationMode`, { val: 'Switch', ack: false });
                await waitFor(`${dev}.control.operationMode`, v => v === 'Switch');
                await waitFor(`${dev}.control.power`, v => v === false);
                await harness.states.setStateAsync(`${dev}.control.power`, { val: true, ack: false });
                await waitFor(`${dev}.status.heating`, v => v === true);
                assert.strictEqual(fake.state.forced, 99);
                await harness.states.setStateAsync(`${dev}.control.power`, { val: false, ack: false });
                await waitFor(`${dev}.status.heating`, v => v === false);
                await waitFor(`${dev}.control.operationMode`, v => v === 'Switch');
                assert.strictEqual(fake.state.forced, 0);
                await harness.states.setStateAsync(`${dev}.control.operationMode`, {
                    val: 'Control individually',
                    ack: false,
                });
                await waitFor(`${dev}.control.operationMode`, v => v === 'Control individually');

                // operation mode written directly and kept (no stale reading may turn it back)
                await harness.states.setStateAsync(`${dev}.control.operationMode`, {
                    val: 'Weekly program',
                    ack: false,
                });
                await waitFor(`${dev}.control.operationMode`, v => v === 'Weekly program');
                await new Promise(r => setTimeout(r, 2500));
                assert.strictEqual(
                    (await harness.states.getStateAsync(`${dev}.control.operationMode`)).val,
                    'Weekly program',
                );
                assert.strictEqual(fake.state.mode, 'Weekly program');

                // settings are written to the device
                await harness.states.setStateAsync(`${dev}.settings.calibrationOffset`, { val: -2, ack: false });
                await waitFor(`${dev}.settings.calibrationOffset`, v => v === -2);
                assert.strictEqual(fake.state.calibration, -2);

                // weekly program in readable JSON
                await harness.states.setStateAsync(`${dev}.settings.weeklyProgram`, {
                    val: '[{"day":"Mon","time":"06:30","type":"Comfort"}]',
                    ack: false,
                });
                await waitFor(
                    `${dev}.settings.weeklyProgram`,
                    v => v === '[{"day":"Mon","time":"06:30","type":"Comfort"}]',
                );
                assert.deepStrictEqual(fake.state.weekly, [{ name: 'Comfort', timestamp: 390 }]);

                await harness.states.setStateAsync(`${dev}.settings.openWindowDetection`, { val: true, ack: false });
                await waitFor(`${dev}.settings.openWindowDetection`, v => v === true);
                const ow = fake.state.requests.filter(r => r.method === 'POST' && r.path === 'open-window').pop();
                assert.strictEqual(JSON.parse(ow.body).max_time, 3600, 'full parameter set is sent');

                // device manager: the card lists the device, its on/off toggle reaches the (simulated) device
                await harness.enableSendTo();
                const dm = (command, message) =>
                    new Promise(resolve => harness.sendTo('mill-local.0', command, message, resolve));
                const info = await dm('dm:instanceInfo', null);
                assert.strictEqual(info.apiVersion, 'v3');
                assert.ok(!info.actions || info.actions.length === 0, 'no instance actions');
                const list = await dm('dm:loadDevices', null);
                assert.strictEqual(list.add.length, 1);
                const card = list.add[0];
                assert.strictEqual(card.id, '94e686000001');
                assert.ok(!card.identifier && !card.manufacturer, 'no MAC, no manufacturer');
                assert.ok(!card.controls || card.controls.length === 0, 'no control dialog');
                assert.deepStrictEqual(
                    card.actions.map(a => a.id),
                    ['powerToggle', 'weeklyProgram'],
                );
                assert.strictEqual(card.indicators[0].value.stateId, `${dev}.status.switchedOn`);
                // weekly program is running -> switched on; the toggle asks, then switches off
                await waitFor(`${dev}.status.switchedOn`, v => v === true);
                const click = async confirm => {
                    const asked = await dm('dm:deviceAction', { deviceId: card.id, actionId: 'powerToggle' });
                    assert.strictEqual(asked.type, 'confirm', JSON.stringify(asked));
                    const done = await dm('dm:actionProgress', { origin: asked.origin, confirm });
                    assert.deepStrictEqual(done.result, { refresh: 'none' });
                    return asked.confirm;
                };
                assert.ok((await click(true)).en.includes('Switch off'));
                await waitFor(`${dev}.control.operationMode`, v => v === 'Off');
                await waitFor(`${dev}.status.switchedOn`, v => v === false);
                assert.strictEqual(fake.state.mode, 'OFF');
                // on again: back into the last active mode, not into permanent heating
                assert.ok((await click(true)).en.includes('Weekly program'));
                await waitFor(`${dev}.control.operationMode`, v => v === 'Weekly program');
                await waitFor(`${dev}.status.switchedOn`, v => v === true);
                assert.strictEqual(fake.state.mode, 'Weekly program');
                // cancelled: nothing is sent
                const posts = fake.state.requests.filter(r => r.method === 'POST').length;
                await click(false);
                await new Promise(r => setTimeout(r, 1000));
                assert.strictEqual(fake.state.requests.filter(r => r.method === 'POST').length, posts);
                // the mode select of the card writes the state: a thermostat mode switches on from Off
                await harness.states.setStateAsync(`${dev}.control.operationMode`, { val: 'Off', ack: false });
                await waitFor(`${dev}.status.switchedOn`, v => v === false);
                await harness.states.setStateAsync(`${dev}.control.operationMode`, {
                    val: 'Control individually',
                    ack: false,
                });
                await waitFor(`${dev}.status.switchedOn`, v => v === true);
                // "Switch" with the relay open counts as off, the toggle closes the relay
                await harness.states.setStateAsync(`${dev}.control.operationMode`, { val: 'Switch', ack: false });
                await waitFor(`${dev}.control.operationMode`, v => v === 'Switch');
                await waitFor(`${dev}.status.switchedOn`, v => v === false);
                await click(true);
                await waitFor(`${dev}.status.switchedOn`, v => v === true);
                assert.strictEqual(fake.state.forced, 99);
            });
        });

        // Failure scenarios after the pattern of the ioBroker.millheater tests (webbummler, MIT):
        // invalid answers, timeout, a write during a running poll and the shutdown with a request on the wire
        suite('Failure scenarios against a simulated Mill socket', getHarness => {
            let fake;
            const dev = 'mill-local.0.94e686000002';
            before(async () => {
                fake = await createFakeMill({ mac: '94:E6:86:00:00:02' });
            });
            after(async () => {
                await fake.close();
            });

            it('keeps the last valid values, survives timeouts, serialises writes and cancels on shutdown', async function () {
                this.timeout(90000);
                const harness = getHarness();
                await harness.changeAdapterConfig('mill-local', {
                    native: {
                        devices: [
                            { enabled: true, name: 'Sim2', ip: fake.host, mac: '94:E6:86:00:00:02', useApiKey: false },
                        ],
                        // no automatic polls during the test: every cycle is started with refresh
                        pollInterval: 3600,
                        slowInterval: 3600,
                        timeout: 1,
                        allowControl: true,
                        rediscover: false,
                    },
                });
                await harness.startAdapterAndWait();
                const sleep = ms => new Promise(r => setTimeout(r, ms));
                const waitFor = async (id, pred, ms = 15000) => {
                    const end = Date.now() + ms;
                    for (;;) {
                        const s = await harness.states.getStateAsync(id);
                        if (s && s.ack && pred(s.val)) {
                            return s;
                        }
                        if (Date.now() > end) {
                            throw new Error(`${id} did not reach the expected value, last: ${JSON.stringify(s)}`);
                        }
                        await sleep(200);
                    }
                };
                const count = path => fake.state.requests.filter(r => r.path === path).length;
                const poll = async () => {
                    const n = count('control-status');
                    await harness.states.setStateAsync(`${dev}.refresh`, { val: true, ack: false });
                    const end = Date.now() + 10000;
                    while (count('control-status') <= n) {
                        if (Date.now() > end) {
                            throw new Error('no poll');
                        }
                        await sleep(50);
                    }
                };
                const alive = async () =>
                    assert.strictEqual(
                        (await harness.states.getStateAsync('system.adapter.mill-local.0.alive')).val,
                        true,
                    );

                await waitFor(`${dev}.sensor.temperature`, v => v === 19.2);
                await waitFor(`${dev}.info.online`, v => v === true);
                await waitFor(`${dev}.status.switchedOn`, v => v === true);

                // 1. invalid answers: last valid values stay (ack), the adapter keeps running
                for (const mode of ['invalid-json', 'empty', 'api-error', 'http-error', 'not-mill']) {
                    fake.state.responseMode = mode;
                    await poll();
                    await sleep(400);
                    for (const [id, val] of [
                        ['sensor.temperature', 19.2],
                        ['status.switchedOn', true],
                        ['control.operationMode', 'Control individually'],
                    ]) {
                        const st = await harness.states.getStateAsync(`${dev}.${id}`);
                        assert.strictEqual(st.val, val, `${id} changed after ${mode}`);
                        assert.strictEqual(st.ack, true);
                    }
                    await alive();
                }
                // three failed polls in a row: offline (and info.connection false - no device reachable)
                await waitFor(`${dev}.info.online`, v => v === false);
                await waitFor('mill-local.0.info.connection', v => v === false);
                fake.state.responseMode = 'valid';
                fake.state.ambient = 20.5;
                await poll();
                await waitFor(`${dev}.sensor.temperature`, v => v === 20.5);
                await waitFor(`${dev}.info.online`, v => v === true);
                await waitFor('mill-local.0.info.connection', v => v === true);

                // 2. timeout: the device accepts the connection and never answers
                fake.state.responseMode = 'hang';
                await poll();
                await sleep(2500);
                assert.strictEqual((await harness.states.getStateAsync(`${dev}.sensor.temperature`)).val, 20.5);
                await alive();
                fake.state.responseMode = 'valid';
                fake.state.ambient = 21;
                await poll();
                await waitFor(`${dev}.sensor.temperature`, v => v === 21);

                // 3. a write during a running poll waits for it and is not overwritten by the older reading
                fake.state.delays['control-status'] = 700;
                fake.state.maxConcurrent = 0;
                await poll();
                await harness.states.setStateAsync(`${dev}.control.targetTemperature`, { val: 22.5, ack: false });
                await waitFor(`${dev}.control.targetTemperature`, v => v === 22.5);
                await sleep(2500);
                assert.strictEqual((await harness.states.getStateAsync(`${dev}.control.targetTemperature`)).val, 22.5);
                assert.strictEqual(fake.state.temps.Normal, 22.5);
                assert.strictEqual(fake.state.maxConcurrent, 1, 'never two requests at the same time');

                // 4. shutdown while a request is on the wire: the queued write is never sent, no waiting for the answer
                fake.state.delays['control-status'] = 4000;
                await poll();
                const posts = fake.state.requests.filter(r => r.method === 'POST').length;
                await harness.states.setStateAsync(`${dev}.control.targetTemperature`, { val: 18, ack: false });
                await sleep(300);
                assert.strictEqual(fake.state.requests.filter(r => r.method === 'POST').length, posts, 'write waits');
                const t0 = Date.now();
                await harness.stopAdapter();
                const took = Date.now() - t0;
                await sleep(4500);
                assert.strictEqual(
                    fake.state.requests.filter(r => r.method === 'POST').length,
                    posts,
                    'queued write was sent during shutdown',
                );
                assert.strictEqual(fake.state.temps.Normal, 22.5);
                assert.ok(took < 3500, `stop took ${took} ms (waited for the slow answer?)`);
            });
        });
        // Several device kinds in one instance: oil heater, panel heater, Wi-Fi socket, convection heater -
        // kind-specific values, weekly program (also via the dialog of the device card), timers, vacation,
        // clock without NTP, open window, child lock, an unknown reported mode, a dropped connection and
        // the operation-mode trap of the device
        suite('Several simulated device kinds in one instance', getHarness => {
            const { createFakeMill: create } = require('./fakeMill');
            const fakes = {};
            const MACS = {
                socket: '94:E6:86:00:10:01',
                panel: '94:E6:86:00:10:02',
                oil: '94:E6:86:00:10:03',
                convection: '94:E6:86:00:10:04',
            };
            const id = kind => `mill-local.0.${MACS[kind].replace(/:/g, '').toLowerCase()}`;
            before(async () => {
                for (const kind of Object.keys(MACS)) {
                    fakes[kind] = await create({ kind, mac: MACS[kind], customName: `Sim ${kind}`, rebootMs: 1500 });
                }
            });
            after(async () => {
                for (const f of Object.values(fakes)) {
                    await f.close();
                }
            });

            it('handles every kind, schedules and failures independently', async function () {
                this.timeout(240000);
                const harness = getHarness();
                await harness.changeAdapterConfig('mill-local', {
                    native: {
                        devices: Object.keys(MACS).map(kind => ({
                            enabled: true,
                            name: `Sim ${kind}`,
                            ip: fakes[kind].host,
                            mac: MACS[kind],
                            useApiKey: false,
                        })),
                        pollInterval: 3600,
                        slowInterval: 3600,
                        timeout: 1,
                        allowControl: true,
                        rediscover: false,
                        syncTimezone: true,
                    },
                });
                await harness.startAdapterAndWait();
                const sleep = ms => new Promise(r => setTimeout(r, ms));
                const waitFor = async (sid, pred, ms = 15000) => {
                    const end = Date.now() + ms;
                    for (;;) {
                        const st = await harness.states.getStateAsync(sid);
                        if (st && st.ack && pred(st.val)) {
                            return st;
                        }
                        if (Date.now() > end) {
                            throw new Error(`${sid} did not reach the expected value, last: ${JSON.stringify(st)}`);
                        }
                        await sleep(200);
                    }
                };
                const set = (sid, val) => harness.states.setStateAsync(sid, { val, ack: false });
                const refresh = async kind => {
                    const f = fakes[kind];
                    const n = f.state.requests.filter(r => r.path === 'control-status').length;
                    await set(`${id(kind)}.refresh`, true);
                    const end = Date.now() + 10000;
                    while (f.state.requests.filter(r => r.path === 'control-status').length <= n) {
                        if (Date.now() > end) {
                            throw new Error(`no poll of ${kind}`);
                        }
                        await sleep(50);
                    }
                    // the refresh also reads the settings - wait until the cycle is through
                    await sleep(600);
                };
                const posts = (kind, path) =>
                    fakes[kind].state.requests.filter(r => r.method === 'POST' && (!path || r.path === path));

                // 1. kinds and their own values
                for (const kind of Object.keys(MACS)) {
                    await waitFor(`${id(kind)}.info.type`, v => v === kind, 20000);
                    await waitFor(`${id(kind)}.info.online`, v => v === true);
                }
                await waitFor('mill-local.0.info.connection', v => v === true);
                const exists = async sid => !!(await harness.objects.getObjectAsync(sid));
                assert.ok(await exists(`${id('oil')}.settings.oilHeaterPower`));
                assert.ok(!(await exists(`${id('oil')}.settings.limitedHeatingPower`)));
                assert.ok(await exists(`${id('panel')}.settings.limitedHeatingPower`));
                assert.ok(await exists(`${id('panel')}.settings.pidKp`));
                assert.ok(await exists(`${id('socket')}.sensor.humidity`));
                assert.ok(await exists(`${id('socket')}.settings.additionalSocketMode`));
                assert.ok(!(await exists(`${id('convection')}.sensor.humidity`)));
                assert.ok(!(await exists(`${id('convection')}.settings.oilHeaterPower`)));
                assert.ok(!(await exists(`${id('convection')}.settings.limitedHeatingPower`)));
                await waitFor(`${id('oil')}.settings.oilHeaterPower`, v => v === 100);
                await waitFor(`${id('panel')}.settings.limitedHeatingPower`, v => v === 75);
                await waitFor(`${id('panel')}.settings.pidKp`, v => v === 70);

                // power level (PV surplus): valid values reach the device, invalid ones are never sent
                await set(`${id('oil')}.settings.oilHeaterPower`, 40);
                await waitFor(`${id('oil')}.settings.oilHeaterPower`, v => v === 40);
                assert.strictEqual(fakes.oil.state.oilPower, 40);
                const oilPosts = posts('oil').length;
                await set(`${id('oil')}.settings.oilHeaterPower`, 50);
                await waitFor(`${id('oil')}.settings.oilHeaterPower`, v => v === 40);
                await sleep(800);
                assert.strictEqual(posts('oil').length, oilPosts, 'invalid power level was sent');
                await set(`${id('panel')}.settings.limitedHeatingPower`, 55);
                await waitFor(`${id('panel')}.settings.limitedHeatingPower`, v => v === 55);
                assert.strictEqual(fakes.panel.state.limitedPower, 55);
                // the heating power follows the level: oil heater 1500 W x 40 %
                fakes.oil.state.temps.Normal = 30;
                await refresh('oil');
                await waitFor(`${id('oil')}.status.power`, v => v === 600);
                await waitFor(`${id('oil')}.status.heating`, v => v === true);
                // the socket reports switched_on=false while its relay is closed: heating follows the signal
                fakes.socket.state.temps.Normal = 30;
                await refresh('socket');
                await waitFor(`${id('socket')}.status.heating`, v => v === true);

                // 2. weekly program via the dialog of the device card, then the device follows its clock
                const tz = -new Date().getTimezoneOffset();
                await waitFor(`${id('panel')}.settings.timezoneOffset`, v => v === tz);
                assert.strictEqual(fakes.panel.state.timezone, tz, 'time zone of the device set from the host');
                await harness.enableSendTo();
                const dm = (command, message) =>
                    new Promise(resolve => harness.sendTo('mill-local.0', command, message, resolve));
                const list = await dm('dm:loadDevices', null);
                assert.strictEqual(list.add.length, 4);
                const panelId = id('panel').split('.').pop();
                const card = list.add.find(c => c.id === panelId);
                assert.ok(card.actions.some(a => a.id === 'weeklyProgram'));
                const asked = await dm('dm:deviceAction', { deviceId: panelId, actionId: 'weeklyProgram' });
                assert.strictEqual(asked.type, 'form', JSON.stringify(asked).slice(0, 300));
                assert.deepStrictEqual(asked.form.data.entries, []);
                assert.strictEqual(asked.form.data.activate, false);
                const rows = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].flatMap(day => [
                    { day, time: '00:00', type: 'Comfort' },
                    { day, time: '12:00', type: 'Sleep' },
                ]);
                const done = await dm('dm:actionProgress', {
                    origin: asked.origin,
                    data: { entries: rows, activate: true },
                });
                assert.deepStrictEqual(done.result, { refresh: 'none' });
                await waitFor(`${id('panel')}.control.operationMode`, v => v === 'Weekly program');
                await waitFor(`${id('panel')}.settings.weeklyProgram`, v => JSON.parse(v).length === 14);
                assert.strictEqual(fakes.panel.state.weekly.length, 14);
                assert.strictEqual(fakes.panel.state.mode, 'Weekly program');
                // move the clock of the device: local 10:00 -> Comfort (22), local 13:00 -> Sleep (18)
                const shiftTo = minuteOfDay => {
                    const local = Math.floor(Date.now() / 60000) + tz;
                    fakes.panel.state.clockShiftMs = (minuteOfDay - (((local % 1440) + 1440) % 1440)) * 60000;
                };
                shiftTo(600);
                await refresh('panel');
                await waitFor(`${id('panel')}.status.activeTargetTemperature`, v => v === 22);
                shiftTo(780);
                await refresh('panel');
                await waitFor(`${id('panel')}.status.activeTargetTemperature`, v => v === 18);
                // without a valid time (no NTP) the device ignores the program and stays on Normal
                fakes.panel.state.timeValid = false;
                await refresh('panel');
                await waitFor(`${id('panel')}.status.activeTargetTemperature`, v => v === 20);
                fakes.panel.state.timeValid = true;
                // vacation covering now: Away (15)
                const wall = ms => new Date(ms + tz * 60000).toISOString().slice(0, 16);
                const now = Date.now() + fakes.panel.state.clockShiftMs;
                await set(
                    `${id('panel')}.settings.vacation`,
                    JSON.stringify({ start: wall(now - 3600000), end: wall(now + 86400000) }),
                );
                await waitFor(`${id('panel')}.settings.vacation`, v => v !== '{}');
                await refresh('panel');
                await waitFor(`${id('panel')}.status.activeTargetTemperature`, v => v === 15);
                await set(`${id('panel')}.settings.vacation`, '{}');
                await waitFor(`${id('panel')}.settings.vacation`, v => v === '{}');
                assert.strictEqual(fakes.panel.state.vacation.start_timestamp, 0);
                // the dialog shows the program it wrote; a broken row is refused with a message, nothing sent
                const again = await dm('dm:deviceAction', { deviceId: panelId, actionId: 'weeklyProgram' });
                assert.strictEqual(again.form.data.entries.length, 14);
                assert.strictEqual(again.form.data.activate, true);
                const before = posts('panel', 'weekly-program').length;
                const refused = await dm('dm:actionProgress', {
                    origin: again.origin,
                    data: { entries: [{ day: 'Mon', time: '25:00', type: 'Comfort' }], activate: false },
                });
                assert.strictEqual(refused.type, 'message', JSON.stringify(refused).slice(0, 300));
                assert.ok(refused.message.en.includes('invalid time'));
                await dm('dm:actionProgress', { origin: refused.origin });
                await sleep(800);
                assert.strictEqual(posts('panel', 'weekly-program').length, before);

                // one-off timers (Independent device): an "Off" timer that has passed switches the regulation off
                // device clock back to real time (the adapter compares timers with the host clock)
                fakes.panel.state.clockShiftMs = 0;
                const tnow = Date.now();
                await set(
                    `${id('panel')}.settings.timers`,
                    JSON.stringify([{ time: wall(tnow - 120000), type: 'Off' }]),
                );
                await waitFor(`${id('panel')}.settings.timers`, v => JSON.parse(v).length === 1);
                await set(`${id('panel')}.control.operationMode`, 'Independent device');
                await waitFor(`${id('panel')}.control.operationMode`, v => v === 'Independent device');
                await refresh('panel');
                await waitFor(`${id('panel')}.status.activeTargetTemperature`, v => v === null);
                await waitFor(`${id('panel')}.status.heating`, v => v === false);
                // the timer reports the same values as "Switch" with the relay open - still shown as Independent device
                assert.strictEqual(
                    (await harness.states.getStateAsync(`${id('panel')}.control.operationMode`)).val,
                    'Independent device',
                );
                await waitFor(`${id('panel')}.status.switchedOn`, v => v === true);
                await set(`${id('panel')}.settings.timers`, '[]');
                await waitFor(`${id('panel')}.settings.timers`, v => v === '[]');

                // 3. open window: detected by the device, it stops heating
                fakes.panel.state.temps.Normal = 30;
                await set(`${id('panel')}.control.operationMode`, 'Control individually');
                await waitFor(`${id('panel')}.status.heating`, v => v === true);
                await set(`${id('panel')}.settings.openWindowDetection`, true);
                await waitFor(`${id('panel')}.settings.openWindowDetection`, v => v === true);
                fakes.panel.state.windowOpen = true;
                await refresh('panel');
                await waitFor(`${id('panel')}.status.openWindowActive`, v => v === true);
                await waitFor(`${id('panel')}.status.heating`, v => v === false);
                fakes.panel.state.windowOpen = false;
                await refresh('panel');
                await waitFor(`${id('panel')}.status.openWindowActive`, v => v === false);

                // 4. child lock
                await set(`${id('oil')}.settings.childLock`, true);
                await waitFor(`${id('oil')}.settings.childLock`, v => v === true);
                await refresh('oil');
                await waitFor(`${id('oil')}.status.lockActive`, v => v === 'Child lock');

                // 5. an operation mode the adapter does not know ("Invalid" in the API description):
                //    shown as reported, counts as off, ON returns to the last thermostat mode
                fakes.convection.state.mode = 'Invalid';
                await refresh('convection');
                await waitFor(`${id('convection')}.control.operationMode`, v => v === 'Invalid');
                await waitFor(`${id('convection')}.status.switchedOn`, v => v === false);
                await waitFor(`${id('convection')}.status.activeTargetTemperature`, v => v === null);
                await set(`${id('convection')}.control.power`, true);
                await waitFor(`${id('convection')}.control.operationMode`, v => v === 'Control individually');
                assert.strictEqual(fakes.convection.state.mode, 'Control individually');

                // 6. connection lost: only this device goes offline, the others keep working
                fakes.convection.state.offline = true;
                for (let i = 0; i < 3; i++) {
                    await set(`${id('convection')}.refresh`, true);
                    await sleep(700);
                }
                await waitFor(`${id('convection')}.info.online`, v => v === false);
                await waitFor('mill-local.0.info.connection', v => v === true);
                fakes.socket.state.ambient = 23.4;
                await refresh('socket');
                await waitFor(`${id('socket')}.sensor.temperature`, v => v === 23.4);
                // a command to the offline device is not acknowledged
                await set(`${id('convection')}.control.targetTemperature`, 19);
                await sleep(1500);
                const tt = await harness.states.getStateAsync(`${id('convection')}.control.targetTemperature`);
                assert.ok(!(tt.val === 19 && tt.ack), 'command to an offline device acknowledged');
                fakes.convection.state.offline = false;
                await refresh('convection');
                await waitFor(`${id('convection')}.info.online`, v => v === true);

                // 7. restart: the device is gone for a moment and comes back
                await set(`${id('socket')}.control.restart`, true);
                await waitFor(`${id('socket')}.control.restart`, v => v === false);
                assert.strictEqual(fakes.socket.state.reboots, 1);
                await sleep(2000);
                await refresh('socket');
                await waitFor(`${id('socket')}.info.online`, v => v === true);

                // 8. the trap: whatever happened, only the documented modes were ever sent
                const allowed = ['Control individually', 'Weekly program', 'Independent device', 'Off'];
                for (const kind of Object.keys(MACS)) {
                    for (const r of posts(kind, 'operation-mode')) {
                        assert.ok(allowed.includes(JSON.parse(r.body).mode), `${kind} got mode ${r.body}`);
                    }
                    assert.strictEqual(fakes[kind].state.maxConcurrent, 1, `${kind}: two requests at once`);
                }
                const alive = await harness.states.getStateAsync('system.adapter.mill-local.0.alive');
                assert.strictEqual(alive.val, true);
            });
        });
    },
});
