(function () {
    'use strict';

    // chrome.i18n wrapper for the popup and options page: data-i18n* attributes, plurals and
    // locale-aware numbers/dates. Messages live in _locales/<lang>/messages.json.

    const root = typeof window !== 'undefined' ? window : globalThis;
    root.WAExporter = root.WAExporter || {};

    const api = root.browser || root.chrome;

    function uiLanguage() {
        try {
            return (api && api.i18n && api.i18n.getUILanguage()) || 'en';
        } catch (e) {
            return 'en';
        }
    }

    /** Message for key with $1..$9 substitutions; the key itself if missing (visible in review). */
    function t(key, subs) {
        let msg = '';
        try {
            msg = api.i18n.getMessage(key, subs === undefined ? undefined : [].concat(subs).map(String));
        } catch (e) { }
        return msg || key;
    }

    const numberFormat = new Intl.NumberFormat(uiLanguage());
    const pluralRules = new Intl.PluralRules(uiLanguage());

    function num(n) {
        return numberFormat.format(n);
    }

    /** Plural message: <base>_one / <base>_other with the formatted count as $1. */
    function plural(base, n, extra = []) {
        const form = pluralRules.select(n) === 'one' ? 'one' : 'other';
        return t(`${base}_${form}`, [num(n)].concat(extra));
    }

    function shortDate(ms) {
        return new Intl.DateTimeFormat(uiLanguage(), { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(ms));
    }

    /** Fills data-i18n (text), data-i18n-aria-label, data-i18n-title and data-i18n-placeholder. */
    function apply(scope = document) {
        scope.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
        scope.querySelectorAll('[data-i18n-aria-label]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel)); });
        scope.querySelectorAll('[data-i18n-title]').forEach(el => { el.setAttribute('title', t(el.dataset.i18nTitle)); });
        scope.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder)); });
        document.documentElement.lang = uiLanguage().split('-')[0];
    }

    root.WAExporter.I18n = { t, plural, num, shortDate, apply, uiLanguage };
})();
