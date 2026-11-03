#!/bin/bash
# Rewrites app/src/test/resources/core-app-files.sha256, the list that
# CoreAppUnchangedTest uses to prove the regular ViktorychTV app is untouched
# by the launcher and other takeover features. Run it only after an intended
# change to the regular app (not from a launcher/defaults PR).
set -euo pipefail
cd "$(dirname "$0")/../app"
out=src/test/resources/core-app-files.sha256
{
  echo "# Files of the regular ViktorychTV app. The TV takeover features must not change"
  echo "# them (owner: the current way stays exactly as before). Update only on purpose,"
  echo "# with android-tv/tools/core-hashes.sh."
  git ls-files src/main | grep -v -e AndroidManifest.xml -e /launcher/ -e /player/ -e strings_launcher.xml -e /ime/ -e /search/ -e /files/ -e strings_media.xml -e strings_ime.xml -e strings_files.xml -e '/lx_[^/]*$' -e '/mp_[^/]*$' -e '/kb_[^/]*$' -e '/fl_[^/]*$' | sort | xargs sha256sum
} > "$out"
echo "wrote $out ($(grep -vc '^#' "$out") files)"
