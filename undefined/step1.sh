set -euo pipefail
TITLE="wgpu-native ${LATEST} is available (pinned: ${PINNED})"

# Idempotence. Without this the workflow files one issue per day for the same release.
existing="$(gh issue list --state open --search "in:title ${LATEST}" \
  --json number,title --jq ".[] | select(.title == \"${TITLE}\") | .number" | head -n1)"
if [ -n "$existing" ]; then
  echo "Issue #${existing} already tracks ${LATEST} — nothing to do."
  exit 0
fi

# The label is convenience, not structure: the search above matches on title, so a missing
# or manually deleted label can never cause a duplicate.
gh label create upstream-update --color 0E8A16 \
  --description "A newer wgpu-native release is available" 2>/dev/null || true

gh issue create \
  --title "$TITLE" \
  --label upstream-update \
  --body "$(cat <<EOF
@0xf6 — upstream cut a release newer than the one this repository pins.

| | |
|---|---|
| pinned | \`${PINNED}\` |
| upstream | \`${LATEST}\` |
| changes | https://github.com/gfx-rs/wgpu-native/compare/${PINNED}...${LATEST} |

Bumping is **not** just editing the tag. A release can move the C ABI, the WGSL front end,
and the set of exported-but-unimplemented symbols that abort when called — so the pin
carries measured artefacts that have to be re-measured together:

- [ ] \`bun run fetch --update-hashes\` — new URLs and sha256 for every platform
- [ ] \`bun run gen:layouts\` — struct layouts are derived from the vendored headers, and the
      oracle compares them against a real C compiler; a bumped pin with stale generated
      layouts is exactly the silent-offset-shift this setup exists to prevent
  - [ ] \`bun test test/layout-oracle.test.ts\`
- [ ] re-derive the abort-on-call symbol list and diff it — a release may add or, better,
      remove one; \`bun test test/abort-symbols.test.ts\`
- [ ] confirm the upstream archive still ships no licence text, and that our vendored copy
      still matches the new tag
- [ ] full suite on every platform the matrix covers

Opened automatically by \`.github/workflows/upstream-watch.yml\`. It will not file a second
issue for \`${LATEST}\` while this one is open; close it to acknowledge, or leave it open as
the tracking issue for the bump.
EOF
)"
