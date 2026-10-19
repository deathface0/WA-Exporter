#!/usr/bin/env bash
# Builds a minimal WA-JS (@wppconnect/wa-js) bundle from a pinned upstream tag and
# vendors it into vendor/wa-js/<version>/. The entry is scripts/wajs-entry/entry.ts:
# module loader + read-only finders only (no events, patches or telemetry).
#
#   scripts/build-wajs.sh 4.7.1 [4.6.1 ...]
#
#   WA_EXP_WAJS_GLOBAL  global name the bundle is exposed as (default: __waExpCore)
#   WA_EXP_BUILD_DIR    scratch dir for clones (default: $XDG_CACHE_HOME/wa-exporter/wajs-build)
set -euo pipefail

[[ $# -ge 1 ]] || { echo "Usage: $0 <version> [version...]" >&2; exit 1; }

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GLOBAL_NAME="${WA_EXP_WAJS_GLOBAL:-__waExpCore}"
BUILD_ROOT="${WA_EXP_BUILD_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/wa-exporter/wajs-build}"
UPSTREAM="https://github.com/wppconnect-team/wa-js.git"

[[ "$GLOBAL_NAME" =~ ^[A-Za-z_$][A-Za-z0-9_$]*$ ]] || { echo "Invalid global name: $GLOBAL_NAME" >&2; exit 1; }

for VERSION in "$@"; do
    VERSION="${VERSION#v}"
    [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Invalid version: $VERSION" >&2; exit 1; }

    SRC="$BUILD_ROOT/v$VERSION"
    OUT="$REPO_DIR/vendor/wa-js/$VERSION"
    echo "[build-wajs] v$VERSION -> $OUT (global: $GLOBAL_NAME)"

    rm -rf "$SRC"
    mkdir -p "$BUILD_ROOT"
    git -c advice.detachedHead=false clone --quiet --depth 1 --branch "v$VERSION" "$UPSTREAM" "$SRC"
    COMMIT="$(git -C "$SRC" rev-parse HEAD)"

    # The bundle must not rely on the default global name anywhere.
    # src/tools/ holds Playwright helpers that are not part of the bundle.
    if grep -rnE '(window|globalThis|self)\.WPP\b' "$SRC/src" --include='*.ts' --exclude-dir=tools >&2; then
        echo "[build-wajs] WARNING: src/ references the WPP global (listed above); review before renaming." >&2
    fi

    # --ignore-scripts: skip upstream lifecycle hooks (husky, prepare-time build).
    (cd "$SRC" && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error)

    # WA-JS lookups (exportModule/searchId) import every WA* module until one matches,
    # initializing modules WhatsApp had not loaded: the entry imports WhatsApp modules by name.
    if grep -nE "from '\./(whatsapp|chat|conn|contact|status|config|wa-exporter-lookups)|exportModule|\.search(Id)?\(" "$REPO_DIR/scripts/wajs-entry/entry.ts" >&2; then
        echo "[build-wajs] entry.ts must not use WA-JS module lookups (listed above)" >&2; exit 1
    fi
    cp "$REPO_DIR/scripts/wajs-entry/entry.ts" "$SRC/src/wa-exporter-entry.ts"
    mkdir -p "$SRC/src/wa-exporter-stubs"
    cp "$REPO_DIR"/scripts/wajs-entry/stubs/*.ts "$SRC/src/wa-exporter-stubs/"

    cat > "$SRC/webpack.wa-exporter.cjs" <<EOF
const path = require('path');
const webpack = require('webpack');
const base = require('./webpack.config.js');
const stub = (name) => path.resolve(__dirname, 'src/wa-exporter-stubs', name);
module.exports = (env, argv) => {
  const config = base(env, argv);
  config.entry = './src/wa-exporter-entry.ts';
  config.output.library = { name: '$GLOBAL_NAME', type: 'global' };
  config.plugins.push(
    // exportModule imports these; upstream versions register telemetry and a load-time patch.
    new webpack.NormalModuleReplacementPlugin(/(^|\\/)gtag\$/, stub('gtag.ts')),
    new webpack.NormalModuleReplacementPlugin(/chat\\/functions\\/setChatList\$/, stub('setChatList.ts')),
    // exportModule only needs wrapFunction; util/index pulls the whole library via createWid.
    new webpack.NormalModuleReplacementPlugin(/^\\.\\.\\/util\$/, (resource) => {
      const issuer = (resource.contextInfo && resource.contextInfo.issuer) || '';
      if (issuer.endsWith(path.join('whatsapp', 'exportModule.ts'))) resource.request = '../util/wrapFunction';
    })
  );
  return config;
};
EOF
    (cd "$SRC" && npx --no-install webpack --config webpack.wa-exporter.cjs --mode production)

    BUNDLE="$SRC/dist/wppconnect-wa.js"
    [[ -s "$BUNDLE" ]] || { echo "[build-wajs] Build produced no bundle" >&2; exit 1; }
    if ! grep -q "$GLOBAL_NAME" "$BUNDLE" || ! grep -q 'wa-exporter-minimal' "$BUNDLE"; then
        echo "[build-wajs] Global name or minimal flavor marker not found in bundle" >&2; exit 1
    fi
    # Anything from these upstream modules means events, patches or telemetry leaked in.
    FORBIDDEN=(
        'isOfficialClient'                              # conn/patch
        '.presence.subscribe('                          # chat/events/registerPresenceChange
        'G-MTQ4KY110F' 'analytics.google.com'           # gtag
        'uppermesh' 'titanchat' 'cloudtrix'             # util/linkPreview servers
        'web_media_encrypt_upload_in_worker_enabled'    # chat/patch
        'enable_web_calling'                            # call/enableCallInterface
        'syncAllStatus' 'WPPConfig'                     # config, status/patch
        'MsgKey error: obj is null/undefined'           # whatsapp/misc/MsgKey prototype patch
    )
    for marker in "${FORBIDDEN[@]}"; do
        if grep -qF -- "$marker" "$BUNDLE"; then
            echo "[build-wajs] Forbidden marker in bundle: $marker" >&2; exit 1
        fi
    done

    rm -rf "$OUT"
    mkdir -p "$OUT"
    cp "$BUNDLE" "$OUT/wa-js.bundle.js"
    [[ -f "$BUNDLE.LICENSE.txt" ]] && cp "$BUNDLE.LICENSE.txt" "$OUT/THIRD_PARTY_LICENSES.txt"
    cp "$SRC/LICENSE" "$OUT/LICENSE"

    SUPPORTED="$(node -p "require('$SRC/package.json').engines['whatsapp-web']")"
    cat > "$OUT/VERSION.json" <<EOF
{
  "package": "@wppconnect/wa-js",
  "version": "$VERSION",
  "upstream": "$UPSTREAM",
  "commit": "$COMMIT",
  "globalName": "$GLOBAL_NAME",
  "flavor": "wa-exporter-minimal",
  "entrySha256": "$(cd "$REPO_DIR/scripts/wajs-entry" && find . -name '*.ts' | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d' ' -f1)",
  "supportedWhatsappWeb": "$SUPPORTED",
  "sha256": "$(sha256sum "$OUT/wa-js.bundle.js" | cut -d' ' -f1)",
  "builtWith": "node $(node --version), npm $(npm --version)"
}
EOF
    echo "[build-wajs] Done: $(du -h "$OUT/wa-js.bundle.js" | cut -f1) $(cut -c1-16 <<<"$(sha256sum "$OUT/wa-js.bundle.js")")"
done
