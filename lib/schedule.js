'use strict';

/**
 * Weekly program, one-off timers and vacation mode of Mill Generation 3 devices.
 *
 * All three are stored and executed inside the device; it needs the correct time for them
 * (it fetches it via NTP from pool.ntp.org after every start, there is no battery-backed clock)
 * and the time zone offset (`timezone-offset`, 1440 = not set).
 *
 * Device formats (local API):
 * - weekly program: {timers: [{name, timestamp}]}, timestamp = minutes since Monday 00:00 local time,
 *   name = temperature type; active only in the operation mode "Weekly program"
 * - one-off timers: {non_repeatable_timers: [{name, timestamp}]}, timestamp = local wall-clock time in
 *   minutes since 1970 ("local unix timestamp"), name = Normal / Off / AlwaysHeating; active only in
 *   "Independent device"
 * - vacation: {start_timestamp, end_timestamp} in the same local minutes, 0 / 0 = none
 *
 * The adapter shows them as readable JSON:
 * - weeklyProgram: [{"day":"Mon","time":"06:30","type":"Comfort"}, ...]
 * - timers:        [{"time":"2026-10-19T06:30","type":"Normal"}, ...]   (local time)
 * - vacation:      {"start":"2026-12-24T08:00","end":"2027-01-02T18:00"} or {} for none
 */

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKLY_TYPES = ['Comfort', 'Sleep', 'Away', 'Normal', 'Off', 'AlwaysHeating'];
const TIMER_TYPES = ['Normal', 'Off', 'AlwaysHeating'];
const MAX_ENTRIES = 64;
const MINUTES_PER_WEEK = 7 * 24 * 60;

/**
 * @param {unknown} raw JSON text or already parsed value
 * @returns {unknown} Parsed value
 */
function parse(raw) {
    if (typeof raw !== 'string') {
        return raw;
    }
    try {
        return JSON.parse(raw);
    } catch {
        throw new Error('value must be valid JSON');
    }
}

/**
 * @param {string} hhmm Time "HH:MM"
 * @returns {number} Minutes since midnight
 */
function minutesOfDay(hhmm) {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm || '').trim());
    if (!m) {
        throw new Error(`invalid time "${hhmm}", expected HH:MM`);
    }
    return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * @param {number} min Minutes since midnight
 * @returns {string} "HH:MM"
 */
const hhmm = min => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/**
 * Local wall-clock time "YYYY-MM-DDTHH:MM" -> local minutes since 1970 (the device format).
 *
 * @param {string} text Date and time
 * @returns {number} Minutes
 */
function wallToMinutes(text) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(String(text || '').trim());
    if (!m) {
        throw new Error(`invalid date "${text}", expected YYYY-MM-DDTHH:MM`);
    }
    const [y, mo, d, h, mi] = m.slice(1).map(Number);
    const ms = Date.UTC(y, mo - 1, d, h, mi);
    const check = new Date(ms);
    if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59) {
        throw new Error(`invalid date "${text}"`);
    }
    return ms / 60000;
}

/**
 * @param {number} min Local minutes since 1970
 * @returns {string} "YYYY-MM-DDTHH:MM"
 */
const minutesToWall = min => new Date(min * 60000).toISOString().slice(0, 16);

/**
 * @param {unknown} type Temperature type
 * @param {string[]} allowed Allowed types
 * @returns {string} Type in the device spelling
 */
function checkType(type, allowed) {
    const hit = allowed.find(t => t.toLowerCase() === String(type || '').toLowerCase());
    if (!hit) {
        throw new Error(`invalid type "${type}", allowed: ${allowed.join(', ')}`);
    }
    return hit;
}

/**
 * Weekly program: adapter JSON -> device body.
 *
 * @param {unknown} raw JSON
 * @returns {{timers: Array<{name: string, timestamp: number}>}} Body for POST /weekly-program
 */
function weeklyToDevice(raw) {
    const list = parse(raw);
    if (!Array.isArray(list)) {
        throw new Error('weekly program must be a JSON array');
    }
    if (list.length > MAX_ENTRIES) {
        throw new Error(`at most ${MAX_ENTRIES} entries`);
    }
    const seen = new Set();
    const timers = list.map(e => {
        if (!e || typeof e !== 'object') {
            throw new Error('every entry needs day, time and type');
        }
        const day = DAYS.findIndex(d => d.toLowerCase() === String(e.day || '').toLowerCase());
        if (day < 0) {
            throw new Error(`invalid day "${e.day}", allowed: ${DAYS.join(', ')}`);
        }
        const timestamp = day * 1440 + minutesOfDay(e.time);
        if (seen.has(timestamp)) {
            throw new Error(`two entries at ${e.day} ${e.time}`);
        }
        seen.add(timestamp);
        return { name: checkType(e.type, WEEKLY_TYPES), timestamp };
    });
    timers.sort((a, b) => a.timestamp - b.timestamp);
    return { timers };
}

