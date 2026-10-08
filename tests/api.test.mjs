// Tests d'intégration de l'API : à lancer avec le serveur démarré (npm start) puis `npm test`.
// Chaque test crée ses propres données (patients/praticien de test) et les supprime à la fin.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "http://localhost:3001";
const JOUR = 86400000;

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const jourISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const suffixe = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const patientsTest = [];
let cabinet;     // praticien sans téléconsultation
let creneaux;    // créneaux libres de ce praticien dans ~2 semaines

async function creerPatient(i) {
  const { status, body } = await api("POST", "/patients", { prenom: "Test", nom: `CI ${i}`, email: `test.ci.${suffixe}.${i}@example.com` });
  assert.equal(status, 201);
  patientsTest.push(body._id);
  return body._id;
}

before(async () => {
  const { body } = await api("GET", "/praticiens?limit=200&teleconsultation=false");
  for (const p of body.data) {
    const debut = jourISO(new Date(Date.now() + 15 * JOUR));
    const d = await api("GET", `/praticiens/${p._id}/disponibilites?debut=${debut}&jours=7`);
    const libres = d.body.jours.flatMap((j) => j.creneaux);
    if (libres.length >= 6) { cabinet = p; creneaux = libres; break; }
  }
  assert.ok(cabinet, "aucun praticien avec des créneaux libres trouvé");
  for (let i = 0; i < 12; i++) await creerPatient(i);
});

after(async () => {
  // La suppression d'un patient supprime aussi ses rendez-vous
  await Promise.all(patientsTest.map((id) => api("DELETE", `/patients/${id}`)));
});

describe("Praticiens", () => {
  test("liste paginée et filtrée par spécialité", async () => {
    const { status, body } = await api("GET", "/praticiens?specialite=Dentiste");
    assert.equal(status, 200);
    assert.ok(body.total > 0);
    assert.ok(body.data.every((p) => p.specialite === "Dentiste"));
  });

  test("id invalide → 400, id inconnu → 404", async () => {
    assert.equal((await api("GET", "/praticiens/pas-un-id")).status, 400);
    assert.equal((await api("GET", "/praticiens/000000000000000000000000")).status, 404);
  });

  test("validation à la création", async () => {
    const manquant = await api("POST", "/praticiens", { nom: "Sans spécialité" });
    assert.equal(manquant.status, 400);
    const horaires = await api("POST", "/praticiens", { nom: "X", specialite: "ORL", duree_rdv_min: 20, horaires: { jours: [9], plages: [] } });
    assert.equal(horaires.status, 400);
  });

  test("cycle complet création → lecture → modification → remplacement → suppression", async () => {
    const doc = { prenom: "Test", nom: `CI ${suffixe}`, specialite: "ORL", duree_rdv_min: 20,
      horaires: { jours: [1, 2, 3, 4, 5], plages: [{ debut: "09:00", fin: "12:00" }] } };
    const cree = await api("POST", "/praticiens", doc);
    assert.equal(cree.status, 201);
    const id = cree.body._id;
    try {
      assert.equal((await api("GET", `/praticiens/${id}`)).body.nom, doc.nom);
      const patch = await api("PATCH", `/praticiens/${id}`, { tarif_consultation: 42 });
      assert.equal(patch.body.tarif_consultation, 42);
      const put = await api("PUT", `/praticiens/${id}`, { ...doc, nom: "Remplacé" });
      assert.equal(put.body.nom, "Remplacé");
      assert.equal(put.body.tarif_consultation, undefined, "PUT remplace tout le document");
      assert.ok(put.body.cree_le, "PUT conserve la date de création");
      // Les disponibilités du nouveau praticien sont immédiatement calculables (cache rechargé)
      assert.equal((await api("GET", `/praticiens/${id}/disponibilites?jours=3`)).status, 200);
    } finally {
      assert.equal((await api("DELETE", `/praticiens/${id}`)).status, 204);
    }
    assert.equal((await api("GET", `/praticiens/${id}`)).status, 404);
  });
});

