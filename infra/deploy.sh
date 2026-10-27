#!/usr/bin/env bash
# Builds both images in ACR (no local Docker needed) and applies the Terraform.
# Usage: [AUTO_APPROVE=1] [SKIP_BUILD=1 TAG=<tag>] infra/deploy.sh   (requires: az login, terraform; reads agent/.env.local)
set -euo pipefail
cd "$(dirname "$0")"

# LiveKit credentials come from the same file the local agent uses.
set -a
# shellcheck disable=SC1091
source ../agent/.env.local
set +a
export TF_VAR_livekit_url="$LIVEKIT_URL"
export TF_VAR_livekit_api_key="$LIVEKIT_API_KEY"
export TF_VAR_livekit_api_secret="$LIVEKIT_API_SECRET"

TAG="${TAG:-$(date +%Y%m%d-%H%M%S)}"
az provider register --namespace Microsoft.App --wait
terraform init -input=false

# First run: the registry has to exist before images can be built into it.
if ! terraform state show azurerm_container_registry.this >/dev/null 2>&1; then
  terraform apply ${AUTO_APPROVE:+-auto-approve} -target=azurerm_container_registry.this -var "image_tag=$TAG"
fi
ACR="$(terraform output -raw acr_name)"

# Builds run in ACR. Logs aren't streamed: az on Windows crashes printing characters like "✓"
# in cp1252, so poll the run instead (logs: portal > registry > Tasks > Runs).
acr_build() {
  local image="$1" context="$2" run status
  run="$(az acr build --registry "$ACR" --image "$image" --no-logs --no-wait "$context" 2>&1 | sed -n "s/.*Queued a build with ID: //p")"
  [ -n "$run" ] || { echo "failed to queue build for $image" >&2; return 1; }
  echo "building $image (ACR run $run)"
  while :; do
    status="$(az acr task show-run --registry "$ACR" --run-id "$run" --query status -o tsv)"
    case "$status" in
      Succeeded) echo "  $image built"; return 0 ;;
      Failed | Canceled | Error | Timeout)
        echo "  $image: $status. Logs: az acr task logs --registry $ACR --run-id $run" >&2
        return 1 ;;
    esac
    sleep 10
  done
}
if [ -z "${SKIP_BUILD:-}" ]; then # SKIP_BUILD=1 TAG=<existing> reuses images already in ACR
  acr_build "avatar-agent:$TAG" ../agent
  acr_build "avatar-web:$TAG" ../web
fi

terraform apply ${AUTO_APPROVE:+-auto-approve} -var "image_tag=$TAG"
echo
echo "Share this link: $(terraform output -raw share_url)"
