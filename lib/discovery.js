'use strict';

/**
 * Finds Mill Generation 3 devices by asking every address of the given IPv4 networks for
 * `GET /status`.
 *
 * Mill devices do not announce themselves via mDNS or SSDP (checked on a Wi-Fi Socket Gen 3),
 * so an HTTP scan is the only way. It also works from a Docker bridge network, where
 * multicast would not get through. The scan is gentle: few parallel requests, short timeout,
 * and only ever started by the user or after a known device stopped answering.
 */

const { MillClient } = require('./api');
const { isMillStatus, macId } = require('./model');

/**
 * Expands "192.168.1.0/24", "192.168.1.10-192.168.1.50" or single addresses into a list.
 * Prefixes shorter than /22 are refused (more than 1022 hosts).
 *
 * @param {string} spec Comma/space separated network specification
 * @returns {string[]} IPv4 addresses
 */
function expandTargets(spec) {
    const out = new Set();
    const toInt = ip => {
        const p = ip.split('.').map(Number);
        if (p.length !== 4 || p.some(x => !Number.isInteger(x) || x < 0 || x > 255)) {
            throw new Error(`Invalid IPv4 address "${ip}"`);
        }
        return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
    };
    const toIp = n => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
    for (const part of String(spec || '')
        .split(/[\s,;]+/)
        .filter(Boolean)) {
        if (part.includes('/')) {
            const [base, bitsS] = part.split('/');
            const bits = Number(bitsS);
            if (!Number.isInteger(bits) || bits < 22 || bits > 32) {
                throw new Error(`Network "${part}": prefix must be between /22 and /32`);
            }
            const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
            const net = (toInt(base) & mask) >>> 0;
            const size = 2 ** (32 - bits);
            if (size <= 2) {
                for (let i = 0; i < size; i++) {
                    out.add(toIp(net + i));
                }
            } else {
                // without network and broadcast address
                for (let i = 1; i < size - 1; i++) {
                    out.add(toIp(net + i));
                }
            }
        } else if (part.includes('-')) {
            const [a, b] = part.split('-').map(toInt);
            if (b < a || b - a > 1024) {
                throw new Error(`Range "${part}" is invalid or larger than 1024 addresses`);
            }
            for (let n = a; n <= b; n++) {
                out.add(toIp(n));
            }
        } else {
            toInt(part);
            out.add(part);
        }
    }
    return [...out];
}

/**
 * Scans the addresses and returns all Mill devices found.
 *
 * @param {string[]} addresses IPv4 addresses
 * @param {object} [opts] Options
 * @param {number} [opts.timeoutMs] Per-host timeout
 * @param {number} [opts.parallel] Number of parallel probes
 * @param {{setTimeout: (cb: () => void, ms: number) => unknown, clearTimeout: (t: unknown) => void}} [opts.timer] Adapter timers
 * @param {() => boolean} [opts.isCancelled] Returns true to stop early (adapter unloading)
 * @param {(ip: string, mac: string) => boolean} [opts.stopWhen] Stops as soon as it returns true
 * @returns {Promise<Array<{ip: string, mac: string, name: string, customName: string, version: string}>>} Devices
 */
async function scan(addresses, opts = {}) {
    const timeoutMs = opts.timeoutMs || 1500;
    const parallel = Math.max(1, Math.min(opts.parallel || 12, 32));
    const found = [];
    let idx = 0;
    let stop = false;
    const worker = async () => {
        while (!stop && idx < addresses.length) {
            if (opts.isCancelled && opts.isCancelled()) {
                stop = true;
                return;
            }
            const ip = addresses[idx++];
            try {
                const st = await new MillClient({ host: ip, timeoutMs, timer: opts.timer }).get('status');
                if (isMillStatus(st)) {
                    const mac = macId(st.mac_address);
                    found.push({
                        ip,
                        mac,
                        name: st.name,
                        customName: st.custom_name || '',
                        version: st.version,
                    });
                    if (opts.stopWhen && opts.stopWhen(ip, mac)) {
                        stop = true;
                    }
                }
            } catch {
                // nothing there or not a Mill device
            }
        }
    };
    await Promise.all(Array.from({ length: parallel }, worker));
    found.sort((a, b) => a.ip.localeCompare(b.ip, 'en', { numeric: true }));
    return found;
}

module.exports = { expandTargets, scan };
