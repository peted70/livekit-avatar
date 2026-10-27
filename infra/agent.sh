#!/usr/bin/env bash
# Stop the always-on agent between test sessions (it's the only real cost), and start it again.
# Usage: infra/agent.sh start|stop|status
set -euo pipefail
cd "$(dirname "$0")"

RG="$(terraform output -raw resource_group)"
APP="$(terraform output -raw agent_app)"
REVISION="$(az containerapp show -n "$APP" -g "$RG" --query properties.latestRevisionName -o tsv)"

case "${1:-status}" in
  start) az containerapp revision activate -n "$APP" -g "$RG" --revision "$REVISION" -o none && echo "agent starting ($REVISION)" ;;
  stop) az containerapp revision deactivate -n "$APP" -g "$RG" --revision "$REVISION" -o none && echo "agent stopped" ;;
  status) az containerapp revision show -n "$APP" -g "$RG" --revision "$REVISION" \
    --query "{revision:name, active:properties.active, replicas:properties.replicas}" -o table ;;
  *) echo "usage: $0 start|stop|status" >&2; exit 1 ;;
esac
