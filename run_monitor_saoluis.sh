#!/usr/bin/env bash
set -euo pipefail

cd /root/.openclaw/workspace/projects/monitor-proposicoes-saoluis

export USE_GMAIL_API=1
export CONTROLE03_STATE_URL="${CONTROLE03_STATE_URL:-http://127.0.0.1:5017/controle03/api/state}"
export EMAIL_DESTINO="${EMAIL_DESTINO:-tramitacao@monitorlegislativo.com.br}"

node monitor.js

git config user.name "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"
git add estado.json
git diff --cached --quiet || git commit -m "Atualiza estado"
git push
