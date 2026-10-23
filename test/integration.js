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

                // ON: always on in manual mode (relay closed) - from a thermostat mode
                await harness.states.setStateAsync(`${dev}.control.power`, { val: true, ack: false });
                await waitFor(`${dev}.control.operationMode`, v => v === 'Switch');
                await waitFor(`${dev}.control.power`, v => v === true);
                assert.strictEqual(fake.state.forced, 99);
                // OFF in manual mode: relay open
                await harness.states.setStateAsync(`${dev}.control.power`, { val: false, ack: false });
                await waitFor(`${dev}.control.power`, v => v === false);
                assert.strictEqual(fake.state.forced, 0);
                await harness.states.setStateAsync(`${dev}.control.operationMode`, { val: 'Control individually', ack: false });
                await waitFor(`${dev}.control.operationMode`, v => v === 'Control individually');
                // OFF in a thermostat mode: operation mode Off
                await harness.states.setStateAsync(`${dev}.control.power`, { val: false, ack: false });
                await waitFor(`${dev}.control.operationMode`, v => v === 'Off');
                assert.strictEqual(fake.state.mode, 'OFF');
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
            });
        });
    },
});
