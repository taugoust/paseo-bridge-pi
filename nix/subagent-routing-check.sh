# Runs the subagent routing and account controls relay tests.
# Usage: subagent-routing-check.sh SOURCE_TREE
set -euo pipefail
export HOME="$TMPDIR/home"
mkdir -p "$HOME"

# The tests write next to their sources, so work on a copy.
cp -r "$1" source
chmod -R u+w source
cd source

tests=(
  test/subagent-routing.test.ts
  test/subagent-routing-transport.integration.test.ts
  test/account-controls-context.test.mjs
  test/account-controls-operator.test.ts
  test/account-controls-transport.integration.test.ts
  plugin/test/account-controls-transport.test.ts
)
node --experimental-strip-types --test --test-timeout=30000 "${tests[@]}"
