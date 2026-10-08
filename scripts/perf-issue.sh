#!/usr/bin/env bash
# Ouvre (ou met à jour) une issue GitHub quand une lenteur est détectée, et la ferme quand c'est rétabli.
# Usage : scripts/perf-issue.sh ouvrir|fermer   (nécessite GH_TOKEN et GH_REPO, fournis par le workflow)
set -euo pipefail

ACTION="${1:?ouvrir ou fermer}"
LABEL="lenteur"
RUN_URL="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"
COMMIT="${GITHUB_SHA:0:7}"

gh label create "$LABEL" --color D93F0B --description "Seuil de performance k6 dépassé" --force >/dev/null

# Une seule issue ouverte à la fois : on la commente au lieu d'en créer une nouvelle à chaque exécution
EXISTANTE=$(gh issue list --label "$LABEL" --state open --limit 1 --json number --jq '.[0].number // empty')

if [ "$ACTION" = "ouvrir" ]; then
  {
    echo "La campagne de tests de performance a détecté une lenteur."
    echo
    echo "- **Déclencheur** : \`${GITHUB_EVENT_NAME}\` sur \`${GITHUB_REF_NAME}\` (commit \`${COMMIT}\`)"
    echo "- **Exécution** : ${RUN_URL} (le rapport k6 HTML est dans les artefacts)"
    [ "${LATENCE_SIMULEE_MS:-0}" != "0" ] && echo "- ⚠️ **Latence simulée de ${LATENCE_SIMULEE_MS} ms** (test volontaire de l'alerte)"
    echo
    cat perf-report.md
  } > issue-body.md

  if [ -n "$EXISTANTE" ]; then
    gh issue comment "$EXISTANTE" --body-file issue-body.md
    echo "Issue #$EXISTANTE mise à jour"
  else
    SEUILS=$(head -n 3 k6/seuils-depasses.txt | paste -sd ', ' -)
    gh issue create --title "🐢 Lenteur détectée : ${SEUILS}" --label "$LABEL" --body-file issue-body.md
  fi
elif [ "$ACTION" = "fermer" ]; then
  if [ -n "$EXISTANTE" ]; then
    gh issue close "$EXISTANTE" --comment "✅ Les seuils de performance sont de nouveau respectés (commit \`${COMMIT}\`, ${RUN_URL}). Fermeture automatique."
    echo "Issue #$EXISTANTE fermée"
  else
    echo "Aucune issue de lenteur ouverte"
  fi
fi
