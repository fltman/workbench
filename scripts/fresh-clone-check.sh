#!/bin/bash
# scripts/fresh-clone-check.sh — kontrollen före push (CONTRACT §15): klonar HEAD som en främling skulle, på en
# sökväg över 150 tecken, klonar node_modules (APFS, annars npm ci) och kör npm run check och npm test där.
set -u
repo=$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel) || exit 1
[ -z "$(git -C "$repo" status --porcelain)" ] || echo "fresh-clone-check: bara det som är committat provas"
mkdir -p "$repo/.scratch" && base=$(mktemp -d "$repo/.scratch/fresh-clone.XXXXXX") || exit 1
trap 'rm -rf "$base"' EXIT
dest=$base; while [ ${#dest} -le 150 ]; do dest=$dest/en-lang-sokvag-som-hos-en-framling; done; dest=$dest/workbench
git -c advice.detachedHead=false clone --quiet --revision "$(git -C "$repo" rev-parse HEAD)" "$repo" "$dest" || exit 1
cp -Rc "$repo/node_modules" "$dest/" 2>/dev/null || (cd "$dest" && npm ci --no-audit --no-fund) || exit 1
(cd "$dest" && npm run check && npm test); code=$?
echo "fresh-clone-check: $([ $code -eq 0 ] && echo grönt || echo "FALLERADE (kod $code)") i en klon på ${#dest} tecken"
exit $code
