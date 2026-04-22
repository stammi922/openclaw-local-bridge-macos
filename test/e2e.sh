#!/usr/bin/env bash
# End-to-end test against the user's real gateway + proxy.
# Gated behind E2E=1.
set -euo pipefail

if [[ "${E2E:-}" != "1" ]]; then
  echo "E2E tests require E2E=1. Skipping."
  exit 0
fi

echo "E2E test body is filled in by Task 21."
exit 1
