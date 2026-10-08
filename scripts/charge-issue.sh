#!/usr/bin/env bash
# Ouvre (ou commente) l'issue « charge » quand l'API a signalé une charge trop haute.
# Les mesures arrivent dans DETAILS_CHARGE (JSON envoyé par l'API via workflow_dispatch).
set -euo pipefail

LABEL="charge"
RUN_URL="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"
DETAILS="${DETAILS_CHARGE:-}"
[ -z "$DETAILS" ] && DETAILS='{}'

champ() { echo "$DETAILS" | jq -r "$1 // \"—\"" 2>/dev/null || echo "—"; }

gh label create "$LABEL" --color FBCA04 --description "Charge trop haute détectée sur l'API" --force >/dev/null

{
  echo "L'API a détecté une **charge trop haute** et a lancé automatiquement le pipeline (tests + tests de lenteur)."
  echo
  echo "| Mesure | Valeur |"
  echo "|---|---|"
  echo "| Date | $(champ '.date') |"
  echo "| Serveur | $(champ '.hote') |"
  echo "| Débit | $(champ '.rps') req/s |"
  echo "| Latence p95 | $(champ '.p95_ms') ms |"
  echo "| Requêtes sur la fenêtre | $(champ '.requetes') (sur $(champ '.fenetre_s') s) |"
  echo "| Raison(s) | $(echo "$DETAILS" | jq -r '(.raisons // []) | join(", ")' 2>/dev/null || echo "—") |"
  echo
  echo "➡️ Résultat des tests de lenteur : ${RUN_URL}"
} > charge-body.md

EXISTANTE=$(gh issue list --label "$LABEL" --state open --limit 1 --json number --jq '.[0].number // empty')
if [ -n "$EXISTANTE" ]; then
  gh issue comment "$EXISTANTE" --body-file charge-body.md
  echo "Issue #$EXISTANTE mise à jour"
else
  gh issue create --title "📈 Charge trop haute sur l'API ($(champ '.raisons[0]'))" --label "$LABEL" --body-file charge-body.md
fi
cat charge-body.md >> "$GITHUB_STEP_SUMMARY"
