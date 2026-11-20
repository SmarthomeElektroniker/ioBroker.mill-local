'use strict';

/*
 * Browser test of the week grid (admin/weekly.html) in headless Chromium/Chrome, without ioBroker:
 * a small HTTP server serves the page and a stub of the admin socket that answers weeklyInfo and records
 * weeklyDraft. Skipped when no browser is installed (CHROME=/path/to/browser to choose one).
 *
 *   npm run test:ui
 */
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BROWSERS = [process.env.CHROME, '/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium-browser'];
const browser = BROWSERS.find(b => b && fs.existsSync(b));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const INFO = {
    program: DAYS.flatMap(day => [
        { day, time: '06:00', type: 'Comfort' },
        { day, time: '08:00', type: 'Away' },
        { day, time: '17:00', type: 'Comfort' },
        { day, time: '22:00', type: 'Sleep' },
    ]),
    temps: { Comfort: 22, Sleep: 18, Away: 17, Normal: 21 },
    lang: 'de',
    max: 64,
    types: ['Comfort', 'Sleep', 'Away', 'Normal', 'Off', 'AlwaysHeating'].map(type => ({ type, label: type })),
    texts: {
        'Copy day': 'Copy',
        'Paste day': 'Paste',
        'Add switching time': '+ Switching time',
        'New switching time at {time}': 'New switching time at {time}',
        Delete: 'Delete',
        'Delete question': 'Delete {time}?',
        Cancel: 'Cancel',
        'Switching times': 'switching times',
        'Grid hint': 'hint',
        'Choose type for {time}': 'Choose the type for {time}',
    },
};

// stub of the admin socket: io.connect() -> {on, emit('sendTo', instance, command, message, cb)}
const SOCKET_STUB = `window.drafts = [];
window.io = { connect: () => ({
    on: (ev, cb) => { if (ev === 'connect') setTimeout(cb, 10); },
    emit: (ev, inst, cmd, msg, cb) => {
        if (cmd === 'weeklyInfo') cb(${JSON.stringify(INFO)});
        else { window.drafts.push(msg); cb({ ok: true, count: msg.program.length }); }
    },
}) };`;

/**
 * Minimal Chrome DevTools Protocol client.
 *
 * @param {number} port Debugging port
 */
async function cdp(port) {
    let ws;
    for (let i = 0; i < 100 && !ws; i++) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
            const page = list.find(t => t.type === 'page');
            if (page) {
                ws = new WebSocket(page.webSocketDebuggerUrl);
            }
        } catch {
            await sleep(100);
        }
    }
    await new Promise(r => ws.addEventListener('open', r, { once: true }));
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', ev => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) {
            pending.get(m.id)(m);
            pending.delete(m.id);
        }
    });
    const send = (method, params = {}) =>
        new Promise((resolve, reject) => {
            const i = ++id;
            pending.set(i, m => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
            ws.send(JSON.stringify({ id: i, method, params }));
        });
    const evaluate = async expr => {
        const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) {
            throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        }
        return r.result.value;
    };
    const mouse = async (type, x, y) =>
        send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
    const click = async (x, y) => {
        await mouse('mouseMoved', x, y);
        await mouse('mousePressed', x, y);
        await mouse('mouseReleased', x, y);
        await sleep(150);
    };
    const key = async k => {
        await send('Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: k,
            code: k,
            windowsVirtualKeyCode: k === 'Escape' ? 27 : 0,
        });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k });
        await sleep(100);
    };
    return { send, evaluate, click, key, close: () => ws.close() };
}

