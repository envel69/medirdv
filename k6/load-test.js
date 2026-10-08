import http from "k6/http";
import { check, group, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";

const BASE = __ENV.BASE_URL || "http://localhost:3001";
const JSON_HEADERS = { "Content-Type": "application/json" };

const reservationsOk = new Counter("reservations_reussies");
const conflits = new Counter("reservations_conflit_409");
const gagnantsCourse = new Counter("course_creneau_gagnants");
const dureeReservation = new Trend("duree_parcours_reservation", true);

// Charge modérée : le cluster Atlas est un M0 gratuit (débit limité)
export const options = {
  scenarios: {
    // Patients qui cherchent un praticien et consultent les agendas
    recherche: {
      executor: "ramping-vus", exec: "recherche", startVUs: 0,
      stages: [{ duration: "15s", target: 15 }, { duration: "40s", target: 15 }, { duration: "10s", target: 0 }],
    },
    // Parcours complet : disponibilités -> réservation -> annulation -> suppression
    reservation: { executor: "constant-vus", exec: "reservation", vus: 4, duration: "60s" },
    // Tableau de bord consulté en continu
    statistiques: { executor: "constant-arrival-rate", exec: "statistiques", rate: 1, timeUnit: "2s", duration: "60s", preAllocatedVUs: 2 },
    // 20 patients tentent de réserver exactement le même créneau au même moment
    course_au_creneau: { executor: "per-vu-iterations", exec: "courseAuCreneau", vus: 20, iterations: 1, startTime: "30s" },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{scenario:recherche}": ["p(95)<500"],
    "http_req_duration{name:POST /rendez-vous}": ["p(95)<800"],
    "http_req_duration{name:GET /stats}": ["p(95)<1500"],
    checks: ["rate>0.99"],
    course_creneau_gagnants: ["count==1"], // l'index unique doit laisser passer une seule réservation
  },
};

const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];

export function setup() {
  const praticiens = http.get(`${BASE}/praticiens?limit=200`).json("data");
  const patients = http.get(`${BASE}/patients?limit=200`).json("data").map((p) => p._id);

  // Créneau cible de la course : premier créneau libre dans 3 semaines d'un praticien
  let course = null;
  for (const p of praticiens) {
    const d = new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10);
    const jours = http.get(`${BASE}/praticiens/${p._id}/disponibilites?debut=${d}&jours=5`).json("jours");
    const jour = jours.find((j) => j.creneaux.length);
    if (jour) { course = { praticien_id: p._id, debut: jour.creneaux[0] }; break; }
  }
  return {
    praticiens: praticiens.map((p) => ({ _id: p._id, specialite: p.specialite, ville: p.adresse.ville, motifs: p.motifs })),
    specialites: [...new Set(praticiens.map((p) => p.specialite))],
    patients,
    course,
    debutTest: Date.now(),
  };
}

export function recherche(data) {
  const spe = rand(data.specialites);
  const res = http.get(`${BASE}/praticiens?specialite=${encodeURIComponent(spe)}`, { tags: { name: "GET /praticiens?specialite" } });
  check(res, { "recherche 200": (r) => r.status === 200 });
  const liste = res.json("data") || [];
  // Consulte l'agenda de 2 praticiens de la liste
  for (const p of liste.slice(0, 2)) {
    const d = http.get(`${BASE}/praticiens/${p._id}/disponibilites?jours=5`, { tags: { name: "GET /praticiens/:id/disponibilites" } });
    check(d, { "disponibilités 200": (r) => r.status === 200 });
  }
  sleep(1);
}

export function reservation(data) {
  const debutParcours = Date.now();
  group("parcours réservation", () => {
    const p = rand(data.praticiens);
    const patient = rand(data.patients);
    const dispo = http.get(`${BASE}/praticiens/${p._id}/disponibilites?jours=14`, { tags: { name: "GET /praticiens/:id/disponibilites" } });
    if (!check(dispo, { "disponibilités 200": (r) => r.status === 200 })) return;
    const creneaux = dispo.json("jours").flatMap((j) => j.creneaux);
    if (!creneaux.length) return;

    const res = http.post(`${BASE}/rendez-vous`,
      JSON.stringify({ praticien_id: p._id, patient_id: patient, debut: rand(creneaux), motif: p.motifs?.[0] }),
      { headers: JSON_HEADERS, tags: { name: "POST /rendez-vous" }, responseCallback: http.expectedStatuses(201, 409) });
    // 409 = conflit légitime (créneau pris entre-temps ou patient déjà occupé)
    check(res, { "réservation 201 ou 409": (r) => r.status === 201 || r.status === 409 });
    if (res.status === 409) { conflits.add(1); return; }
    if (res.status !== 201) return;
    reservationsOk.add(1);
    const id = res.json("_id");

    check(http.get(`${BASE}/rendez-vous/${id}`, { tags: { name: "GET /rendez-vous/:id" } }), { "détail 200": (r) => r.status === 200 });
    check(http.patch(`${BASE}/rendez-vous/${id}`, JSON.stringify({ statut: "annule" }), { headers: JSON_HEADERS, tags: { name: "PATCH /rendez-vous/:id" } }),
      { "annulation 200": (r) => r.status === 200 && r.json("statut") === "annule" });
    // Nettoyage : on ne laisse aucune donnée de test
    check(http.del(`${BASE}/rendez-vous/${id}`, null, { tags: { name: "DELETE /rendez-vous/:id" } }), { "suppression 204": (r) => r.status === 204 });
  });
  dureeReservation.add(Date.now() - debutParcours);
  sleep(1);
}

export function statistiques() {
  check(http.get(`${BASE}/stats`, { tags: { name: "GET /stats" } }), { "stats 200": (r) => r.status === 200 });
}

export function courseAuCreneau(data) {
  if (!data.course) return;
  const patient = data.patients[__VU % data.patients.length];
  const res = http.post(`${BASE}/rendez-vous`, JSON.stringify({ ...data.course, patient_id: patient }),
    { headers: JSON_HEADERS, tags: { name: "POST /rendez-vous (course)" }, responseCallback: http.expectedStatuses(201, 409) });
  check(res, { "course : 201 ou 409": (r) => r.status === 201 || r.status === 409 });
  if (res.status === 201) gagnantsCourse.add(1);
}

export function teardown(data) {
  if (!data.course) return;
  // Supprime le rendez-vous gagnant de la course
  const debut = new Date(data.course.debut);
  const fin = new Date(debut.getTime() + 60000).toISOString();
  const r = http.get(`${BASE}/rendez-vous?praticien_id=${data.course.praticien_id}&du=${debut.toISOString()}&au=${fin}`);
  for (const rdv of r.json("data") || []) {
    if (new Date(rdv.cree_le).getTime() >= data.debutTest) http.del(`${BASE}/rendez-vous/${rdv._id}`);
  }
}
