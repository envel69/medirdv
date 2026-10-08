// Test de rupture : la charge augmente jusqu'à ce que l'API « casse », puis le test s'arrête.
// Usage : k6 run k6/stress-test.js   (options : BASE_URL, DEBIT_MAX, DUREE)
import http from "k6/http";
import { check } from "k6";
import { Trend } from "k6/metrics";

const BASE = __ENV.BASE_URL || "http://localhost:3001";
const DEBIT_MAX = Number(__ENV.DEBIT_MAX || 400); // requêtes/s visées en fin de rampe
const DUREE_S = Number(__ENV.DUREE || 240);
const JSON_HEADERS = { "Content-Type": "application/json" };
const latence = new Trend("latence_par_palier", true);

export const options = {
  scenarios: {
    rupture: {
      executor: "ramping-arrival-rate",
      startRate: 10,
      timeUnit: "1s",
      preAllocatedVUs: 50,
      maxVUs: 600,
      stages: [{ duration: `${DUREE_S}s`, target: DEBIT_MAX }],
    },
  },
  thresholds: {
    // Critères de rupture : le test s'arrête dès que l'un d'eux est franchi
    http_req_failed: [{ threshold: "rate<0.05", abortOnFail: true, delayAbortEval: "10s" }],
    http_req_duration: [{ threshold: "p(95)<1500", abortOnFail: true, delayAbortEval: "10s" }],
  },
  summaryTrendStats: ["med", "p(90)", "p(95)", "max", "count"],
};
// k6 ne garde dans le résumé que les sous-métriques qui ont un seuil : un seuil neutre par palier de 50 req/s
for (let p = 0; p < DEBIT_MAX + 50; p += 50) options.thresholds[`latence_par_palier{palier:${p}-${p + 50}}`] = ["max>=0"];

const rand = (a) => a[Math.floor(Math.random() * a.length)];

export function setup() {
  const praticiens = http.get(`${BASE}/praticiens?limit=200`).json("data");
  const patients = http.get(`${BASE}/patients?limit=200&page=7`).json("data").map((p) => p._id);
  return { praticiens: praticiens.map((p) => ({ _id: p._id, specialite: p.specialite })), patients, debut: Date.now() };
}

// Débit visé à l'instant t (rampe linéaire)
const debitVise = (debut) => Math.round(10 + ((Date.now() - debut) / 1000 / DUREE_S) * (DEBIT_MAX - 10));

export default function (data) {
  const palier = Math.floor(debitVise(data.debut) / 50) * 50;
  const tags = { palier: `${palier}-${palier + 50}` };
  const r = Math.random();
  let res;
  if (r < 0.5) {
    res = http.get(`${BASE}/praticiens?specialite=${encodeURIComponent(rand(data.praticiens).specialite)}`, { tags: { ...tags, name: "recherche" } });
  } else if (r < 0.95) {
    res = http.get(`${BASE}/praticiens/${rand(data.praticiens)._id}/disponibilites?jours=5`, { tags: { ...tags, name: "disponibilites" } });
  } else {
    // Réservation puis suppression immédiate (aucune donnée laissée)
    const p = rand(data.praticiens);
    const dispo = http.get(`${BASE}/praticiens/${p._id}/disponibilites?jours=14`, { tags: { ...tags, name: "disponibilites" } });
    const creneaux = dispo.status === 200 ? dispo.json("jours").flatMap((j) => j.creneaux) : [];
    if (!creneaux.length) return;
    res = http.post(`${BASE}/rendez-vous`, JSON.stringify({ praticien_id: p._id, patient_id: rand(data.patients), debut: rand(creneaux) }),
      { headers: JSON_HEADERS, tags: { ...tags, name: "reservation" }, responseCallback: http.expectedStatuses(201, 409) });
    if (res.status === 201) http.del(`${BASE}/rendez-vous/${res.json("_id")}`, null, { tags: { ...tags, name: "suppression" } });
  }
  latence.add(res.timings.duration, tags);
  check(res, { "réponse valide": (x) => x.status === 200 || x.status === 201 || x.status === 409 });
}

// Nettoyage : quand k6 coupe le test, des réservations peuvent être créées sans avoir été supprimées
export function teardown(data) {
  let supprimes = 0;
  for (const patient of data.patients) {
    const res = http.get(`${BASE}/rendez-vous?patient_id=${patient}&statut=confirme&limit=200`, { tags: { name: "nettoyage" } });
    for (const rdv of res.json("data") || []) {
      if (new Date(rdv.cree_le).getTime() >= data.debut) { http.del(`${BASE}/rendez-vous/${rdv._id}`, null, { tags: { name: "nettoyage" } }); supprimes++; }
    }
  }
  console.log(`Nettoyage : ${supprimes} réservation(s) de test supprimée(s)`);
}

export function handleSummary(data) {
  const duree = data.state.testRunDurationMs / 1000;
  const casse = duree < DUREE_S - 1;
  const debitAtteint = Math.round(10 + (Math.min(duree, DUREE_S) / DUREE_S) * (DEBIT_MAX - 10));
  const m = data.metrics;
  const ms = (v) => (v == null ? "—" : `${Math.round(v)} ms`);
  const paliers = Object.keys(m).filter((k) => k.startsWith("latence_par_palier{") && m[k].values.count).map((k) => ({
    palier: k.match(/palier:([^}]+)/)[1] + " req/s", p95: m[k].values["p(95)"], med: m[k].values.med, n: m[k].values.count,
  })).sort((a, b) => parseInt(a.palier) - parseInt(b.palier));

  const lignes = [
    "",
    "════════════ RÉSULTAT DU TEST DE RUPTURE ════════════",
    casse
      ? `💥 Rupture vers ${debitAtteint} req/s visées, après ${Math.round(duree)} s`
      : `✅ Pas de rupture jusqu'à ${DEBIT_MAX} req/s visées (relancer avec DEBIT_MAX plus haut)`,
    `Débit réellement servi : ${m.http_reqs.values.rate.toFixed(1)} req/s en moyenne (${m.http_reqs.values.count} requêtes)`,
    `Erreurs : ${(m.http_req_failed.values.rate * 100).toFixed(2)} %  ·  p95 global : ${ms(m.http_req_duration.values["p(95)"])}`,
    `Itérations abandonnées (k6 saturé, plus de VU libres) : ${m.dropped_iterations ? m.dropped_iterations.values.count : 0}`,
    "",
    "Latence par palier de charge :",
    "  palier             requêtes   médiane     p95",
    ...paliers.map((p) => `  ${p.palier.padEnd(18)} ${String(p.n).padStart(8)}  ${ms(p.med).padStart(8)}  ${ms(p.p95).padStart(8)}${p.p95 > 1500 ? "  ← trop lent" : ""}`),
    "══════════════════════════════════════════════════════",
    "",
  ];
  return {
    stdout: lignes.join("\n"),
    "k6/rupture-resume.json": JSON.stringify({ casse, debit_vise_a_la_rupture: debitAtteint, duree_s: duree, paliers, metrics: m }, null, 2),
  };
}
