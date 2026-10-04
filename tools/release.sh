#!/bin/sh
# Stamp a new version on every app file so phones never mix old and new code.
# usage: tools/release.sh 1.4
set -e
v="$1"; [ -n "$v" ] || { echo "usage: $0 VERSION"; exit 1; }
cd "$(dirname "$0")/../docs"
sed -i '' -E "s/\.(js|css)(\?v=[0-9.]+)?\"/.\1?v=$v\"/g" *.js index.html
sed -i '' -E "s/^const VERSION = \"[0-9.]+\";/const VERSION = \"$v\";/" app.js
sed -i '' -E "s/stencil-v[0-9.]+/stencil-v$v/" sw.js
grep -c "?v=$v" *.js index.html | grep -v ':0' || true