describe("Patients", () => {
  test("e-mail en double → 409", async () => {
    const res = await api("POST", "/patients", { prenom: "Doublon", nom: "CI", email: `test.ci.${suffixe}.0@example.com` });
    assert.equal(res.status, 409);
  });

  test("e-mail invalide → 400", async () => {
    assert.equal((await api("POST", "/patients", { prenom: "A", nom: "B", email: "pas-un-email" })).status, 400);
  });
});

describe("Disponibilités", () => {
  test("renvoie le nombre de jours demandé, uniquement des créneaux futurs et triés", async () => {
    const { status, body } = await api("GET", `/praticiens/${cabinet._id}/disponibilites?jours=7`);
    assert.equal(status, 200);
    assert.equal(body.jours.length, 7);
    const tous = body.jours.flatMap((j) => j.creneaux).map((c) => new Date(c).getTime());
    assert.ok(tous.every((t) => t > Date.now()));
    assert.deepEqual(tous, [...tous].sort((a, b) => a - b));
  });
});

describe("Rendez-vous", () => {
  test("réservation, conflits, annulation puis nouvelle réservation", async () => {
    const [patientA, patientB] = patientsTest;
    const slot = creneaux[0];

    const ok = await api("POST", "/rendez-vous", { praticien_id: cabinet._id, patient_id: patientA, debut: slot });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.statut, "confirme");
    assert.equal(new Date(ok.body.fin) - new Date(ok.body.debut), cabinet.duree_rdv_min * 60000);

    // Le créneau n'est plus proposé
    const dispo = await api("GET", `/praticiens/${cabinet._id}/disponibilites?debut=${slot.slice(0, 10)}&jours=2`);
    assert.ok(!dispo.body.jours.flatMap((j) => j.creneaux).includes(slot));

    // Un autre patient ne peut pas prendre le même créneau
    assert.equal((await api("POST", "/rendez-vous", { praticien_id: cabinet._id, patient_id: patientB, debut: slot })).status, 409);
    // Le même patient ne peut pas être à deux rendez-vous en même temps
    assert.equal((await api("POST", "/rendez-vous", { praticien_id: cabinet._id, patient_id: patientA, debut: slot })).status, 409);

    // Annulation : le créneau redevient libre et peut être repris
    const annule = await api("PATCH", `/rendez-vous/${ok.body._id}`, { statut: "annule" });
    assert.equal(annule.body.statut, "annule");
    const repris = await api("POST", "/rendez-vous", { praticien_id: cabinet._id, patient_id: patientB, debut: slot });
    assert.equal(repris.status, 201);

    // Détail avec jointures praticien + patient
    const detail = await api("GET", `/rendez-vous/${repris.body._id}`);
    assert.equal(detail.body.praticien.nom, cabinet.nom);
    assert.equal(detail.body.patient.nom, "CI 1");

    assert.equal((await api("DELETE", `/rendez-vous/${repris.body._id}`)).status, 204);
    assert.equal((await api("DELETE", `/rendez-vous/${ok.body._id}`)).status, 204);
  });

  test("refuse les créneaux invalides", async () => {
    const patient = patientsTest[2];
    const base = { praticien_id: cabinet._id, patient_id: patient };
    const passe = new Date(Date.now() - JOUR).toISOString();
    assert.equal((await api("POST", "/rendez-vous", { ...base, debut: passe })).status, 400, "créneau passé");
    const decale = new Date(new Date(creneaux[1]).getTime() + 7 * 60000).toISOString();
    assert.equal((await api("POST", "/rendez-vous", { ...base, debut: decale })).status, 400, "hors grille horaire");
    assert.equal((await api("POST", "/rendez-vous", { ...base, debut: creneaux[1], type: "teleconsultation" })).status, 400, "téléconsultation non proposée");
    assert.equal((await api("POST", "/rendez-vous", { ...base, debut: creneaux[1], motif: "Motif inventé" })).status, 400, "motif inconnu");
    assert.equal((await api("POST", "/rendez-vous", { ...base, patient_id: "000000000000000000000000", debut: creneaux[1] })).status, 404, "patient inconnu");
    assert.equal((await api("POST", "/rendez-vous", "{pas du json")).status, 400, "JSON invalide");
  });

  test("10 réservations simultanées du même créneau : une seule réussit", async () => {
    const slot = creneaux[2];
    const resultats = await Promise.all(patientsTest.slice(2, 12).map((patient_id) =>
      api("POST", "/rendez-vous", { praticien_id: cabinet._id, patient_id, debut: slot })));
    const statuts = resultats.map((r) => r.status);
    assert.equal(statuts.filter((s) => s === 201).length, 1, `statuts reçus : ${statuts.join(", ")}`);
    assert.ok(statuts.every((s) => s === 201 || s === 409));
    const gagnant = resultats.find((r) => r.status === 201);
    await api("DELETE", `/rendez-vous/${gagnant.body._id}`);
  });
});

