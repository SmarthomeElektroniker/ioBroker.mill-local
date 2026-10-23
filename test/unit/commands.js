'use strict';

const assert = require('node:assert');
const { COMMANDS, validate, execute, commonFor } = require('../../lib/commands');
const { MillClient } = require('../../lib/api');
const { STATES, definitionsFor } = require('../../lib/states');
const { createFakeMill } = require('../fakeMill');

describe('schedule', () => {
    const sch = require('../../lib/schedule');
    it('converts and validates the weekly program', () => {
        const back = sch.weeklyFromDevice(sch.weeklyToDevice('[{"day":"Sun","time":"23:59","type":"Away"}]').timers);
        assert.strictEqual(back, '[{"day":"Sun","time":"23:59","type":"Away"}]');
        assert.throws(() => sch.weeklyToDevice('[{"day":"Xyz","time":"06:00","type":"Comfort"}]'), /day/);
        assert.throws(() => sch.weeklyToDevice('[{"day":"Mon","time":"24:00","type":"Comfort"}]'), /time/);
        assert.throws(() => sch.weeklyToDevice('[{"day":"Mon","time":"06:00","type":"Hot"}]'), /type/);
        assert.throws(() => sch.weeklyToDevice('[{"day":"Mon","time":"06:00","type":"Comfort"},{"day":"mon","time":"6:00","type":"Away"}]'), /two entries/);
        assert.throws(() => sch.weeklyToDevice('kein json'), /JSON/);
    });
    it('timers accept only Normal/Off/AlwaysHeating and real dates', () => {
        assert.throws(() => sch.timersToDevice('[{"time":"2026-02-30T10:00","type":"Off"}]'), /invalid date/);
        assert.throws(() => sch.timersToDevice('[{"time":"2026-10-19T10:00","type":"Comfort"}]'), /type/);
        assert.strictEqual(sch.minutesToWall(27020801), '2021-05-17T10:41');
    });
    it('vacation needs start and end in order', () => {
        assert.throws(() => sch.vacationToDevice('{"start":"2026-12-24T08:00"}'), /both/);
        assert.throws(() => sch.vacationToDevice('{"start":"2027-01-02T08:00","end":"2026-12-24T08:00"}'), /after/);
        assert.strictEqual(sch.vacationFromDevice({ start_timestamp: 0, end_timestamp: 0 }), '{}');
    });
});