describe('week grid (admin/weekly.html) in a browser', function () {
    this.timeout(60000);
    let server;
    let proc;
    let page;
    const profile = path.join(__dirname, '.profile');

    before(async function () {
        if (!browser) {
            this.skip();
        }
        const html = fs.readFileSync(path.join(__dirname, '..', '..', 'admin', 'weekly.html'));
        server = http.createServer((req, res) => {
            if (req.url.startsWith('/lib/js/socket.io.js')) {
                res.writeHead(200, { 'Content-Type': 'text/javascript' });
                return res.end(SOCKET_STUB);
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(html);
        });
        await new Promise(r => server.listen(0, '127.0.0.1', r));
        const port = 9400 + Math.floor(Math.random() * 400);
        proc = spawn(
            browser,
            [
                '--headless=new',
                `--remote-debugging-port=${port}`,
                `--user-data-dir=${profile}`,
                '--no-first-run',
                '--disable-gpu',
                '--window-size=1400,700',
                `http://127.0.0.1:${server.address().port}/adapter/mill-local/weekly.html?instance=mill-local.0&device=x&token=t`,
            ],
            { stdio: 'ignore', detached: true },
        );
        page = await cdp(port);
        await page.send('Runtime.enable');
        const end = Date.now() + 15000;
        while (!(await page.evaluate("document.querySelectorAll('.block').length > 7"))) {
            if (Date.now() > end) {
                throw new Error('grid did not render');
            }
            await sleep(100);
        }
    });

    after(async () => {
        if (page) {
            page.close();
        }
        if (proc) {
            const exited = new Promise(r => proc.once('exit', r));
            try {
                process.kill(-proc.pid, 'SIGTERM');
            } catch {
                proc.kill();
            }
            await Promise.race([exited, sleep(5000)]);
        }
        if (server) {
            server.close();
        }
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    });

    const menus = () =>
        page.evaluate(
            "[...document.querySelectorAll('.menu')].map(m => ({ chooser: m.classList.contains('chooser'), title: (m.querySelector('.title') || {}).textContent || '', items: [...m.querySelectorAll('button')].map(b => b.textContent.trim()), danger: !!m.querySelector('.danger'), svg: !!m.querySelector('svg') }))",
        );
    const pointsOf = day =>
        page.evaluate(
            `[...document.querySelectorAll('.track[data-day="${day}"] .handle')].map(h => h.getAttribute('aria-valuetext'))`,
        );
    const at = (day, hour) =>
        page.evaluate(
            `(() => { const r = document.querySelector('.track[data-day="${day}"]').getBoundingClientRect(); return { x: r.left + r.width * ${hour} / 24, y: r.top + r.height / 2 }; })()`,
        );
    const lineAt = (day, time) =>
        page.evaluate(
            `(() => { const h = [...document.querySelectorAll('.track[data-day="${day}"] .handle')].find(h => h.getAttribute('aria-valuetext') === '${time}'); const r = h.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
        );
    const lastDraft = () =>
        page.evaluate('JSON.stringify(window.drafts[window.drafts.length - 1] || null)').then(JSON.parse);

    it('a click into a block adds a switching time and opens only the small type choice', async () => {
        const p = await at(1, 12);
        await page.click(p.x, p.y);
        assert.deepStrictEqual(await pointsOf(1), ['06:00', '08:00', '12:00', '17:00', '22:00']);
        const m = await menus();
        assert.strictEqual(m.length, 1, JSON.stringify(m));
        assert.strictEqual(m[0].chooser, true);
        assert.strictEqual(m[0].title, 'Choose the type for 12:00');
        assert.strictEqual(m[0].items.length, 6, 'only the types');
        assert.ok(!m[0].danger && !m[0].svg, 'no split, no delete in the choice');
        assert.ok(m[0].items.some(t => t.startsWith('Comfort (22')));
    });

    it('choosing a type takes it and closes the choice', async () => {
        await page.evaluate(
            "[...document.querySelectorAll('.menu button')].find(b => b.textContent.startsWith('Normal')).click()",
        );
        await sleep(400);
        assert.strictEqual((await menus()).length, 0);
        const d = await lastDraft();
        assert.ok(
            d.program.some(e => e.day === 'Tue' && e.time === '12:00' && e.type === 'Normal'),
            JSON.stringify(d),
        );
    });

    it('a click on a line opens its menu: new switching time on top, types, delete at the bottom', async () => {
        const p = await lineAt(3, '08:00');
        await page.click(p.x, p.y);
        const m = await menus();
        assert.strictEqual(m.length, 1);
        assert.strictEqual(m[0].chooser, false);
        assert.ok(m[0].items[0].startsWith('New switching time at'), m[0].items[0]);
        assert.strictEqual(m[0].items[m[0].items.length - 1], 'Delete');
    });

    it('"new switching time" closes that menu and opens the choice at the new line', async () => {
        await page.evaluate("document.querySelector('.menu button').click()");
        await sleep(300);
        const m = await menus();
        assert.strictEqual(m.length, 1, JSON.stringify(m));
        assert.strictEqual(m[0].chooser, true);
        assert.ok(m[0].title.startsWith('Choose the type for'));
        assert.strictEqual((await pointsOf(3)).length, 5);
    });

    it('Escape closes the choice and keeps the preselected type', async () => {
        const before = (await lastDraft()).program.length;
        await page.key('Escape');
        await sleep(400);
        assert.strictEqual((await menus()).length, 0);
        assert.strictEqual((await lastDraft()).program.length, before);
    });

    it('a click next to a menu closes it', async () => {
        const p = await lineAt(0, '17:00');
        await page.click(p.x, p.y);
        assert.strictEqual((await menus()).length, 1);
        await page.click(5, 5);
        assert.strictEqual((await menus()).length, 0);
    });

    it('delete asks first, then removes the switching time and closes', async () => {
        const p = await lineAt(0, '17:00');
        await page.click(p.x, p.y);
        await page.evaluate("document.querySelector('.menu button.danger').click()");
        await sleep(200);
        const q = await page.evaluate("document.querySelector('.menu .question').textContent");
        assert.ok(q.includes('17:00'), q);
        assert.ok((await pointsOf(0)).includes('17:00'), 'not deleted before the answer');
        await page.evaluate("document.querySelector('.menu .row button.danger').click()");
        await sleep(400);
        assert.strictEqual((await menus()).length, 0);
        assert.ok(!(await pointsOf(0)).includes('17:00'));
    });

    it('"+ switching time" of a day adds one and opens the choice', async () => {
        const n = (await pointsOf(5)).length;
        await page.evaluate("document.querySelectorAll('.tools')[5].querySelector('.add').click()");
        await sleep(300);
        assert.strictEqual((await pointsOf(5)).length, n + 1);
        const m = await menus();
        assert.strictEqual(m.length, 1);
        assert.strictEqual(m[0].chooser, true);
        await page.key('Escape');
    });
});
