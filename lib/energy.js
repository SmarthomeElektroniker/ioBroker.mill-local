'use strict';

/**
 * Energy estimate from the power readings.
 *
 * Mill Generation 3 devices report the momentary heating power (`current_power`, W) but no
 * energy meter. The adapter integrates the power over time (left Riemann sum: the power read
 * at one poll is assumed until the next). Gaps longer than `maxGapMs` (device offline,
 * adapter stopped) are not counted, so the value never invents consumption.
 */

/**
 * Local calendar day as YYYY-MM-DD.
 *
 * @param {number} ts Timestamp in ms
 * @returns {string} Day key
 */
function dayKey(ts) {
    const d = new Date(ts);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Integrates power readings into energy counters. */
class EnergyCounter {
    /**
     * @param {object} [init] Persisted values
     * @param {number} [init.totalKwh] Total energy in kWh
     * @param {number} [init.todayKwh] Energy of the current day in kWh
     * @param {number} [init.yesterdayKwh] Energy of the previous day in kWh
     * @param {string} [init.day] Day the `todayKwh` belongs to
     * @param {number} [maxGapMs] Longest interval that is still integrated
     */
    constructor(init = {}, maxGapMs = 5 * 60 * 1000) {
        this.totalKwh = Number(init.totalKwh) || 0;
        this.todayKwh = Number(init.todayKwh) || 0;
        this.yesterdayKwh = Number(init.yesterdayKwh) || 0;
        this.day = init.day || '';
        this.maxGapMs = maxGapMs;
        this._lastTs = 0;
        this._lastW = 0;
    }

    /**
     * Adds a power reading.
     *
     * @param {number} watts Power in W
     * @param {number} ts Timestamp in ms
     * @returns {boolean} True if the counters changed
     */
    add(watts, ts) {
        let changed = this._rollDay(ts);
        const w = Number(watts);
        if (this._lastTs && ts > this._lastTs && ts - this._lastTs <= this.maxGapMs && this._lastW > 0) {
            const kwh = (this._lastW * (ts - this._lastTs)) / 3600000 / 1000;
            this.totalKwh += kwh;
            this.todayKwh += kwh;
            changed = true;
        }
        this._lastTs = ts;
        this._lastW = Number.isFinite(w) && w > 0 ? w : 0;
        return changed;
    }

    /** Forgets the last reading (device went offline). */
    interrupt() {
        this._lastTs = 0;
        this._lastW = 0;
    }

    /**
     * @param {number} ts Timestamp in ms
     * @returns {boolean} True if the day changed
     */
    _rollDay(ts) {
        const today = dayKey(ts);
        if (this.day === today) {
            return false;
        }
        if (this.day) {
            // Day after the stored day: move today to yesterday; longer pause: yesterday unknown = 0
            const prev = dayKey(ts - 24 * 3600 * 1000);
            this.yesterdayKwh = this.day === prev ? this.todayKwh : 0;
        }
        this.todayKwh = 0;
        this.day = today;
        return true;
    }
}

module.exports = { EnergyCounter, dayKey };
