'use strict';

const assert = require('node:assert');
const { EnergyCounter, dayKey } = require('../../lib/energy');

describe('EnergyCounter', () => {
    const t0 = new Date(2026, 9, 18, 12, 0, 0).getTime();

    it('integrates power between polls', () => {
        const e = new EnergyCounter({}, 120000);
        e.add(1000, t0);
        e.add(1000, t0 + 60000);
        e.add(0, t0 + 120000);
        // 1 kW for 2 minutes = 1/30 kWh
        assert.ok(Math.abs(e.totalKwh - 1 / 30) < 1e-9);
        assert.ok(Math.abs(e.todayKwh - 1 / 30) < 1e-9);
    });

    it('does not count gaps longer than maxGap', () => {
        const e = new EnergyCounter({}, 120000);
        e.add(2000, t0);
        e.add(2000, t0 + 10 * 60000);
        assert.strictEqual(e.totalKwh, 0);
    });

    it('does not count across an interruption', () => {
        const e = new EnergyCounter({}, 120000);
        e.add(2000, t0);
        e.interrupt();
        e.add(2000, t0 + 60000);
        assert.strictEqual(e.totalKwh, 0);
    });

    it('rolls over at midnight and keeps yesterday', () => {
        const e = new EnergyCounter({ totalKwh: 5, todayKwh: 1.5, day: dayKey(t0) }, 120000);
        const next = new Date(2026, 9, 19, 0, 0, 30).getTime();
        e.add(0, next);
        assert.strictEqual(e.yesterdayKwh, 1.5);
        assert.strictEqual(e.todayKwh, 0);
        assert.strictEqual(e.totalKwh, 5);
    });

    it('sets yesterday to 0 after a longer pause', () => {
        const e = new EnergyCounter({ todayKwh: 1.5, day: '2026-10-10' }, 120000);
        e.add(0, t0);
        assert.strictEqual(e.yesterdayKwh, 0);
    });
});
