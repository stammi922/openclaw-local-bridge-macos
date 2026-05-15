#!/usr/bin/env bash
# Extracts apply_concurrency_cap / apply_session_serialize / apply_stream_safety
# shell functions out of install.sh and prints them on stdout. The patch sections
# in install.sh use a wrapper convention: each starts with
#   # >>> patch:<name>
# and ends with
#   # <<< patch:<name>
# and contains a `apply_<name>() { ... }` function.

set -euo pipefail

src="${1:?usage: _extract-patches.sh <install.sh>}"

awk '
    /^# >>> patch:/ { in_patch=1; next }
    /^# <<< patch:/ { in_patch=0; next }
    in_patch
' "$src"
