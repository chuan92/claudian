#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

if (( $# > 1 )); then
  echo 'Usage: bash deploy.sh [vault-path]' >&2
  exit 1
fi

vault="${1:-${OBSIDIAN_VAULT:-}}"
if [[ -z "$vault" && -f .env.local ]]; then
  vault="$(node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
const line = readFileSync('.env.local', 'utf8').split('\n')
  .find(line => line.startsWith('OBSIDIAN_VAULT='));
const value = line?.slice('OBSIDIAN_VAULT='.length).trim() ?? '';
const quoted = (value.startsWith('"') && value.endsWith('"'))
  || (value.startsWith("'") && value.endsWith("'"));
process.stdout.write(quoted ? value.slice(1, -1) : value);
NODE
  )"
fi

if [[ -z "$vault" || ! -d "$vault/.obsidian" ]]; then
  echo 'Set OBSIDIAN_VAULT in .env.local or pass an existing Obsidian vault path.' >&2
  exit 1
fi

export OBSIDIAN_VAULT="$(cd -- "$vault" && pwd)"
# The existing esbuild hook copies artifacts only after a successful build.
npm run build

destination="$OBSIDIAN_VAULT/.obsidian/plugins/claudian"
for file in main.js styles.css manifest.json; do
  if ! cmp -s "$file" "$destination/$file"; then
    echo "Deployment verification failed: $destination/$file" >&2
    exit 1
  fi
done

printf 'Deployed and verified Claudian in %s\n' "$destination"
