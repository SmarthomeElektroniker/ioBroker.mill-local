'use strict';

const assert = require('node:assert');
const { checkTiming } = require('../../lib/config');

describe('configuration check', () => {
    it('accepts sensible values without a warning', () => {
        const r = checkTiming({ pollInterval: 30, slowInterval: 600, timeout: 5 });
        assert.deepStrictEqual(r, { pollMs: 30000, slowMs: 600000, timeoutMs: 5000, warnings: [] });
    });

    it('warns about invalid values and names the default used instead', () => {
        for (const bad of ['', 'abc', null, undefined, 0, -5, true]) {
            const r = checkTiming({ pollInterval: bad, slowInterval: 600, timeout: 5 });
            assert.strictEqual(r.pollMs, 30000, String(bad));
            assert.strictEqual(r.warnings.length, 1, String(bad));
            assert.match(r.warnings[0], /Polling interval .* not a valid number .* default of 30 s/);
        }
    });

    it('warns about values outside the limits instead of clamping silently', () => {
        const r = checkTiming({ pollInterval: 2, slowInterval: 999999, timeout: 120 });
        assert.strictEqual(r.pollMs, 10000);
        assert.strictEqual(r.slowMs, 86400000);
        assert.strictEqual(r.timeoutMs, 30000);
        assert.ok(r.warnings.some(w => /Polling interval 2 s is outside .* using 10 s/.test(w)));
        assert.ok(r.warnings.some(w => /Interval for settings 999999 s .* using 86400 s/.test(w)));
        assert.ok(r.warnings.some(w => /Request timeout 120 s .* using 30 s/.test(w)));
        // 30 s timeout is not shorter than 10 s polling
        assert.ok(r.warnings.some(w => /not shorter than the polling interval/.test(w)));
    });

    it('warns when the settings would be read more often than the values', () => {
        const r = checkTiming({ pollInterval: 600, slowInterval: 60, timeout: 5 });
        assert.ok(r.warnings.some(w => /shorter than the polling interval/.test(w)));
    });

    it('accepts numbers given as text', () => {
        assert.deepStrictEqual(checkTiming({ pollInterval: '20', slowInterval: '300', timeout: '3' }).warnings, []);
    });
});
