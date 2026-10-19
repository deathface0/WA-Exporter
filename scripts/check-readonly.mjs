#!/usr/bin/env node
// Fails if wajs/host.js touches the WA-JS bundle outside the read-only allowlist.
// Usage: node scripts/check-readonly.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HOST = join(dirname(fileURLToPath(import.meta.url)), '..', 'wajs', 'host.js');

// Every `core.<path>` the host may use. Adding one requires checking its source
// in the pinned WA-JS tag: it must not send, mark, modify or query the server.
const ALLOWED = new Set([
    'core.version',
    'core.flavor',
    'core.supportedWhatsappWeb',
    'core.loader',
    'core.loader.isReady',
    'core.loader.onReady',
    'core.loader.loaderType',
    'core.chat',
    'core.chat.getActiveChat',
    'core.chat.getMessages',
    'core.chat.reset'
]);

const DENY = /\b(send\w*|mark\w*|star\w*|pin\w*|archive|unarchive|delete\w*|edit\w*|forward\w*|react\w*|subscribePresence|block\w*|clear|mute|unmute|join\w*|leave|set\w*|queryExists|openChat\w*|keepMessage|requestPhoneNumber|rehydrateMessage)\b/;

const source = readFileSync(HOST, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

const errors = [];

for (const match of source.matchAll(/\bcore((?:\.[A-Za-z_$][\w$]*)*)(\s*\[)?/g)) {
    const path = 'core' + match[1];
    if (match[2]) errors.push(`dynamic access: ${path}[...]`);
    if (path === 'core') continue;
    if (!ALLOWED.has(path)) errors.push(`not allowlisted: ${path}`);
    if (DENY.test(match[1])) errors.push(`forbidden name: ${path}`);
}

// The bare identifier may only appear where it is captured, never passed around.
const bareUses = [...source.matchAll(/\bcore\b(?!\s*[.[])/g)].length;
const captures = [...source.matchAll(/\bconst\s+core\s*=\s*window\.__waExpCore\b/g)].length;
const guards = [...source.matchAll(/!\s*core\b(?!\s*[.[])/g)].length;
if (captures !== 1) errors.push(`expected exactly one "const core = window.__waExpCore", found ${captures}`);
if (bareUses !== captures + guards) errors.push(`core used as a bare value ${bareUses - captures - guards} time(s) (passed or aliased)`);

// No aliasing of WA-JS modules into locals (e.g. `const chat = core.chat`).
for (const match of source.matchAll(/=\s*core\.([A-Za-z_$][\w$]*)\b(?!\s*[.[(])/g)) {
    errors.push(`module aliased into a local: core.${match[1]}`);
}

const globalReads = [...source.matchAll(/window\.__waExpCore\b/g)].length;
if (globalReads > 2) errors.push(`window.__waExpCore referenced ${globalReads} times (capture + release only)`);

if (errors.length) {
    console.error('[check-readonly] FAIL');
    errors.forEach(e => console.error('  - ' + e));
    process.exit(1);
}
console.log('[check-readonly] OK: wajs/host.js only uses allowlisted read-only WA-JS APIs.');
