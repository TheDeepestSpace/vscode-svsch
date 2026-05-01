#!/usr/bin/bash

set -euo pipefail

WORKSPACE="$1"

git config --global --add safe.directory "$WORKSPACE"
echo "✅ Added $WORKSPACE to git safe directories"

echo 'hi'

if [[ -z "${CODESPACES:-}" ]] && [[ -z "${GITHUB_ACTIONS:-}" ]]; then
  # Using a glob directly with compgen or checking existence to avoid ls error code 2
  SOCK_PATH=$(find /tmp -maxdepth 1 -name "vscode-ssh-auth-*.sock" 2>/dev/null | head -n1 || true)
  if [[ -n "$SOCK_PATH" ]]; then
    echo "export SSH_AUTH_SOCK=$SOCK_PATH" >> ~/.zshrc
    echo "export SSH_AUTH_SOCK=$SOCK_PATH" >> ~/.bashrc
    export SSH_AUTH_SOCK=$SOCK_PATH
    echo "✅ Mapped SSH_AUTH_SOCK"
  else
    echo "⚠️  VS Code agent socket not found; leaving SSH_AUTH_SOCK unchanged"
  fi
else
  echo "⏩ Skipping SSH_AUTH_SOCK setup for Codespaces or GitHub Actions"
fi
