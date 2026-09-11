#!/bin/sh
# shared/ holds the one true copy of the renderers. Both apps ship their own
# copy (the extension must be self-contained to zip, and the web app is served
# as plain files), so they are copied rather than imported.
# tools/e2e-mobile.js and tools/e2e-extension.js fail if a copy drifts.
set -e
cd "$(dirname "$0")/.."
for file in swipe.js markdown.js markdown.css structured.js structured.css book.js book.css records.js records.css; do
  cp "shared/$file" "lib/$file"
  cp "shared/$file" "extension/src/lib/$file"
done
echo "synced shared/{swipe,markdown,structured,book,records}.{js,css} into lib/ and extension/src/lib/"
