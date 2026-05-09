#!/usr/bin/env bash

set -euo pipefail

# Forward all args (for example: --name "regex") to cucumber-js.
test_command="cucumber-js"
for arg in "$@"; do
  printf -v escaped_arg '%q' "$arg"
  test_command+=" ${escaped_arg}"
done

npx start-server-and-test "npm run visual:serve -- --force" http://127.0.0.1:5176 "$test_command"
