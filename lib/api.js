'use strict';

/**
 * Client for the local REST API of Mill Generation 3 devices.
 *
 * The device firmware runs a tiny HTTP server on an ESP32. It handles one request at a
 * time, so every client serialises its requests through a queue. GET requests may carry a
 * JSON body (the API uses that for `GET /set-temperature`), which is why node:http is used
 * directly instead of fetch.
 *
 * After `POST /set-api-key` the device switches to HTTPS with a self-signed certificate and
 * expects the key in the header `Authentication`.
 */

const http = require('node:http');
const https = require('node:https');

/** Error raised for every failed request; `code` tells the caller what went wrong. */
class MillApiError extends Error {
    /**
     * @param {string} message Description
     * @param {string} code One of TIMEOUT, NETWORK, HTTP, PARSE, DEVICE
     * @param {number} [httpStatus] HTTP status, if any
     */
    constructor(message, code, httpStatus) {
        super(message);
        this.name = 'MillApiError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

/** HTTP client for one device; requests are queued. */
class MillClient {
    /**
     * @param {object} opts Options
     * @param {string} opts.host IP address or host name (optionally with :port)
     * @param {number} [opts.timeoutMs] Request timeout in milliseconds
     * @param {string} [opts.apiKey] API key; switches the client to HTTPS
     * @param {{setTimeout: (cb: () => void, ms: number) => unknown, clearTimeout: (t: unknown) => void}} [opts.timer]
     *   Timer functions of the adapter for the hard deadline (without them only the idle timeout applies)
     */
    constructor(opts) {
        this.host = String(opts.host || '')
            .replace(/^https?:\/\//, '')
            .replace(/\/+$/, '')
            .trim();
        this.timeoutMs = opts.timeoutMs || 5000;
        this.apiKey = opts.apiKey || '';
        this.timer = opts.timer || null;
        this._queue = Promise.resolve();
    }

    /**
     * Executes a request after all previously queued ones have finished.
     *
     * @param {string} method GET or POST
     * @param {string} path Endpoint without leading slash
     * @param {object} [body] JSON body
     * @returns {Promise<Record<string, unknown>>} Parsed JSON response
     */
    request(method, path, body) {
        const run = () => this._send(method, path, body);
        const p = this._queue.then(run, run);
        // Keep the queue alive even if this request fails
        this._queue = p.catch(() => undefined);
        return p;
    }

    /**
     * @param {string} path Endpoint
     * @param {object} [body] Optional JSON body (GET with body is used by the Mill API)
     */
    get(path, body) {
        return this.request('GET', path, body);
    }

    /**
     * @param {string} path Endpoint
     * @param {object} [body] JSON body
     */
    post(path, body) {
        return this.request('POST', path, body || {});
    }

    /**
     * @param {string} method HTTP method
     * @param {string} path Endpoint
     * @param {object} [body] JSON body
     * @returns {Promise<Record<string, unknown>>} Parsed response
     */
    _send(method, path, body) {
        return new Promise((resolve, reject) => {
            let settled = false;
            let hardTimer = null;
            const finish = (err, value) => {
                if (settled) {
                    return;
                }
                settled = true;
                if (hardTimer && this.timer) {
                    this.timer.clearTimeout(hardTimer);
                }
                if (err) {
                    reject(err);
                } else {
                    resolve(value);
                }
            };
            const payload = body !== undefined ? JSON.stringify(body) : undefined;
            const [hostname, port] = this.host.split(':');
            const secure = !!this.apiKey;
            const headers = { Accept: 'application/json' };
            if (payload !== undefined) {
                headers['Content-Type'] = 'application/json';
                headers['Content-Length'] = Buffer.byteLength(payload);
            }
            if (this.apiKey) {
                headers.Authentication = this.apiKey;
            }
            const lib = secure ? https : http;
            const req = lib.request(
                {
                    hostname,
                    port: port ? Number(port) : secure ? 443 : 80,
                    path: `/${path.replace(/^\/+/, '')}`,
                    method,
                    headers,
                    // The device uses a self-signed certificate once an API key is set
                    rejectUnauthorized: false,
                    agent: false,
                },
                res => {
                    let data = '';
                    res.setEncoding('utf8');
                    res.on('data', chunk => {
                        data += chunk;
                        if (data.length > 64 * 1024) {
                            req.destroy(new MillApiError(`Response of ${path} too large`, 'PARSE'));
                        }
                    });
                    res.on('end', () => {
                        const status = res.statusCode || 0;
                        let json;
                        try {
                            json = data ? JSON.parse(data) : {};
                        } catch {
                            json = undefined;
                        }
                        if (status >= 400) {
                            const text = json && json.status ? json.status : data.trim().slice(0, 100);
                            finish(new MillApiError(`HTTP ${status} on ${path}: ${text}`, 'HTTP', status));
                            return;
                        }
                        if (json === undefined || typeof json !== 'object' || json === null) {
                            finish(new MillApiError(`Invalid JSON from ${path}`, 'PARSE', status));
                            return;
                        }
                        if (json.status !== undefined && json.status !== 'ok') {
                            finish(new MillApiError(`Device answered "${json.status}" on ${path}`, 'DEVICE', status));
                            return;
                        }
                        finish(null, json);
                    });
                    res.on('error', err => finish(new MillApiError(err.message, 'NETWORK')));
                    res.on('aborted', () => finish(new MillApiError(`Connection aborted on ${path}`, 'NETWORK')));
                },
            );
            // Idle timeout of the socket (node:http)
            req.setTimeout(this.timeoutMs, () => {
                req.destroy(new MillApiError(`Timeout after ${this.timeoutMs} ms on ${path}`, 'TIMEOUT'));
            });
            // Hard deadline: a peer that trickles data would keep the idle timeout from firing
            if (this.timer) {
                hardTimer = this.timer.setTimeout(() => {
                    req.destroy(new MillApiError(`Timeout after ${this.timeoutMs} ms on ${path}`, 'TIMEOUT'));
                    finish(new MillApiError(`Timeout after ${this.timeoutMs} ms on ${path}`, 'TIMEOUT'));
                }, this.timeoutMs + 1000);
            }
            req.on('error', err => {
                finish(err instanceof MillApiError ? err : new MillApiError(`${err.message} on ${path}`, 'NETWORK'));
            });
            // 'close' always fires - guarantees that the promise settles
            req.on('close', () => finish(new MillApiError(`Connection closed on ${path}`, 'NETWORK')));
            if (payload !== undefined) {
                req.write(payload);
            }
            req.end();
        });
    }
}

module.exports = { MillClient, MillApiError };