describe('commands', () => {
    it('validates numbers: range, step, comma, garbage', () => {
        assert.strictEqual(validate('control.targetTemperature', 17.3), 17.5);
        assert.strictEqual(validate('control.targetTemperature', '18,5'), 18.5);
        assert.strictEqual(validate('settings.calibrationOffset', -2.04), -2);
        assert.throws(() => validate('control.targetTemperature', 40));
        assert.throws(() => validate('control.targetTemperature', 'warm'));
        assert.throws(() => validate('control.targetTemperature', true));
        assert.throws(() => validate('settings.oilHeaterPower', 50));
        assert.strictEqual(validate('settings.oilHeaterPower', 60), 60);
    });

    it('accepts only documented operation modes (unknown ones switch the device off)', () => {
        assert.strictEqual(validate('control.operationMode', 'OFF'), 'Off');
        assert.strictEqual(validate('control.operationMode', 'weekly program'), 'Weekly program');
        assert.throws(() => validate('control.operationMode', 'Nonsense'));
        assert.throws(() => validate('settings.displayUnit', 'Kelvin'));
    });

    it('validates booleans and texts', () => {
        assert.strictEqual(validate('settings.childLock', 'true'), true);
        assert.throws(() => validate('settings.childLock', 'yes'));
        assert.throws(() => validate('info.customName', 'x'.repeat(33)));
        assert.throws(() => validate('info.customName', '  '));
        assert.throws(() => validate('status.power', 1), /not writable/);
        assert.strictEqual(validate('control.operationMode', 'switch'), 'Switch');
    });

    it('every command has an object definition and vice versa no duplicates', () => {
        const ids = STATES.map(s => s.id);
        assert.strictEqual(new Set(ids).size, ids.length, 'duplicate IDs');
        for (const id of Object.keys(COMMANDS)) {
            assert.ok(ids.includes(id), `${id} has no object`);
        }
        // nothing under status may be writable or duplicate a control/settings value
        for (const s of definitionsFor({ hysteresis: true, oilPower: true, limitedPower: true, socketMode: true, humidity: true }, true)) {
            if (s.id.startsWith('status.')) {
                assert.strictEqual(s.common.write, false, s.id);
            }
        }
        assert.deepStrictEqual(commonFor('control.targetTemperature', true), { write: true, min: 5, max: 35, step: 0.5 });
        assert.strictEqual(commonFor('control.targetTemperature', false).write, false);
    });

    describe('against the simulated device', () => {
        let fake;
        let client;
        beforeEach(async () => {
            fake = await createFakeMill();
            client = new MillClient({ host: fake.host });
        });
        afterEach(() => fake.close());

        it('hysteresis keeps the other value', async () => {
            await execute(client, 'settings.hysteresisUpper', 1.2, {});
            assert.deepStrictEqual(fake.state.hysteresis, { temp_hysteresis_upper: 1.2, temp_hysteresis_lower: 0.5 });
        });

        it('open window parameters are sent as a complete set', async () => {
            await execute(client, 'settings.openWindowMaxTime', 1800, {});
            const body = JSON.parse(fake.state.requests.filter(r => r.method === 'POST').pop().body);
            assert.deepStrictEqual(Object.keys(body).sort(), [
                'drop_temperature_threshold',
                'drop_time_range',
                'enabled',
                'increase_temperature_threshold',
                'increase_time_range',
                'max_time',
            ]);
            assert.strictEqual(fake.state.openWindow.max_time, 1800);
        });

        it('ON always switches the relay on in manual mode, OFF switches off safely', async () => {
            for (const mode of ['Control individually', 'Weekly program', 'Independent device', 'Off', 'Switch']) {
                await execute(client, 'control.power', true, { mode });
                assert.strictEqual(fake.state.mode, 'Independent device', mode);
                assert.strictEqual(fake.state.forced, 99, mode);
            }
            await execute(client, 'control.power', false, { mode: 'Switch' });
            assert.strictEqual(fake.state.forced, 0);
            await execute(client, 'control.operationMode', 'Control individually', {});
            await execute(client, 'control.power', false, { mode: 'Control individually' });
            assert.strictEqual(fake.state.mode, 'OFF');
            await execute(client, 'control.targetTemperature', 19, { mode: 'Independent device' });
            assert.ok(fake.state.requests.some(r => r.path === 'set-temperature-in-independent-mode-now'));
        });

        it('weekly program, timers and vacation reach the device in its format', async () => {
            await execute(client, 'settings.weeklyProgram', '[{"day":"Tue","time":"06:30","type":"comfort"},{"day":"Mon","time":"22:00","type":"Sleep"}]', {});
            assert.deepStrictEqual(fake.state.weekly, [
                { name: 'Sleep', timestamp: 1320 },
                { name: 'Comfort', timestamp: 1440 + 390 },
            ]);
            await execute(client, 'settings.timers', '[{"time":"2021-05-17T10:41","type":"Off"}]', {});
            // example of the official documentation: 17.05.2021 -> 27020801
            assert.deepStrictEqual(fake.state.oneOff, [{ name: 'Off', timestamp: 27020801 }]);
            await execute(client, 'settings.vacation', '{"start":"2026-12-24T08:00","end":"2027-01-02T18:00"}', {});
            assert.ok(fake.state.vacation.end_timestamp > fake.state.vacation.start_timestamp);
            await execute(client, 'settings.vacation', '{}', {});
            assert.deepStrictEqual(fake.state.vacation, { start_timestamp: 0, end_timestamp: 0 });
        });

        it('Switch mode forces the relay without temperature control', async () => {
            await execute(client, 'control.operationMode', 'Switch', { mode: 'Control individually' });
            assert.strictEqual(fake.state.mode, 'Independent device');
            assert.strictEqual(fake.state.forced, 0);
            await execute(client, 'control.power', true, { mode: 'Switch' });
            assert.strictEqual(fake.state.forced, 99);
            await execute(client, 'control.power', false, { mode: 'Switch' });
            assert.strictEqual(fake.state.forced, 0);
            assert.strictEqual(fake.state.mode, 'Independent device', 'stays in Switch');
        });

        it('restart: the missing answer counts as success', async () => {
            await execute(client, 'control.restart', true, {});
            assert.strictEqual(fake.state.reboots, 1);
        });

        it('leaving Switch for Independent device sets the Normal temperature again', async () => {
            await execute(client, 'control.power', true, { mode: 'Control individually' });
            assert.strictEqual(fake.state.forced, 99);
            await execute(client, 'control.operationMode', 'Independent device', { mode: 'Switch', normal: 17 });
            const last = fake.state.requests.filter(r => r.method === 'POST').pop();
            assert.strictEqual(last.path, 'set-temperature-in-independent-mode-now');
            assert.strictEqual(JSON.parse(last.body).temperature, 17);
            assert.strictEqual(fake.state.forced, null);
        });

        it('PID controller is refused for a socket', async () => {
            await assert.rejects(execute(client, 'settings.regulatorType', 'pid', { kind: 'socket' }), /panel/);
            assert.strictEqual(fake.state.requests.filter(r => r.method === 'POST').length, 0);
        });

        it('commercial lock limits keep the other value, time zone 1440 is accepted', async () => {
            await execute(client, 'settings.commercialLockMin', 18, {});
            assert.deepStrictEqual(fake.state.commercialLimits, { enabled: false, min_allowed_temp_in_commercial_lock: 18, max_allowed_temp_in_commercial_lock: 26 });
            await execute(client, 'settings.timezoneOffset', 1440, {});
            assert.strictEqual(fake.state.timezone, 1440);
        });

        it('sends nothing for an invalid value', async () => {
            await assert.rejects(execute(client, 'control.operationMode', 'Nonsense', {}));
            assert.strictEqual(fake.state.requests.length, 0);
            assert.strictEqual(fake.state.mode, 'Control individually');
        });
    });
});
