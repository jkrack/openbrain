#!/bin/bash
set -euo pipefail

# Usage: ./scripts/release.sh <major|minor|patch|x.y.z>
#
# Bumps version in manifest.json, package.json, and versions.json,
# commits, tags, and pushes — which triggers the GitHub Actions release workflow.

if [ $# -ne 1 ]; then
  echo "Usage: $0 <major|minor|patch|x.y.z>"
  exit 1
fi

ARG="$1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Read current version from manifest.json
CURRENT=$(node -p "require('$ROOT/manifest.json').version")
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

# Compute new version
case "$ARG" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
  *.*.*)  IFS='.' read -r MAJOR MINOR PATCH <<< "$ARG" ;;
  *)
    echo "Error: argument must be major, minor, patch, or x.y.z"
    exit 1
    ;;
esac

NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"
echo "Bumping version: ${CURRENT} -> ${NEW_VERSION}"

# Read minAppVersion from manifest.json
MIN_APP=$(node -p "require('$ROOT/manifest.json').minAppVersion")

# Update manifest.json
node -e "
  const fs = require('fs');
  const m = JSON.parse(fs.readFileSync('$ROOT/manifest.json', 'utf8'));
  m.version = '${NEW_VERSION}';
  fs.writeFileSync('$ROOT/manifest.json', JSON.stringify(m, null, 2) + '\n');
"

# Update package.json
node -e "
  const fs = require('fs');
  const p = JSON.parse(fs.readFileSync('$ROOT/package.json', 'utf8'));
  p.version = '${NEW_VERSION}';
  fs.writeFileSync('$ROOT/package.json', JSON.stringify(p, null, 2) + '\n');
"

# Update versions.json — add new version entry
node -e "
  const fs = require('fs');
  const v = JSON.parse(fs.readFileSync('$ROOT/versions.json', 'utf8'));
  v['${NEW_VERSION}'] = '${MIN_APP}';
  fs.writeFileSync('$ROOT/versions.json', JSON.stringify(v, null, 2) + '\n');
"

echo "Updated manifest.json, package.json, versions.json"

# Commit, tag, push
cd "$ROOT"
git add manifest.json package.json versions.json
git commit -m "release: v${NEW_VERSION}"
git tag "v${NEW_VERSION}"
git push && git push --tags

echo ""
echo "Pushed v${NEW_VERSION} — GitHub Actions will build and create the release."
