#!/usr/bin/env bash
# Applies the GitHub repo settings the automation depends on. Idempotent.
# Usage: scripts/setup-github-repo.sh [--dry-run] [OWNER/REPO]
set -euo pipefail

DRY_RUN=0
REPO="Raboo/vscode-ai-autocomplete"
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) REPO="$arg" ;;
  esac
done

run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '+'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

run gh repo edit "$REPO" \
  --enable-auto-merge --delete-branch-on-merge \
  --enable-squash-merge --enable-merge-commit --enable-rebase-merge=false \
  --add-topic vscode-extension,autocomplete,fim,llama-cpp,codestral

# Lets release-please open PRs with the default token.
run gh api -X PUT "repos/$REPO/actions/permissions/workflow" \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true

run gh api -X PUT "repos/$REPO/vulnerability-alerts"
run gh api -X PUT "repos/$REPO/automated-security-fixes"

# actor_id 5 = repository admin, so the owner can still push and merge release PRs.
read -r -d '' RULESET <<'JSON' || true
{"name":"main","target":"branch","enforcement":"active","conditions":{"ref_name":{"include":["~DEFAULT_BRANCH"],"exclude":[]}},"rules":[{"type":"deletion"},{"type":"non_fast_forward"},{"type":"pull_request","parameters":{"required_approving_review_count":0,"dismiss_stale_reviews_on_push":false,"require_code_owner_review":false,"require_last_push_approval":false,"required_review_thread_resolution":false,"allowed_merge_methods":["merge","squash"]}},{"type":"required_status_checks","parameters":{"strict_required_status_checks_policy":false,"required_status_checks":[{"context":"check"},{"context":"integration"}]}}],"bypass_actors":[{"actor_id":5,"actor_type":"RepositoryRole","bypass_mode":"always"}]}
JSON

if [ "$DRY_RUN" = 1 ]; then
  echo "+ ruleset 'main' on repos/$REPO/rulesets (would create or update):"
  if command -v jq >/dev/null 2>&1; then
    printf '%s\n' "$RULESET" | jq --indent 2 .
  else
    printf '%s\n' "$RULESET" | node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("fs").readFileSync(0,"utf8")),null,2)+"\n")'
  fi
else
  ID="$(gh api "repos/$REPO/rulesets" --jq '.[] | select(.name=="main") | .id')"
  if [ -n "$ID" ]; then
    printf '%s' "$RULESET" | gh api -X PUT "repos/$REPO/rulesets/$ID" --input -
  else
    printf '%s' "$RULESET" | gh api -X POST "repos/$REPO/rulesets" --input -
  fi
fi
