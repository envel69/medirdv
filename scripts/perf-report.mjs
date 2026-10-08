// Transforme le résumé k6 (--summary-export) en rapport Markdown.
// Usage : node scripts/perf-report.mjs k6/summary.json [rapport.md]
// Écrit aussi la liste des seuils dépassés dans k6/seuils-depasses.txt (vide si tout passe).
import { readFileSync, writeFileSync } from "node:fs";

const [fichier = "k6/summary.json", sortie] = process.argv.slice(2);
const { metrics } = JSON.parse(readFileSync(fichier, "utf8"));

const ms = (v) => (v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v.toFixed(v < 10 ? 1 : 0)} ms`);
const pct = (v) => `${(v * 100).toFixed(2)} %`;

// Valeur mesurée correspondant à l'expression d'un seuil, ex. "p(95)<500" -> metrics[...]["p(95)"]
function mesure(m, expr) {
  const stat = expr.match(/^\s*([a-z]+(?:\(\d+(?:\.\d+)?\))?)/i)?.[1];
  if (stat === "rate") return { v: m.value ?? m.rate, fmt: pct };
  if (stat === "count") return { v: m.count, fmt: String };
  if (stat in m) return { v: m[stat], fmt: ms };
  return { v: m.value, fmt: String };
}
// "http_req_duration{name:GET /stats}" -> "GET /stats (http_req_duration)"
function libelle(nom) {
  const m = nom.match(/^([^{]+)\{(.+)\}$/);
  if (!m) return `\`${nom}\``;
  const tag = m[2].replace(/^(name|scenario):/, "");
  return `**${tag}** · \`${m[1]}\``;
}

const lignes = [];
const depasses = [];
for (const [nom, m] of Object.entries(metrics)) {
  for (const [expr, echec] of Object.entries(m.thresholds ?? {})) {
    // Dans le format --summary-export, `true` signifie que le seuil a été franchi
    const { v, fmt } = mesure(m, expr);
    lignes.push({ nom, expr, valeur: v === undefined ? "—" : fmt(v), echec });
    if (echec) depasses.push(`${nom.match(/\{(?:name|scenario):(.+)\}/)?.[1] ?? nom} (${expr})`);
  }
}
lignes.sort((a, b) => Number(b.echec) - Number(a.echec));

const d = metrics.http_req_duration ?? {};
const reqs = metrics.http_reqs ?? {};
const fails = metrics.http_req_failed ?? {};
const ok = depasses.length === 0;

const md = [
  `## ${ok ? "✅ Performances conformes" : "🐢 Lenteur détectée"}`,
  "",
  ok ? "Tous les seuils de performance sont respectés." : `**${depasses.length} seuil(s) dépassé(s)** : ${depasses.join(", ")}`,
  "",
  "| Indicateur | Seuil | Mesuré | Statut |",
  "|---|---|---|---|",
  ...lignes.map((l) => `| ${libelle(l.nom)} | \`${l.expr}\` | ${l.valeur} | ${l.echec ? "❌ dépassé" : "✅"} |`),
  "",
  "### Vue d'ensemble",
  "",
  "| Requêtes | Débit | Erreurs | Médiane | p90 | p95 | Max |",
  "|---|---|---|---|---|---|---|",
  `| ${reqs.count ?? "—"} | ${reqs.rate ? reqs.rate.toFixed(1) + " req/s" : "—"} | ${fails.value !== undefined ? pct(fails.value) : "—"} | ${d.med !== undefined ? ms(d.med) : "—"} | ${d["p(90)"] !== undefined ? ms(d["p(90)"]) : "—"} | ${d["p(95)"] !== undefined ? ms(d["p(95)"]) : "—"} | ${d.max !== undefined ? ms(d.max) : "—"} |`,
  "",
].join("\n");

if (sortie) writeFileSync(sortie, md);
writeFileSync("k6/seuils-depasses.txt", depasses.join("\n"));
process.stdout.write(md);
