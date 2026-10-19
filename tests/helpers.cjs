// Loads the extension's IIFE scripts into a fresh Node context.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const ROOT = join(__dirname, '..');

function loadScripts(...files) {
    const sandbox = { console, Date, Math, JSON, Intl, URL, setTimeout, clearTimeout };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    for (const f of files) {
        vm.runInContext(readFileSync(join(ROOT, f), 'utf8'), sandbox, { filename: f });
    }
    return sandbox.WAExporter;
}

module.exports = { loadScripts };
