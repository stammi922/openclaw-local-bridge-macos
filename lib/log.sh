# shellcheck shell=bash
# Colored, TTY-aware log helpers.
# Source from install.sh / uninstall.sh / verify.sh:
#   . "$(dirname "$0")/lib/log.sh"

if [[ -t 1 ]] && [[ "${NO_COLOR:-}" == "" ]]; then
  _C_RESET=$'\033[0m'
  _C_BOLD=$'\033[1m'
  _C_CYAN=$'\033[36m'
  _C_GREEN=$'\033[32m'
  _C_YELLOW=$'\033[33m'
  _C_RED=$'\033[31m'
  _C_DIM=$'\033[2m'
else
  _C_RESET=""
  _C_BOLD=""
  _C_CYAN=""
  _C_GREEN=""
  _C_YELLOW=""
  _C_RED=""
  _C_DIM=""
fi

info() { printf '%s[INFO]%s %s\n' "$_C_CYAN" "$_C_RESET" "$*"; }
ok()   { printf '%s[ OK ]%s %s\n' "$_C_GREEN" "$_C_RESET" "$*"; }
warn() { printf '%s[WARN]%s %s\n' "$_C_YELLOW" "$_C_RESET" "$*" >&2; }
err()  { printf '%s[ERR ]%s %s\n' "$_C_RED" "$_C_RESET" "$*" >&2; }
die()  { err "$*"; exit 1; }

# step <n> <total> <msg>
step() {
  printf '\n%s➜ [%s/%s]%s %s%s%s\n' \
    "$_C_BOLD" "$1" "$2" "$_C_RESET" \
    "$_C_BOLD" "$3" "$_C_RESET"
}

dim() { printf '%s%s%s\n' "$_C_DIM" "$*" "$_C_RESET"; }
