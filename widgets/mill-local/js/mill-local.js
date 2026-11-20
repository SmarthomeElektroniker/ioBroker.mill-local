/*
 * ioBroker.mill-local - widgets for vis 1.x
 *
 * Every widget needs one attribute: the device object (mill-local.<n>.<mac>). It finds the data points
 * below it itself and subscribes them. The overview widgets (today, summary) take up to eight devices.
 * Writing: only the target temperature (control.targetTemperature), on/off (control.power) and the operation
 * mode (control.operationMode) - the same states the device card in the admin writes. The weekly program is
 * shown only; it is edited in the admin.
 *
 * History: the chart reads the recorded values with the vis connection (getHistory) from the instance in the
 * attribute "History instance" (empty = default history instance of the system). Which adapter records is up
 * to the user (history, influxdb, sql); this adapter switches no recording on.
 */
/* global vis, $, systemDictionary */
'use strict';

(function () {
    var TYPES = ['Comfort', 'Sleep', 'Away', 'Normal', 'Off', 'AlwaysHeating'];
    var TEMP_TYPES = ['Comfort', 'Sleep', 'Away', 'Normal'];
    var DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    var MODES = ['Control individually', 'Weekly program', 'Independent device', 'Off', 'Switch'];
    var SVGNS = 'http://www.w3.org/2000/svg';

    var b = {
        version: '0.4.0',

        lang: function () {
            var l = (typeof vis !== 'undefined' && vis.language) || 'en';
            return String(l).toLowerCase();
        },

        /** Text in the vis language; %s is replaced by the arguments in order */
        t: function (key) {
            var e = (window.millLocalTexts || {})[key];
            var text = (e && (e[b.lang()] || e.en)) || key;
            for (var i = 1; i < arguments.length; i++) {
                text = text.replace('%s', arguments[i]);
            }
            return text;
        },

        num: function (v, digits) {
            if (v === null || v === undefined || v === '') {
                return null;
            }
            var n = parseFloat(v);
            if (isNaN(n)) {
                return null;
            }
            var s = n.toFixed(digits);
            var l = b.lang();
            return l === 'en' || l === 'zh-cn' ? s : s.replace('.', ',');
        },

        /** Attribute text; "@Key" is translated (the ready-made views use it, so they work in every language) */
        text: function (s) {
            s = String(s || '');
            return s.charAt(0) === '@' ? b.t(s.slice(1)) : s;
        },

        esc: function (s) {
            return $('<span>')
                .text(String(s === null || s === undefined ? '' : s))
                .html();
        },

        dark: function (data) {
            if (data.theme === 'dark') {
                return true;
            }
            if (data.theme === 'light') {
                return false;
            }
            return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
        },

        /** Subscribes states that vis does not know yet (vis only subscribes the ids of the attributes) */
        subscribe: function (states) {
            var fresh = [];
            var active = (vis.subscribing && vis.subscribing.active) || null;
            Object.keys(states).forEach(function (id) {
                var s = states[id];
                if (s && vis.states.attr(id + '.val') === undefined) {
                    vis.updateState(id, s);
                }
                if (!active) {
                    fresh.push(id);
                } else if (active.indexOf(id) === -1) {
                    active.push(id);
                    fresh.push(id);
                }
            });
            if (fresh.length) {
                vis.conn.subscribe(fresh);
            }
        },

        /**
         * Common frame of all widgets: waits for the DOM, reads the states of the device(s), builds and binds.
         *
         * @param {string} widgetID Widget id
         * @param {object} data Attributes
         * @param {string[]} prefixes Device objects
         * @param {function} build ($root, devices, data) => redraw function
         */
        start: function (widgetID, data, prefixes, build) {
            var $div = $('#' + widgetID);
            if (!$div.length) {
                return setTimeout(function () {
                    b.start(widgetID, data, prefixes, build);
                }, 100);
            }
            var $root = $('<div class="mlv"></div>').toggleClass('mlv-dark', b.dark(data));
            $div.empty().append($root);
            prefixes = prefixes.filter(function (p) {
                return !!p;
            });
            if (!prefixes.length) {
                $root.html(
                    '<div class="mlv-note">' + b.t('No device', '<code>mill-local.0.94e686001234</code>') + '</div>',
                );
                return;
            }
            var devices = [];
            var open = prefixes.length;
            prefixes.forEach(function (prefix, i) {
                vis.conn.getStates(prefix + '.*', function (err, states) {
                    states = states || {};
                    b.subscribe(states);
                    devices[i] = b.device(prefix, states);
                    if (--open) {
                        return;
                    }
                    var redraw = build($root, devices, data);
                    if (typeof redraw !== 'function') {
                        return;
                    }
                    var bound = [];
                    devices.forEach(function (d) {
                        Object.keys(d.states).forEach(function (id) {
                            vis.states.bind(id + '.val', redraw);
                            bound.push(id + '.val');
                        });
                    });
                    $div.data('bound', bound);
                    $div.data('bindHandler', redraw);
                    redraw();
                });
            });
        },

        /** Access to the values of one device */
        device: function (prefix, states) {
            return {
                prefix: prefix,
                states: states,
                has: function (rel) {
                    return Object.prototype.hasOwnProperty.call(states, prefix + '.' + rel);
                },
                val: function (rel) {
                    var v = vis.states.attr(prefix + '.' + rel + '.val');
                    return v === undefined ? null : v;
                },
                oid: function (rel) {
                    return prefix + '.' + rel;
                },
            };
        },

        temps: function (d) {
            return {
                Comfort: d.val('settings.temperatureComfort'),
                Sleep: d.val('settings.temperatureSleep'),
                Away: d.val('settings.temperatureAway'),
                Normal: d.val('control.targetTemperature'),
            };
        },

        /** Weekly program as [{m (minutes since Monday 00:00), type}] */
        program: function (d) {
            var list = [];
            try {
                list = JSON.parse(d.val('settings.weeklyProgram') || '[]');
            } catch (e) {
                list = [];
            }
            return (Array.isArray(list) ? list : [])
                .map(function (e) {
                    var p = String(e.time || '').split(':');
                    return { m: DAYS.indexOf(e.day) * 1440 + Number(p[0]) * 60 + Number(p[1]), type: e.type };
                })
                .filter(function (e) {
                    return e.m >= 0 && !isNaN(e.m);
                })
                .sort(function (x, y) {
                    return x.m - y.m;
                });
        },

        weekMinute: function (date) {
            date = date || new Date();
            return ((date.getDay() + 6) % 7) * 1440 + date.getHours() * 60 + date.getMinutes();
        },

        /** Type at a minute of the week; null without program */
        typeAt: function (prog, m) {
            if (!prog.length) {
                return null;
            }
            var t = prog[prog.length - 1].type;
            prog.forEach(function (p) {
                if (p.m <= m) {
                    t = p.type;
                }
            });
            return t;
        },

        hhmm: function (m) {
            m = ((m % 1440) + 1440) % 1440;
            return ('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2);
        },

        label: function (type) {
            return b.t(type);
        },

        typeText: function (type, temps) {
            var v = temps[type];
            return TEMP_TYPES.indexOf(type) >= 0 && b.num(v, 1) !== null
                ? b.label(type) + ' (' + b.num(v, 1).replace(/[.,]0$/, '') + ' °C)'
                : b.label(type);
        },

        /**
         * What the device does now: {type, text, until}. Weekly program: the running period and when it ends;
         * other modes: the mode itself (Normal colour while regulating, grey while off).
         */
        state: function (d) {
            var mode = String(d.val('control.operationMode') || '');
            var temps = b.temps(d);
            if (mode === 'Weekly program') {
                var prog = b.program(d);
                var now = b.weekMinute();
                var type = b.typeAt(prog, now) || 'Normal';
                var next = null;
                prog.forEach(function (p) {
                    if (next === null && p.m > now) {
                        next = p.m;
                    }
                });
                if (next === null && prog.length) {
                    next = prog[0].m + 7 * 1440;
                }
                return { type: type, text: b.typeText(type, temps), until: next === null ? '' : b.hhmm(next) };
            }
            if (mode === 'Off') {
                return { type: 'Off', text: b.t('Off'), until: '' };
            }
            if (mode === 'Switch') {
                var on = !!d.val('status.heating');
                return {
                    type: on ? 'AlwaysHeating' : 'Off',
                    text: b.t('Switch') + ' · ' + (on ? b.t('Switch on') : b.t('Off')),
                    until: '',
                };
            }
            if (MODES.indexOf(mode) >= 0) {
                return {
                    type: 'Normal',
                    text: b.t(mode) + ' (' + (b.num(temps.Normal, 1) || '–').replace(/[.,]0$/, '') + ' °C)',
                    until: '',
                };
            }
            return { type: 'Off', text: mode || '–', until: '' };
        },

        chip: function (st, extra) {
            return (
                '<span class="mlv-chip mlv-c-' +
                st.type +
                '">' +
                b.esc(st.text) +
                (extra ? ' ' + b.esc(extra) : '') +
                '</span>'
            );
        },

        name: function (d, data) {
            return b.text(data.title) || d.val('info.customName') || d.prefix.split('.').pop();
        },

        kind: function (d) {
            return b.t('kind.' + (d.val('info.type') || 'unknown'));
        },

        setTarget: function (d, delta) {
            var cur = parseFloat(d.val('control.targetTemperature'));
            if (isNaN(cur)) {
                return;
            }
            var v = Math.min(35, Math.max(5, Math.round((cur + delta) * 2) / 2));
            vis.setValue(d.oid('control.targetTemperature'), v);
        },

        go: function (view) {
            if (view && !vis.editMode) {
                window.location.hash = '#' + view;
            }
        },

        /* ------------------------------------------------------------------ widgets */

        /** Background of a view with title (follows the colour scheme) */
        page: function (widgetID, view, data) {
            var $div = $('#' + widgetID);
            if (!$div.length) {
                return setTimeout(function () {
                    b.page(widgetID, view, data);
                }, 100);
            }
            var $root = $('<div class="mlv mlv-page"></div>').toggleClass('mlv-dark', b.dark(data));
            $root.html(
                (data.subtitle ? '<div class="mlv-over">' + b.esc(b.text(data.subtitle)) + '</div>' : '') +
                    (data.title ? '<h1>' + b.esc(b.text(data.title)) + '</h1>' : '') +
                    (data.detailView
                        ? '<a class="mlv-back" href="#' + b.esc(data.detailView) + '">← ' + b.esc(b.t('Back')) + '</a>'
                        : ''),
            );
            $div.empty().append($root);
        },

        /** Device card of the overview */
        card: function (widgetID, view, data) {
            b.start(widgetID, data, [data.deviceOid], function ($root, devs, data) {
                var d = devs[0];
                $root.addClass('mlv-card mlv-box');
                $root.html(
                    '<div class="mlv-head"><div><div class="mlv-name"></div><div class="mlv-sub"></div></div><span class="mlv-dot"></span></div>' +
                        '<div class="mlv-big"><span class="mlv-temp"></span><span class="mlv-unit">°C</span></div>' +
                        '<div class="mlv-row"><span class="mlv-state"></span><span class="mlv-target mlv-muted"></span></div>' +
                        '<div class="mlv-foot"><span class="mlv-power"></span><span class="mlv-energy"></span></div>' +
                        '<div class="mlv-buttons"><button class="mlv-btn mlv-minus">−</button><button class="mlv-btn mlv-plus">+</button><button class="mlv-btn mlv-wide mlv-onoff"></button></div>',
                );
                $root
                    .find('.mlv-minus')
                    .attr('aria-label', b.t('Lower target'))
                    .on('click', function (e) {
                        e.stopPropagation();
                        b.setTarget(d, -0.5);
                    });
                $root
                    .find('.mlv-plus')
                    .attr('aria-label', b.t('Raise target'))
                    .on('click', function (e) {
                        e.stopPropagation();
                        b.setTarget(d, 0.5);
                    });
                $root.find('.mlv-onoff').on('click', function (e) {
                    e.stopPropagation();
                    vis.setValue(d.oid('control.power'), !d.val('control.power'));
                });
                if (data.detailView) {
                    $root.addClass('mlv-link').on('click', function () {
                        b.go(data.detailView);
                    });
                }
                return function () {
                    var online = d.val('info.online') !== false;
                    var st = b.state(d);
                    $root.find('.mlv-name').text(b.name(d, data));
                    $root.find('.mlv-sub').text(b.kind(d));
                    $root
                        .find('.mlv-dot')
                        .toggleClass('mlv-off', !online)
                        .attr('title', b.t(online ? 'reachable' : 'unreachable'));
                    $root.find('.mlv-temp').text(b.num(d.val('sensor.temperature'), 1) || '–');
                    $root.find('.mlv-state').html(b.chip(st));
                    $root
                        .find('.mlv-target')
                        .text(b.t('Target') + ' ' + (b.num(d.val('control.targetTemperature'), 1) || '–') + ' °C');
                    $root.find('.mlv-power').text((b.num(d.val('status.power'), 0) || '0') + ' W');
                    $root.find('.mlv-energy').text((b.num(d.val('energy.today'), 2) || '0') + ' kWh');
                    $root.find('.mlv-onoff').text(d.val('control.power') ? b.t('Switch off') : b.t('Switch on'));
                };
            });
        },

        /** Phone card: compact, one per device */
        phone: function (widgetID, view, data) {
            b.start(widgetID, data, [data.deviceOid], function ($root, devs, data) {
                var d = devs[0];
                $root.addClass('mlv-phone mlv-box');
                $root.html(
                    '<div class="mlv-left"><div class="mlv-name"></div><span class="mlv-state"></span><span class="mlv-power mlv-muted"></span></div>' +
                        '<div class="mlv-right"><div class="mlv-big"><span class="mlv-temp"></span><span class="mlv-unit">°C</span></div>' +
                        '<div class="mlv-set"><button class="mlv-btn mlv-round mlv-minus">−</button><span class="mlv-target"></span><button class="mlv-btn mlv-round mlv-plus">+</button></div></div>',
                );
                $root
                    .find('.mlv-minus')
                    .attr('aria-label', b.t('Lower target'))
                    .on('click', function () {
                        b.setTarget(d, -0.5);
                    });
                $root
                    .find('.mlv-plus')
                    .attr('aria-label', b.t('Raise target'))
                    .on('click', function () {
                        b.setTarget(d, 0.5);
                    });
                return function () {
                    $root.find('.mlv-name').text(b.name(d, data));
                    $root.find('.mlv-state').html(b.chip(b.state(d)));
                    $root
                        .find('.mlv-power')
                        .text(b.t('Current power') + ' ' + (b.num(d.val('status.power'), 0) || '0') + ' W');
                    $root.find('.mlv-temp').text(b.num(d.val('sensor.temperature'), 1) || '–');
                    $root.find('.mlv-target').text((b.num(d.val('control.targetTemperature'), 1) || '–') + ' °C');
                };
            });
        },

        /** Detail: room temperature, running period, target with − / + */
        thermostat: function (widgetID, view, data) {
            b.start(widgetID, data, [data.deviceOid], function ($root, devs) {
                var d = devs[0];
                $root.addClass('mlv-thermo mlv-box');
                $root.html(
                    '<span class="mlv-muted">' +
                        b.esc(b.t('Room temperature')) +
                        '</span>' +
                        '<div class="mlv-huge"><span class="mlv-temp"></span><span class="mlv-unit">°C</span></div>' +
                        '<span class="mlv-state"></span>' +
                        '<div class="mlv-set"><button class="mlv-btn mlv-round mlv-minus">−</button>' +
                        '<div class="mlv-col"><span class="mlv-muted">' +
                        b.esc(b.t('Target')) +
                        '</span><span class="mlv-target"></span></div>' +
                        '<button class="mlv-btn mlv-round mlv-plus">+</button></div>',
                );
                $root
                    .find('.mlv-minus')
                    .attr('aria-label', b.t('Lower target'))
                    .on('click', function () {
                        b.setTarget(d, -0.5);
                    });
                $root
                    .find('.mlv-plus')
                    .attr('aria-label', b.t('Raise target'))
                    .on('click', function () {
                        b.setTarget(d, 0.5);
                    });
                return function () {
                    var st = b.state(d);
                    $root.find('.mlv-temp').text(b.num(d.val('sensor.temperature'), 1) || '–');
                    $root.find('.mlv-state').html(b.chip(st, st.until ? b.t('until') + ' ' + st.until : ''));
                    $root.find('.mlv-target').text((b.num(d.val('control.targetTemperature'), 1) || '–') + ' °C');
                };
            });
        },

        /** Detail header: name, kind and reachability */
        title: function (widgetID, view, data) {
            b.start(widgetID, data, [data.deviceOid], function ($root, devs, data) {
                var d = devs[0];
                $root.addClass('mlv-title');
                $root.html(
                    (data.detailView
                        ? '<a class="mlv-back" href="#' + b.esc(data.detailView) + '">← ' + b.esc(b.t('Back')) + '</a>'
                        : '') + '<h1></h1><span class="mlv-muted mlv-sub"></span>',
                );
                return function () {
                    var online = d.val('info.online') !== false;
                    $root.find('h1').text(b.name(d, data));
                    $root.find('.mlv-sub').text(b.kind(d) + ' · ' + b.t(online ? 'reachable' : 'unreachable'));
                };
            });
        },

        /** Detail: values in a grid */
        values: function (widgetID, view, data) {
            b.start(widgetID, data, [data.deviceOid], function ($root, devs) {
                var d = devs[0];
                $root.addClass('mlv-values mlv-box');
                return function () {
                    var rows = [
                        [b.t('Current power'), (b.num(d.val('status.power'), 0) || '0') + ' W'],
                        [b.t('Energy today (estimated)'), (b.num(d.val('energy.today'), 2) || '0') + ' kWh'],
                    ];
                    if (d.has('sensor.humidity')) {
                        rows.push([b.t('Humidity'), (b.num(d.val('sensor.humidity'), 0) || '–') + ' %']);
                    }
                    rows.push([b.t('Open window'), b.t(d.val('status.openWindowActive') ? 'yes' : 'no')]);
                    rows.push([b.t('Child lock'), b.t(d.val('settings.childLock') ? 'yes' : 'no')]);
                    $root.html(
                        rows
                            .map(function (r) {
                                return (
                                    '<div><span class="mlv-muted">' +
                                    b.esc(r[0]) +
                                    '</span><b>' +
                                    b.esc(r[1]) +
                                    '</b></div>'
                                );
                            })
                            .join(''),
                    );
                };
            });
        },

        /** Detail: operation mode (writes control.operationMode) */
        mode: function (widgetID, view, data) {
            b.start(widgetID, data, [data.deviceOid], function ($root, devs) {
                var d = devs[0];
                $root.addClass('mlv-mode');
                var $sel = $('<select class="mlv-select"></select>');
                MODES.forEach(function (m) {
                    $sel.append($('<option>').val(m).text(b.t(m)));
                });
                $root.append($('<label class="mlv-muted">').text(b.t('Operation mode')), $sel);
                $sel.on('change', function () {
                    vis.setValue(d.oid('control.operationMode'), $sel.val());
                });
                return function () {
                    var m = String(d.val('control.operationMode') || '');
                    if (MODES.indexOf(m) < 0 && m && !$sel.find('option[value="' + m + '"]').length) {
                        $sel.append($('<option>').val(m).text(m));
                    }
                    $sel.val(m);
                };
            });
        },

        /** Bands of one day: [{a, b, type}] for day d (0 = Monday) */
        dayBlocks: function (prog, day) {
            var start = day * 1440;
            var cuts = [start];
            prog.forEach(function (p) {
                if (p.m > start && p.m < start + 1440) {
                    cuts.push(p.m);
                }
            });
            cuts.push(start + 1440);
            var out = [];
            for (var i = 0; i < cuts.length - 1; i++) {
                out.push({ a: cuts[i], b: cuts[i + 1], type: b.typeAt(prog, cuts[i]) });
            }
            return out;
        },

        bandHtml: function (blocks, day, temps, withText) {
            var now = b.weekMinute();
            var html = blocks
                .map(function (bl) {
                    var w = ((bl.b - bl.a) / 1440) * 100;
                    var text = bl.type ? b.typeText(bl.type, temps) : '–';
                    return (
                        '<div class="mlv-bl mlv-c-' +
                        (bl.type || 'none') +
                        '" style="width:' +
                        w +
                        '%" title="' +
                        b.esc(b.hhmm(bl.a) + '–' + (bl.b % 1440 ? b.hhmm(bl.b) : '24:00') + ' ' + text) +
                        '">' +
                        (withText && w > 9 ? b.esc(text) : '') +
                        '</div>'
                    );
                })
                .join('');
            if (Math.floor(now / 1440) === day) {
                html += '<div class="mlv-now" style="left:' + ((now % 1440) / 1440) * 100 + '%"></div>';
            }
            return html;
        },

        /** Detail: weekly program as a grid (display only) */
        week: function (widgetID, view, data) {
            b.start(widgetID, data, [data.deviceOid], function ($root, devs) {
                var d = devs[0];
                $root.addClass('mlv-week');
                return function () {
                    var prog = b.program(d);
                    var temps = b.temps(d);
                    var names = [];
                    for (var i = 0; i < 7; i++) {
                        try {
                            names.push(
                                new Intl.DateTimeFormat(b.lang(), { weekday: 'short' }).format(
                                    new Date(2024, 0, 1 + i),
                                ),
                            );
                        } catch (e) {
                            names.push(DAYS[i]);
                        }
                    }
                    var legend = TYPES.filter(function (t) {
                        return t !== 'Off' && t !== 'AlwaysHeating';
                    })
                        .map(function (t) {
                            return (
                                '<span class="mlv-chip mlv-c-' +
                                t +
                                '">' +
                                b.esc(b.label(t) + ' ' + (b.num(temps[t], 1) || '–').replace(/[.,]0$/, '') + ' °C') +
                                '</span>'
                            );
                        })
                        .join('');
                    var rows =
                        '<div class="mlv-wrow mlv-scale"><span></span><div><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div></div>';
                    for (var day = 0; day < 7; day++) {
                        rows +=
                            '<div class="mlv-wrow"><span>' +
                            b.esc(names[day]) +
                            '</span><div class="mlv-band">' +
                            b.bandHtml(b.dayBlocks(prog, day), day, temps, true) +
                            '</div></div>';
                    }
                    $root.html(
                        '<div class="mlv-whead"><h2>' +
                            b.esc(b.t('Weekly program')) +
                            '</h2><div class="mlv-legend">' +
                            legend +
                            '</div></div>' +
                            '<div class="mlv-box mlv-wgrid">' +
                            rows +
                            '</div>' +
                            '<div class="mlv-wfoot mlv-muted"><span>' +
                            b.esc(b.t('Schedule note')) +
                            '</span><span>' +
                            prog.length +
                            ' / 64 ' +
                            b.esc(b.t('switching times')) +
                            '</span></div>',
                    );
                };
            });
        },

        devicesOf: function (data) {
            var list = [];
            for (var i = 1; i <= 8; i++) {
                if (data['deviceOid' + i]) {
                    list.push(data['deviceOid' + i]);
                }
            }
            return list;
        },

        /** Overview: today's band of every device */
        today: function (widgetID, view, data) {
            b.start(widgetID, data, b.devicesOf(data), function ($root, devs) {
                $root.addClass('mlv-today mlv-box');
                return function () {
                    var day = Math.floor(b.weekMinute() / 1440);
                    var html =
                        '<div class="mlv-thead"><b>' +
                        b.esc(b.t('Today')) +
                        '</b><span class="mlv-muted">0 – 24</span></div>';
                    devs.forEach(function (d) {
                        var mode = String(d.val('control.operationMode') || '');
                        var blocks;
                        if (mode === 'Weekly program') {
                            blocks = b.dayBlocks(b.program(d), day);
                        } else {
                            blocks = [{ a: day * 1440, b: (day + 1) * 1440, type: b.state(d).type }];
                        }
                        html +=
                            '<div class="mlv-trow"><span>' +
                            b.esc(b.name(d, {})) +
                            '</span><div class="mlv-band mlv-thin">' +
                            b.bandHtml(blocks, day, b.temps(d), false) +
                            '</div></div>';
                    });
                    html +=
                        '<div class="mlv-legend mlv-small">' +
                        TYPES.filter(function (t) {
                            return t !== 'AlwaysHeating';
                        })
                            .map(function (t) {
                                return '<span><i class="mlv-c-' + t + '"></i>' + b.esc(b.label(t)) + '</span>';
                            })
                            .join('') +
                        '</div>';
                    $root.html(html);
                };
            });
        },

        /** Overview: total power and energy today of all devices */
        summary: function (widgetID, view, data) {
            b.start(widgetID, data, b.devicesOf(data), function ($root, devs) {
                $root.addClass('mlv-summary');
                return function () {
                    var p = 0;
                    var e = 0;
                    devs.forEach(function (d) {
                        p += Number(d.val('status.power')) || 0;
                        e += Number(d.val('energy.today')) || 0;
                    });
                    $root.html(
                        '<div><span class="mlv-muted">' +
                            b.esc(b.t('Total power')) +
                            '</span><b>' +
                            b.num(p, 0) +
                            ' W</b></div>' +
                            '<div><span class="mlv-muted">' +
                            b.esc(b.t('Energy today (estimated)')) +
                            '</span><b>' +
                            b.num(e, 2) +
                            ' kWh</b></div>',
                    );
                };
            });
        },

        /* ------------------------------------------------------------------ history chart */

        /**
         * Chart: room temperature and target (step line) on the left axis, current power as area on the right
         * axis; humidity (if the device has it) in a small panel below. 24 h or 7 days.
         */
        history: function (widgetID, view, data) {
            b.start(widgetID, data, [data.deviceOid], function ($root, devs, data) {
                var d = devs[0];
                var range = data.range === '7d' ? '7d' : '24h';
                $root.addClass('mlv-history mlv-box');
                $root.html(
                    '<div class="mlv-hhead"><b>' +
                        b.esc(b.t('History')) +
                        '</b><div class="mlv-seg">' +
                        '<button data-r="24h">' +
                        b.esc(b.t('24 h')) +
                        '</button><button data-r="7d">' +
                        b.esc(b.t('7 days')) +
                        '</button></div></div>' +
                        '<div class="mlv-hleg"></div><div class="mlv-chart"></div><div class="mlv-hnote mlv-muted"></div>',
                );
                var load = function () {
                    $root.find('.mlv-seg button').each(function () {
                        $(this).toggleClass('mlv-on', $(this).attr('data-r') === range);
                    });
                    b.historyLoad(d, data, range, function (series, notes) {
                        b.historyDraw($root, d, series, range);
                        $root.find('.mlv-hnote').text(notes.join(' '));
                    });
                };
                $root.find('.mlv-seg button').on('click', function () {
                    range = $(this).attr('data-r');
                    load();
                });
                load();
                // refresh every 5 minutes, not on every state change
                var timer = setInterval(function () {
                    if (!$.contains(document, $root[0])) {
                        return clearInterval(timer);
                    }
                    load();
                }, 300000);
                return null;
            });
        },

        historyInstance: function (data, cb) {
            if (data.historyInstance) {
                return cb(String(data.historyInstance).replace(/^system\.adapter\./, ''));
            }
            vis.conn.getObject('system.config', function (err, obj) {
                cb((obj && obj.common && obj.common.defaultHistory) || 'history.0');
            });
        },

        historyLoad: function (d, data, range, done) {
            var end = Date.now();
            var start = end - (range === '7d' ? 7 * 86400000 : 86400000);
            var ids = { temp: 'sensor.temperature', target: 'status.activeTargetTemperature', power: 'status.power' };
            if (d.has('sensor.humidity')) {
                ids.hum = 'sensor.humidity';
            }
            b.historyInstance(data, function (instance) {
                var keys = Object.keys(ids);
                var out = {};
                var notes = [];
                var open = keys.length;
                keys.forEach(function (k) {
                    var opts = {
                        instance: instance,
                        start: start,
                        end: end,
                        ignoreNull: true,
                        timeout: 20000,
                        count: 50000,
                    };
                    // 24 h: the raw values (an aggregation would invent values and smooth the peaks away);
                    // 7 days: the mean per hour of the recorded values, the target stays raw (step line)
                    if (range === '7d' && k !== 'target') {
                        opts.aggregate = 'average';
                        opts.step = 3600000;
                    } else {
                        opts.aggregate = 'none';
                    }
                    vis.conn.getHistory(d.oid(ids[k]), opts, function (err, res) {
                        var pts = (Array.isArray(res) ? res : [])
                            .filter(function (p) {
                                return p && p.val !== null && p.val !== undefined && !isNaN(Number(p.val));
                            })
                            .map(function (p) {
                                return [Number(p.ts), Number(p.val)];
                            })
                            .sort(function (x, y) {
                                return x[0] - y[0];
                            });
                        // the last known value lasts until now
                        var cur = d.val(ids[k]);
                        if (cur !== null && !isNaN(Number(cur))) {
                            pts.push([end, Number(cur)]);
                        }
                        out[k] = pts;
                        if ((err || pts.length < 2) && k !== 'hum') {
                            notes.push(b.t('No recording', d.oid(ids[k]), instance));
                        }
                        if (!--open) {
                            done(out, notes.slice(0, 1));
                        }
                    });
                });
            });
        },

        svg: function (tag, attrs) {
            var el = document.createElementNS(SVGNS, tag);
            Object.keys(attrs || {}).forEach(function (k) {
                el.setAttribute(k, attrs[k]);
            });
            return el;
        },

        historyDraw: function ($root, d, s, range) {
            var $c = $root.find('.mlv-chart');
            var W = $c.width() || 600;
            var H = $c.height() || 200;
            var hasHum = s.hum && s.hum.length > 1;
            var mainH = hasHum ? Math.round(H * 0.72) : H;
            var L = 40;
            var R = 46;
            var T = 8;
            var B = 20;
            var end = Date.now();
            var start = end - (range === '7d' ? 7 * 86400000 : 86400000);
            var x = function (ts) {
                return L + ((ts - start) / (end - start)) * (W - L - R);
            };
            var svg = b.svg('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, role: 'img' });
            var temps = [].concat(s.temp || [], s.target || []).map(function (p) {
                return p[1];
            });
            var tmin = temps.length ? Math.floor(Math.min.apply(null, temps) - 1) : 15;
            var tmax = temps.length ? Math.ceil(Math.max.apply(null, temps) + 1) : 25;
            var pmax = Math.max(
                100,
                Math.max.apply(
                    null,
                    [0].concat(
                        (s.power || []).map(function (p) {
                            return p[1];
                        }),
                    ),
                ),
            );
            pmax = Math.ceil(pmax / 100) * 100;
            var yT = function (v) {
                return T + (1 - (v - tmin) / (tmax - tmin)) * (mainH - T - B);
            };
            var yP = function (v) {
                return T + (1 - v / pmax) * (mainH - T - B);
            };
            // grid and axes
            var ticks = 4;
            for (var i = 0; i <= ticks; i++) {
                var v = tmin + ((tmax - tmin) * i) / ticks;
                var yy = yT(v);
                svg.appendChild(b.svg('line', { x1: L, x2: W - R, y1: yy, y2: yy, class: 'mlv-grid' }));
                var lt = b.svg('text', { x: L - 6, y: yy + 4, 'text-anchor': 'end', class: 'mlv-axis' });
                lt.textContent = b.num(v, 0) + '°';
                svg.appendChild(lt);
                var rt = b.svg('text', { x: W - R + 6, y: yy + 4, class: 'mlv-axis' });
                rt.textContent = Math.round((pmax * i) / ticks) + ' W';
                svg.appendChild(rt);
            }
            // time labels
            var steps = range === '7d' ? 7 : 6;
            for (var j = 0; j <= steps; j++) {
                var ts = start + ((end - start) * j) / steps;
                var tx = b.svg('text', { x: x(ts), y: mainH - 4, 'text-anchor': 'middle', class: 'mlv-axis' });
                var dt = new Date(ts);
                tx.textContent =
                    range === '7d'
                        ? new Intl.DateTimeFormat(b.lang(), { weekday: 'short' }).format(dt)
                        : ('0' + dt.getHours()).slice(-2) + ':' + ('0' + dt.getMinutes()).slice(-2);
                svg.appendChild(tx);
            }
            var stepPath = function (pts, y) {
                var p = '';
                pts.forEach(function (q, k) {
                    var px = Math.max(L, x(q[0]));
                    if (!k) {
                        p += 'M' + px + ',' + y(q[1]);
                    } else {
                        p += 'H' + px + 'V' + y(q[1]);
                    }
                });
                return p;
            };
            var linePath = function (pts, y) {
                return pts
                    .map(function (q, k) {
                        return (k ? 'L' : 'M') + Math.max(L, x(q[0])) + ',' + y(q[1]);
                    })
                    .join('');
            };
            if (s.power && s.power.length > 1) {
                var pp = stepPath(s.power, yP);
                var first = Math.max(L, x(s.power[0][0]));
                svg.appendChild(b.svg('path', { d: pp + 'V' + yP(0) + 'H' + first + 'Z', class: 'mlv-s-power' }));
            }
            if (s.target && s.target.length > 1) {
                svg.appendChild(b.svg('path', { d: stepPath(s.target, yT), class: 'mlv-s-target' }));
            }
            if (s.temp && s.temp.length > 1) {
                svg.appendChild(b.svg('path', { d: linePath(s.temp, yT), class: 'mlv-s-temp' }));
            }
            if (hasHum) {
                var top = mainH + 6;
                var hH = H - top - 4;
                var yH = function (v) {
                    return top + (1 - v / 100) * hH;
                };
                svg.appendChild(b.svg('line', { x1: L, x2: W - R, y1: yH(50), y2: yH(50), class: 'mlv-grid' }));
                var ht = b.svg('text', { x: L - 6, y: yH(50) + 4, 'text-anchor': 'end', class: 'mlv-axis' });
                ht.textContent = '50 %';
                svg.appendChild(ht);
                svg.appendChild(b.svg('path', { d: linePath(s.hum, yH), class: 'mlv-s-hum' }));
            }
            $c.empty().append(svg);
            var leg = [
                ['temp', b.t('Room temperature')],
                ['target', b.t('Target')],
                [
                    'power',
                    range === '7d' ? b.t('Current power') + ' (' + b.t('hourly mean') + ')' : b.t('Current power'),
                ],
            ];
            if (hasHum) {
                leg.push(['hum', b.t('Humidity')]);
            }
            $root.find('.mlv-hleg').html(
                leg
                    .map(function (l) {
                        return '<span><i class="mlv-k-' + l[0] + '"></i>' + b.esc(l[1]) + '</span>';
                    })
                    .join(''),
            );
        },
    };

    if (typeof vis !== 'undefined') {
        vis.binds['mill-local'] = b;
        if (vis.editMode && typeof systemDictionary !== 'undefined') {
            var dict = {};
            var texts = window.millLocalTexts || {};
            Object.keys(texts).forEach(function (k) {
                dict[k] = texts[k];
            });
            dict['group_mill-local'] = texts.group_mill;
            $.extend(true, systemDictionary, dict);
        }
    }
})();