// ---------- Client SSE minimal pour les tests (fetch + lecture du flux) ----------
async function ouvrirFlux() {
  const ctrl = new AbortController();
  const res = await fetch(BASE + "/creneaux/events", { signal: ctrl.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const evenements = [];
  const attentes = new Set();
  let tampon = "";
  const verifier = () => { for (const a of attentes) { const e = evenements.find(a.pred); if (e) { attentes.delete(a); clearTimeout(a.t); a.ok(e); } } };
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        tampon += decoder.decode(value, { stream: true });
        let i;
        while ((i = tampon.indexOf("\n\n")) >= 0) {
          const bloc = tampon.slice(0, i);
          tampon = tampon.slice(i + 2);
          const ev = { brut: bloc };
          for (const ligne of bloc.split("\n")) {
            if (ligne.startsWith(":")) ev.commentaire = ligne.slice(1).trim();
            else if (ligne.startsWith("event:")) ev.nom = ligne.slice(6).trim();
            else if (ligne.startsWith("data:")) ev.data = JSON.parse(ligne.slice(5).trim());
            else if (ligne.startsWith("id:")) ev.id = Number(ligne.slice(3).trim());
            else if (ligne.startsWith("retry:")) ev.retry = Number(ligne.slice(6).trim());
          }
          evenements.push(ev);
          verifier();
        }
      }
    } catch { /* flux fermé par le test */ }
  })();
  return {
    res,
    evenements,
    attendre(pred, ms = 5000) {
      return new Promise((ok, ko) => {
        const a = { pred, ok };
        a.t = setTimeout(() => { attentes.delete(a); ko(new Error("événement attendu non reçu")); }, ms);
        attentes.add(a);
        verifier();
      });
    },
    fermer: () => ctrl.abort(),
  };
}
const attendreConnexions = async (n) => {
  for (let i = 0; i < 50; i++) {
    if ((await api("GET", "/creneaux/events/count")).body.connexions === n) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

describe("Temps réel (SSE)", () => {
  test("flux text/event-stream : retry puis ready {action: reload}", async () => {
    const flux = await ouvrirFlux();
    try {
      assert.equal(flux.res.status, 200);
      assert.match(flux.res.headers.get("content-type"), /^text\/event-stream/);
      const ready = await flux.attendre((e) => e.nom === "ready");
      assert.deepEqual(ready.data, { action: "reload" });
      assert.ok(Number.isInteger(ready.id), "chaque événement a un identifiant");
      assert.ok(flux.evenements.some((e) => e.retry > 0), "délai de reconnexion conseillé au navigateur");
    } finally { flux.fermer(); }
  });

  test("réservation, annulation et suppression diffusées sans données personnelles", async () => {
    const patientId = patientsTest[0];
    const slot = creneaux[3];
    const memeCreneau = (status) => (e) => e.nom === "slot-updated" && e.data.praticienId === String(cabinet._id)
      && new Date(e.data.debut).getTime() === new Date(slot).getTime() && e.data.status === status;
    const flux = await ouvrirFlux();
    try {
      await flux.attendre((e) => e.nom === "ready");
      const cree = await api("POST", "/rendez-vous", { praticien_id: cabinet._id, patient_id: patientId, debut: slot });
      assert.equal(cree.status, 201);

      const pris = await flux.attendre(memeCreneau("BOOKED"));
      assert.deepEqual(Object.keys(pris.data).sort(), ["debut", "praticienId", "slotId", "status", "version"]);
      assert.ok(!pris.brut.includes(patientId), "l'identifiant du patient n'est pas diffusé");
      assert.ok(!pris.brut.includes(cree.body._id), "l'identifiant du rendez-vous n'est pas diffusé");

      assert.equal((await api("PATCH", `/rendez-vous/${cree.body._id}`, { statut: "annule" })).status, 200);
      const libere = await flux.attendre(memeCreneau("AVAILABLE"));
      assert.ok(libere.data.version > pris.data.version, "les versions sont croissantes");

      flux.evenements.length = 0;
      assert.equal((await api("DELETE", `/rendez-vous/${cree.body._id}`)).status, 204);
      await flux.attendre(memeCreneau("AVAILABLE"));
    } finally { flux.fermer(); }
  });

  test("plusieurs abonnés reçoivent l'événement ; les connexions fermées sont retirées", async () => {
    const avant = (await api("GET", "/creneaux/events/count")).body.connexions;
    const a = await ouvrirFlux();
    const b = await ouvrirFlux();
    try {
      await Promise.all([a.attendre((e) => e.nom === "ready"), b.attendre((e) => e.nom === "ready")]);
      assert.equal((await api("GET", "/creneaux/events/count")).body.connexions, avant + 2);
      const cree = await api("POST", "/rendez-vous", { praticien_id: cabinet._id, patient_id: patientsTest[1], debut: creneaux[4] });
      assert.equal(cree.status, 201);
      const pred = (e) => e.nom === "slot-updated" && e.data.status === "BOOKED" && new Date(e.data.debut).getTime() === new Date(creneaux[4]).getTime();
      await Promise.all([a.attendre(pred), b.attendre(pred)]);
      await api("DELETE", `/rendez-vous/${cree.body._id}`);
    } finally { a.fermer(); b.fermer(); }
    assert.ok(await attendreConnexions(avant), "les deux connexions fermées sont retirées côté serveur");
  });

  test("un abonné parti n'empêche pas de réserver", async () => {
    const flux = await ouvrirFlux();
    await flux.attendre((e) => e.nom === "ready");
    flux.fermer();
    const cree = await api("POST", "/rendez-vous", { praticien_id: cabinet._id, patient_id: patientsTest[2], debut: creneaux[5] });
    assert.equal(cree.status, 201);
    await api("DELETE", `/rendez-vous/${cree.body._id}`);
  });
});

describe("Statistiques", () => {
  test("indicateurs cohérents", async () => {
    const { status, body } = await api("GET", "/stats");
    assert.equal(status, 200);
    const t = body.totaux;
    assert.ok(t.rendez_vous > 0 && t.praticiens > 0);
    for (const k of ["taux_annulation", "taux_absence", "part_teleconsultation"]) assert.ok(t[k] >= 0 && t[k] <= 1, k);
    const somme = Object.values(body.par_statut).reduce((a, b) => a + b, 0);
    assert.equal(somme, t.rendez_vous);
    assert.ok(body.par_specialite.length > 0 && body.par_jour.length > 0);
  });

  test("route inconnue → 404", async () => {
    assert.equal((await api("GET", "/nexiste-pas")).status, 404);
  });
});