/**
 * Weekly program: device answer -> adapter JSON.
 *
 * @param {Array<{name: string, timestamp: number}>} timers Device timers
 * @returns {string} JSON
 */
function weeklyFromDevice(timers) {
    const list = (Array.isArray(timers) ? timers : [])
        .filter(t => Number.isFinite(Number(t.timestamp)) && t.timestamp >= 0 && t.timestamp < MINUTES_PER_WEEK)
        .sort((a, b) => a.timestamp - b.timestamp)
        .map(t => ({ day: DAYS[Math.floor(t.timestamp / 1440)], time: hhmm(t.timestamp % 1440), type: t.name }));
    return JSON.stringify(list);
}

/**
 * One-off timers: adapter JSON -> device body.
 *
 * @param {unknown} raw JSON
 * @returns {{non_repeatable_timers: Array<{name: string, timestamp: number}>}} Body
 */
function timersToDevice(raw) {
    const list = parse(raw);
    if (!Array.isArray(list)) {
        throw new Error('timers must be a JSON array');
    }
    if (list.length > MAX_ENTRIES) {
        throw new Error(`at most ${MAX_ENTRIES} entries`);
    }
    const timers = list.map(e => {
        if (!e || typeof e !== 'object') {
            throw new Error('every entry needs time and type');
        }
        return { name: checkType(e.type, TIMER_TYPES), timestamp: wallToMinutes(e.time) };
    });
    timers.sort((a, b) => a.timestamp - b.timestamp);
    return { non_repeatable_timers: timers };
}

/**
 * @param {Array<{name: string, timestamp: number}>} timers Device timers
 * @returns {string} JSON
 */
function timersFromDevice(timers) {
    const list = (Array.isArray(timers) ? timers : [])
        .filter(t => Number.isFinite(Number(t.timestamp)))
        .sort((a, b) => a.timestamp - b.timestamp)
        .map(t => ({ time: minutesToWall(Number(t.timestamp)), type: t.name }));
    return JSON.stringify(list);
}

/**
 * Vacation: adapter JSON -> device body. {} or {"start":"","end":""} clears it.
 *
 * @param {unknown} raw JSON
 * @returns {{start_timestamp: number, end_timestamp: number}} Body
 */
function vacationToDevice(raw) {
    const v = parse(raw === '' ? '{}' : raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
        throw new Error('vacation must be a JSON object {"start": "...", "end": "..."}');
    }
    if (!v.start && !v.end) {
        return { start_timestamp: 0, end_timestamp: 0 };
    }
    if (!v.start || !v.end) {
        throw new Error('vacation needs both start and end (or neither)');
    }
    const start = wallToMinutes(v.start);
    const end = wallToMinutes(v.end);
    if (end <= start) {
        throw new Error('vacation end must be after its start');
    }
    if (end >= 2 ** 32) {
        throw new Error('date out of range');
    }
    return { start_timestamp: start, end_timestamp: end };
}

/**
 * @param {{start_timestamp?: number, end_timestamp?: number}} v Device answer
 * @returns {string} JSON
 */
function vacationFromDevice(v) {
    const s = Number(v && v.start_timestamp) || 0;
    const e = Number(v && v.end_timestamp) || 0;
    return JSON.stringify(s || e ? { start: minutesToWall(s), end: minutesToWall(e) } : {});
}

/**
 * Time zone offset of the ioBroker host in minutes (e.g. 120 in CEST).
 *
 * @param {Date} [now] Point in time
 * @returns {number} Offset east of UTC
 */
const localOffset = (now = new Date()) => -now.getTimezoneOffset();

module.exports = {
    DAYS,
    WEEKLY_TYPES,
    TIMER_TYPES,
    weeklyToDevice,
    weeklyFromDevice,
    timersToDevice,
    timersFromDevice,
    vacationToDevice,
    vacationFromDevice,
    wallToMinutes,
    minutesToWall,
    localOffset,
};
