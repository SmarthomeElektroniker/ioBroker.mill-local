'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const LANGUAGES = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];
const TEXT_KEYS = ['label', 'text', 'help', 'title', 'tooltip', 'placeholder', 'buttonText', 'validatorErrorText'];

const jsonConfig = JSON.parse(fs.readFileSync(path.join(root, 'admin', 'jsonConfig.json'), 'utf8'));
const ioPackage = JSON.parse(fs.readFileSync(path.join(root, 'io-package.json'), 'utf8'));
const i18n = Object.fromEntries(
    LANGUAGES.map(l => [l, JSON.parse(fs.readFileSync(path.join(root, 'admin', 'i18n', `${l}.json`), 'utf8'))]),
);

/** @returns {Set<string>} all texts of jsonConfig.json that are looked up in admin/i18n */
function usedTexts() {
    const used = new Set();
    const walk = o => {
        if (Array.isArray(o)) {
            o.forEach(walk);
        } else if (o && typeof o === 'object') {
            for (const [k, v] of Object.entries(o)) {
                if (TEXT_KEYS.includes(k) && typeof v === 'string') {
                    used.add(v);
                }
                walk(v);
            }
        }
    };
    walk(jsonConfig);
    return used;
}

/**
 * @param {Record<string, string>} obj i18n object
 * @param {string} what Description for the message
 */
function assertTranslated(obj, what) {
    for (const l of LANGUAGES) {
        assert.ok(obj[l], `${what}: ${l} missing`);
        if (l !== 'en') {
            assert.notStrictEqual(obj[l], obj.en, `${what}: ${l} is not translated`);
        }
    }
}

describe('translations', () => {
    it('has a translation for every text of jsonConfig.json and no unused keys', () => {
        const used = usedTexts();
        const keys = Object.keys(i18n.en);
        assert.deepStrictEqual(
            [...used].filter(t => !keys.includes(t)),
            [],
            'texts without translation',
        );
        assert.deepStrictEqual(
            keys.filter(k => !used.has(k)),
            [],
            'unused keys',
        );
    });

    it('translates every admin text into all eleven languages', () => {
        for (const key of Object.keys(i18n.en)) {
            assertTranslated(Object.fromEntries(LANGUAGES.map(l => [l, i18n[l][key]])), key);
        }
    });

    it('translates titleLang, desc and news in io-package.json', () => {
        assertTranslated(ioPackage.common.titleLang, 'titleLang');
        assertTranslated(ioPackage.common.desc, 'desc');
        for (const [version, news] of Object.entries(ioPackage.common.news)) {
            assertTranslated(news, `news ${version}`);
        }
    });
});
