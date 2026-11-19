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
                assert.ok(!(await harness.objects.getObjectAsync(`${dev}.settings.oilHeaterPower`)), 'socket has no oil power');
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
                await harness.states.setStateAsync(`${dev}.control.operationMode`, { val: 'Control individually', ack: false });
                await waitFor(`${dev}.control.operationMode`, v => v === 'Control individually');

                // operation mode written directly and kept (no stale reading may turn it back)
                await harness.states.setStateAsync(`${dev}.control.operationMode`, { val: 'Weekly program', ack: false });
                await waitFor(`${dev}.control.operationMode`, v => v === 'Weekly program');
                await new Promise(r => setTimeout(r, 2500));
                assert.strictEqual((await harness.states.getStateAsync(`${dev}.control.operationMode`)).val, 'Weekly program');
                assert.strictEqual(fake.state.mode, 'Weekly program');

                // settings are written to the device
                await harness.states.setStateAsync(`${dev}.settings.calibrationOffset`, { val: -2, ack: false });
                await waitFor(`${dev}.settings.calibrationOffset`, v => v === -2);
                assert.strictEqual(fake.state.calibration, -2);

                // weekly program in readable JSON
                await harness.states.setStateAsync(`${dev}.settings.weeklyProgram`, { val: '[{"day":"Mon","time":"06:30","type":"Comfort"}]', ack: false });
                await waitFor(`${dev}.settings.weeklyProgram`, v => v === '[{"day":"Mon","time":"06:30","type":"Comfort"}]');
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
                assert.deepStrictEqual(card.actions.map(a => a.id), ['powerToggle']);
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
                await harness.states.setStateAsync(`${dev}.control.operationMode`, { val: 'Control individually', ack: false });
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
                        devices: [{ enabled: true, name: 'Sim2', ip: fake.host, mac: '94:E6:86:00:00:02', useApiKey: false }],
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
                    assert.strictEqual((await harness.states.getStateAsync('system.adapter.mill-local.0.alive')).val, true);

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
    },
});
