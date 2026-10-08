// Baromètre W/L du pipeline CI/CD, exécuté à la fin du workflow.
// - Ajoute le résultat de l'exécution en cours (pas encore « terminée » côté API GitHub)
// - Écrit barometre.json au format « endpoint » de shields.io (badge du README)
// - Affiche un résumé Markdown (pour $GITHUB_STEP_SUMMARY)
import { writeFileSync } from "node:fs";
import { calculerBarometre, chargerExecutions } from "../lib/github.js";

const { GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_NUMBER, GITHUB_SHA, GITHUB_EVENT_NAME, RESULTAT_COURANT, GITHUB_SERVER_URL = "https://github.com" } = process.env;

const runs = (await chargerExecutions({ token: GH_TOKEN, repo: GITHUB_REPOSITORY, n: 50 }))
  .filter((r) => String(r.id) !== GITHUB_RUN_ID);
const maintenant = new Date().toISOString();
runs.unshift({
  id: Number(GITHUB_RUN_ID), run_number: Number(GITHUB_RUN_NUMBER), conclusion: RESULTAT_COURANT, event: GITHUB_EVENT_NAME,
  head_sha: GITHUB_SHA, display_title: "exécution en cours", html_url: `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`,
  run_started_at: maintenant, updated_at: maintenant,
});

const b = calculerBarometre(runs);
const taux = b.taux_reussite == null ? null : Math.round(b.taux_reussite * 100);
const couleur = taux == null ? "lightgrey" : taux >= 90 ? "brightgreen" : taux >= 75 ? "green" : taux >= 50 ? "yellow" : "red";

writeFileSync("barometre.json", JSON.stringify({
  schemaVersion: 1,
  label: "CI/CD W/L",
  message: `${b.victoires}W ${b.defaites}L${taux == null ? "" : ` · ${taux}%`}`,
  color: couleur,
}, null, 2));
writeFileSync("barometre-complet.json", JSON.stringify({ genere_le: maintenant, repo: GITHUB_REPOSITORY, ...b }, null, 2));

const pastilles = b.historique.slice(0, 30).reverse().map((h) => (h.resultat === "W" ? "🟩" : h.resultat === "L" ? "🟥" : "⬜")).join("");
const serie = b.serie ? `${b.serie.longueur} ${b.serie.type === "W" ? "réussite(s)" : "échec(s)"} d'affilée` : "—";
process.stdout.write([
  "## 📊 Baromètre CI/CD W/L",
  "",
  "| W (réussites) | L (échecs) | Taux de réussite | Série en cours | Durée moyenne |",
  "|---|---|---|---|---|",
  `| **${b.victoires}** | **${b.defaites}** | ${taux == null ? "—" : taux + " %"} | ${serie} | ${b.duree_moyenne_s == null ? "—" : Math.round(b.duree_moyenne_s / 60 * 10) / 10 + " min"} |`,
  "",
  `${Math.min(30, b.historique.length)} dernières exécutions sur \`main\` (de la plus ancienne à la plus récente) : ${pastilles}`,
  "",
  "🟩 réussite · 🟥 échec · ⬜ annulée / ignorée",
  "",
].join("\n"));
