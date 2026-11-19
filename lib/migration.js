'use strict';

/**
 * Takeover from ioBroker.millheater (webbummler, MIT): one millheater instance controls one device at
 * `native.host`; its MAC is in the state `millheater.<n>.status.mac_address`. The instances become rows of
 * the device table, the intervals are taken over within the limits of this adapter.
 */

const model = require('./model');
const { LIMITS } = require('./config');

/**
 * @param {unknown} v Seconds
 * @param {[number, number, number]} limits [default, min, max]
 * @returns {number|undefined} Value within the limits, undefined if not a number
 */
function clampSeconds(v, limits) {
    const n = Number(v);
    if (v === null || v === undefined || v === '' || !Number.isFinite(n) || n <= 0) {
        return undefined;
    }
    return Math.min(Math.max(Math.round(n), limits[1]), limits[2]);
}

/**
 * Builds the new instance configuration from millheater instances.
 *
 * @param {Array<{id: string, native?: Record<string, unknown>, enabled?: boolean, mac?: string, name?: string}>} instances
 *   millheater instances with the MAC and name read from their states
 * @param {{devices?: Array<Record<string, unknown>>}} current Current (unsaved) configuration of the admin page
 * @returns {{native: Record<string, unknown>, added: number, updated: number, skipped: string[], lines: string[]}} Result
 */
function fromMillheater(instances, current) {
    const rows = Array.isArray(current && current.devices) ? current.devices.map(r => ({ ...r })) : [];
    const native = {};
    const lines = [];
    const skipped = [];
    let added = 0;
    let updated = 0;
    const sorted = [...instances].sort((a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true }));
    for (const inst of sorted) {
        const n = inst.native || {};
        const ip = String(n.host || '')
            .replace(/^https?:\/\//, '')
            .replace(/\/+$/, '')
            .trim();
        const short = String(inst.id).replace(/^system\.adapter\./, '');
        if (!ip) {
            skipped.push(`${short}: no host configured`);
            continue;
        }
        const mac = model.macId(inst.mac);
        const name = String(inst.name || '').trim() || short;
        const row =
            (mac && rows.find(r => model.macId(r.mac) === mac)) || rows.find(r => String(r.ip || '').trim() === ip);
        if (row) {
            row.ip = ip;
            row.mac = mac || row.mac || '';
            row.name = row.name || name;
            updated++;
        } else {
            rows.push({ enabled: true, name, ip, mac, useApiKey: false });
            added++;
        }
        lines.push(`${short} -> ${name} (${ip}${mac ? `, MAC ${mac}` : ', MAC unknown'})`);
    }
    native.devices = rows;
    // intervals of the first instance with a host: fast polling, slow polling and timeout
    const first = sorted.find(i => i.native && String(i.native.host || '').trim());
    if (first) {
        const poll = clampSeconds(first.native.pollInterval1, LIMITS.pollInterval);
        const slow = clampSeconds(first.native.pollInterval2, LIMITS.slowInterval);
        const timeout = clampSeconds(first.native.apiTimeout, LIMITS.timeout);
        if (poll !== undefined) {
            native.pollInterval = poll;
        }
        if (slow !== undefined) {
            native.slowInterval = Math.max(slow, native.pollInterval || 0);
        }
        if (timeout !== undefined) {
            native.timeout = timeout;
        }
    }
    return { native, added, updated, skipped, lines };
}

/**
 * Text for the admin dialog.
 *
 * @param {ReturnType<typeof fromMillheater>} r Result of fromMillheater
 * @param {number} count Number of millheater instances found
 * @returns {string} Summary
 */
function summary(r, count) {
    if (!count) {
        return 'No ioBroker.millheater instance found - nothing to take over.';
    }
    const parts = [
        `Taken over from ${count} millheater instance(s): ${r.added} new, ${r.updated} updated device(s).`,
        ...r.lines,
    ];
    if (r.skipped.length) {
        parts.push(`Skipped: ${r.skipped.join('; ')}`);
    }
    parts.push(
        'Save to apply. Then stop the millheater instance(s): a Mill device answers one request at a time, two adapters polling it cause timeouts.',
    );
    return parts.join('\n');
}

/**
 * Reads the millheater instances and their MAC/name states through the adapter.
 *
 * @param {{getObjectViewAsync: (design: string, search: string, params: object) => Promise<{rows?: Array<{id: string, value: ioBroker.Object}>}>, getForeignStateAsync: (id: string) => Promise<ioBroker.State | null | undefined>}} adapter Adapter
 * @returns {Promise<Array<{id: string, native: Record<string, unknown>, enabled: boolean, mac: string, name: string}>>} Instances
 */
async function readMillheaterInstances(adapter) {
    const view = await adapter.getObjectViewAsync('system', 'instance', {
        startkey: 'system.adapter.millheater.',
        endkey: 'system.adapter.millheater.香',
    });
    const out = [];
    for (const row of (view && view.rows) || []) {
        const obj = row.value;
        if (!obj || !/^system\.adapter\.millheater\.\d+$/.test(row.id)) {
            continue;
        }
        const ns = row.id.replace(/^system\.adapter\./, '');
        const val = async id => {
            const st = await adapter.getForeignStateAsync(`${ns}.${id}`);
            return st && st.val !== null && st.val !== undefined ? String(st.val) : '';
        };
        out.push({
            id: row.id,
            native: obj.native || {},
            enabled: !!(obj.common && obj.common.enabled),
            mac: await val('status.mac_address'),
            name: (await val('status.custom_name')) || (await val('status.name')),
        });
    }
    return out;
}

module.exports = { fromMillheater, summary, readMillheaterInstances };
