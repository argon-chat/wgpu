set -o pipefail
result="$(bun run scripts/check-upstream.ts --json)" || true
echo "$result"

ok="$(echo "$result" | jq -r '.ok // false')"
if [ "$ok" != "true" ]; then
  echo "::error::upstream check could not determine the state: $(echo "$result" | jq -r '.error // "no output"')"
  echo "A watcher that cannot tell 'nothing new' from 'I am broken' is worse than none."
  exit 1
fi

{
  echo "behind=$(echo "$result" | jq -r '.behind')"
  echo "pinned=$(echo "$result" | jq -r '.pinned')"
  echo "latest=$(echo "$result" | jq -r '.latest')"
} >> "$GITHUB_OUTPUT"
