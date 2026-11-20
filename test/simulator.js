'use strict';

/*
 * Several simulated Mill devices at once, for a demo instance (not part of the npm package).
 *
 *   node test/simulator.js [--base 18000] [--bind 127.0.0.1] [--pid file]
 *
 * Starts four devices on <base>+1 ... <base>+4 (socket, panel, oil, convection) with the physics of
 * test/fakeMill.js (the room warms up while the device heats) and a small control port on <base>:
 *
 *   GET  http://127.0.0.1:<base>/                  overview of all devices (JSON)
 *   POST http://127.0.0.1:<base>/<n>  {"windowOpen": true}     change the simulation of device n (1-4), e.g.
 *        windowOpen, offline, responseMode ("valid", "hang", "invalid-json", "http-error" ...), ambient,
 *        operationKey (fault text), clockShiftMs, timeValid, outside
 *
 * Stop: kill $(cat <pid file>)   (or Ctrl+C). Nothing is stored; a restart begins with the defaults.
 */
const http = require('node:http');
const fs = require('node:fs');
const { createFakeMill } = require('./fakeMill');

const arg = (name, def) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const BASE = Number(arg('base', 18000));
const BIND = arg('bind', '127.0.0.1');
const PID = arg('pid', '');

/** Weekly program in device minutes since Monday 00:00 */
const day = (d, h, m, name) => ({ name, timestamp: d * 1440 + h * 60 + m });
const WORKDAYS = [0, 1, 2, 3, 4].flatMap(d => [
    day(d, 6, 0, 'Comfort'),
    day(d, 8, 0, 'Away'),
    day(d, 16, 30, 'Comfort'),
    day(d, 22, 0, 'Sleep'),
]);
const WEEKEND = [5, 6].flatMap(d => [day(d, 7, 30, 'Comfort'), day(d, 23, 0, 'Sleep')]);

const DEVICES = [
    {
        kind: 'socket',
        mac: '94:E6:86:5E:00:01',
        customName: 'Sim Werkstatt',
        setup: s => {
            s.ambient = 17.4;
            s.temps.Normal = 18;
        },
    },
    {
        kind: 'panel',
        mac: '94:E6:86:5E:00:02',
        customName: 'Sim Wohnzimmer',
        setup: s => {
            s.mode = 'Weekly program';
            s.weekly = [...WORKDAYS, ...WEEKEND];
            s.ambient = 20.6;
            s.temps = { Normal: 21, Comfort: 22, Sleep: 18, Away: 17 };
            s.openWindow.enabled = true;
        },
    },
    {
        kind: 'oil',
        mac: '94:E6:86:5E:00:03',
        customName: 'Sim Bad',
        setup: s => {
            s.ambient = 21.8;
            s.temps.Normal = 23;
            s.oilPower = 60;
            s.childLock = true;
        },
    },
    {
        kind: 'convection',
        mac: '94:E6:86:5E:00:04',
        customName: 'Sim Keller',
        setup: s => {
            s.mode = 'OFF';
            s.ambient = 12.1;
        },
    },
];

async function main() {
    const tz = -new Date().getTimezoneOffset() || 0;
    const fakes = [];
    for (const [i, d] of DEVICES.entries()) {
        const f = await createFakeMill({ ...d, port: BASE + 1 + i, bind: BIND, physics: true });
        d.setup(f.state);
        f.state.timezone = tz;
        fakes.push(f);
    }
    const overview = () =>
        fakes.map((f, i) => ({
            n: i + 1,
            host: f.host,
            kind: f.state.kind,
            name: f.state.customName,
            mode: f.state.mode,
            regulation: f.regulation(),
            ambient: Math.round(f.state.ambient * 100) / 100,
            windowOpen: f.state.windowOpen,
            offline: f.state.offline,
            responseMode: f.state.responseMode,
            requests: f.state.requests.length,
            maxConcurrent: f.state.maxConcurrent,
        }));
    const ALLOWED = [
        'windowOpen',
        'offline',
        'responseMode',
        'ambient',
        'operationKey',
        'clockShiftMs',
        'timeValid',
        'outside',
    ];
    const control = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => (body += c));
        req.on('end', () => {
            const reply = (code, obj) => {
                res.writeHead(code, { 'Content-Type': 'application/json' });
                res.end(`${JSON.stringify(obj, null, 2)}\n`);
            };
            if (req.method === 'GET') {
                return reply(200, overview());
            }
            const f = fakes[Number(req.url.replace(/^\//, '')) - 1];
            if (!f) {
                return reply(404, { error: 'unknown device, use /1 ... /4' });
            }
            let change;
            try {
                change = JSON.parse(body || '{}');
            } catch {
                return reply(400, { error: 'body must be JSON' });
            }
            for (const [k, v] of Object.entries(change)) {
                if (!ALLOWED.includes(k)) {
                    return reply(400, { error: `${k} cannot be changed, allowed: ${ALLOWED.join(', ')}` });
                }
                f.state[k] = v;
            }
            return reply(200, overview());
        });
    });
    await new Promise(r => control.listen(BASE, BIND, r));
    if (PID) {
        fs.writeFileSync(PID, String(process.pid));
    }
    const stop = async () => {
        control.close();
        await Promise.all(fakes.map(f => f.close()));
        if (PID) {
            try {
                fs.unlinkSync(PID);
            } catch {
                // already gone
            }
        }
        process.exit(0);
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    console.log(`${new Date().toISOString()} Mill simulator: control ${BIND}:${BASE}, devices:`);
    for (const f of fakes) {
        console.log(`  ${f.host}  ${f.state.kind.padEnd(10)} ${f.state.customName}  MAC ${f.state.mac}`);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
