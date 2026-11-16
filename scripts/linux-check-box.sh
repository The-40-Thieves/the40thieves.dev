#!/usr/bin/env bash
# The hub's runnable checks, as they run inside a Linux box. `scripts/linux-check.ts` uploads the
# checkout and the built `dist`, then runs this file from the repository root.
#
# It installs what is missing and nothing else, so it works on a bare Debian box and skips the
# installs on one that already has the toolchain. Every check runs even when an earlier one fails.
# The exit code is 1 if a check failed and 125 if the box could not be made ready to run them.
set -uo pipefail
export CI=1

fail() {
  echo "linux-check: $*" >&2
  exit 125
}

# --- toolchain: the Node major from .nvmrc, the pnpm from packageManager ----------------------
want_node="$(tr -d 'v[:space:]' < .nvmrc)"
want_node="${want_node%%.*}"
want_pnpm="$(sed -n 's/.*"packageManager": *"pnpm@\([^"+]*\).*/\1/p' package.json)"
if [ -z "$want_node" ] || [ -z "$want_pnpm" ]; then
  fail "could not read the Node or pnpm version from .nvmrc and package.json"
fi

export PATH="$HOME/.local/node/bin:$PATH"
have_node="$(node --version 2> /dev/null | sed 's/^v//')"
if [ "${have_node%%.*}" != "$want_node" ]; then
  echo "installing Node $want_node (found ${have_node:-none})"
  base="https://nodejs.org/dist/latest-v${want_node}.x"
  work="$(mktemp -d)"
  (
    cd "$work" &&
      curl -fsSL "$base/SHASUMS256.txt" -o SHASUMS256.txt &&
      file="$(grep -oE 'node-v[0-9.]+-linux-x64\.tar\.xz' SHASUMS256.txt | head -1)" &&
      curl -fsSL "$base/$file" -o "$file" &&
      grep " $file\$" SHASUMS256.txt | sha256sum -c --quiet - &&
      rm -rf "$HOME/.local/node" &&
      mkdir -p "$HOME/.local/node" &&
      tar -xJf "$file" -C "$HOME/.local/node" --strip-components=1
  ) || fail "installing Node $want_node failed"
  rm -rf "$work"
fi
if [ "$(pnpm --version 2> /dev/null)" != "$want_pnpm" ]; then
  echo "installing pnpm $want_pnpm"
  npm install --global --silent "pnpm@$want_pnpm" || fail "installing pnpm $want_pnpm failed"
fi
echo "node $(node --version), pnpm $(pnpm --version), $(uname -sr)"

# --- steps: one line when a step passes, its last lines when it fails -------------------------
failed=()
step() {
  local name="$1"
  shift
  local log started code
  log="$(mktemp)"
  started=$SECONDS
  if "$@" > "$log" 2>&1; then
    echo "ok    $name ($((SECONDS - started)) s)"
  else
    code=$?
    echo "FAIL  $name ($((SECONDS - started)) s, exit $code)"
    tail -n 40 "$log" | cut -c1-300
    failed+=("$name")
  fi
  rm -f "$log"
}

step "install dependencies" pnpm install --frozen-lockfile
if [ ${#failed[@]} -gt 0 ]; then
  fail "the dependencies did not install; nothing else was run"
fi

# The build leaves a redirect file that tells `wrangler dev` to serve `dist`. It is not uploaded
# (`.wrangler` is ignored), and one written on Windows holds backslash paths, so it is written here.
mkdir -p apps/hub/.wrangler/deploy
printf '%s\n' '{"configPath":"../../dist/server/wrangler.json","auxiliaryWorkers":[]}' \
  > apps/hub/.wrangler/deploy/config.json

step "root tests" pnpm test
step "hub tests" pnpm --filter hub test
step "chromium for playwright" pnpm --filter hub exec playwright install --with-deps chromium
step "conformance suite" pnpm conformance --local --browser --report conformance-report
step "e2e specs" pnpm --filter hub e2e

if [ ${#failed[@]} -gt 0 ]; then
  echo
  echo "linux-check: FAILED on $(uname -sr):"
  printf '  %s\n' "${failed[@]}"
  exit 1
fi
echo "linux-check: all passed on $(. /etc/os-release && echo "$PRETTY_NAME")"
