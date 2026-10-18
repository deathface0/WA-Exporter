#!/usr/bin/env bash
# Builds WA-JS (@wppconnect/wa-js) from a pinned upstream tag under a custom
# global name and vendors it into vendor/wa-js/<version>/.
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

    cat > "$SRC/webpack.wa-exporter.cjs" <<EOF
const base = require('./webpack.config.js');
module.exports = (env, argv) => {
  const config = base(env, argv);
  config.output.library = { name: '$GLOBAL_NAME', type: 'global' };
  return config;
};
EOF
    (cd "$SRC" && npx --no-install webpack --config webpack.wa-exporter.cjs --mode production)

    BUNDLE="$SRC/dist/wppconnect-wa.js"
    [[ -s "$BUNDLE" ]] || { echo "[build-wajs] Build produced no bundle" >&2; exit 1; }
    if ! grep -q "$GLOBAL_NAME" "$BUNDLE"; then
        echo "[build-wajs] Global name not found in bundle" >&2; exit 1
    fi

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
  "supportedWhatsappWeb": "$SUPPORTED",
  "sha256": "$(sha256sum "$OUT/wa-js.bundle.js" | cut -d' ' -f1)",
  "builtWith": "node $(node --version), npm $(npm --version)"
}
EOF
    echo "[build-wajs] Done: $(du -h "$OUT/wa-js.bundle.js" | cut -f1) $(cut -c1-16 <<<"$(sha256sum "$OUT/wa-js.bundle.js")")"
done
