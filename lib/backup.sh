# shellcheck shell=bash
# Unified timestamped backup directory + manifest writer.
# All JSON ops via node (no jq dependency).

# init_backup_dir — exports BRIDGE_BACKUP_DIR; idempotent within a single run.
init_backup_dir() {
  if [[ -n "${BRIDGE_BACKUP_DIR:-}" ]] && [[ -d "$BRIDGE_BACKUP_DIR" ]]; then
    return 0
  fi
  BRIDGE_BACKUP_DIR="$HOME/.openclaw/bridge-backups/$(date -u +%Y%m%dT%H%M%SZ)"
  export BRIDGE_BACKUP_DIR
  mkdir -p "$BRIDGE_BACKUP_DIR"
  printf '{}\n' > "$BRIDGE_BACKUP_DIR/manifest.json"
}

# backup_file <src> [<label>]
# Copies src to BRIDGE_BACKUP_DIR/<basename or label>; appends manifest entry.
# Silently skips if src does not exist.
backup_file() {
  local src="$1"
  local label="${2:-$(basename "$src")}"
  [[ -e "$src" ]] || return 0
  init_backup_dir
  local dst="$BRIDGE_BACKUP_DIR/$label"
  cp -a "$src" "$dst"
  node -e '
    const fs = require("fs");
    const manifestPath = process.argv[1];
    const src = process.argv[2];
    const dst = process.argv[3];
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    m[src] = dst;
    fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");
  ' "$BRIDGE_BACKUP_DIR/manifest.json" "$src" "$dst"
  dim "  backed up $src → $dst"
}
