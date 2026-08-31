#!/bin/sh
# shared/ holds the one true copy of the Markdown renderer. Both apps ship
# their own copy of it (the extension must be self-contained to zip, and the
# web app is served as plain files), so it is copied rather than imported.
# tools/e2e-mobile.js and tools/e2e-extension.js fail if a copy drifts.
set -e
cd "$(dirname "$0")/.."
cp shared/markdown.js lib/markdown.js
cp shared/markdown.css lib/markdown.css
cp shared/markdown.js extension/src/lib/markdown.js
cp shared/markdown.css extension/src/lib/markdown.css
echo "synced shared/markdown.{js,css} into lib/ and extension/src/lib/"
