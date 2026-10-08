// Génère un jeu de données fictif : praticiens, patients et rendez-vous.
// Usage : npm run seed   (vide puis recrée les collections de la base DB_NAME)
import { MongoClient } from "mongodb";
import { creneauxDuJour, finDuCreneau } from "./lib/creneaux.js";

const { MONGODB_URI, DB_NAME = "doctolib" } = process.env;

// PRNG déterministe : même dataset à chaque exécution
let seed = 20261008;
function rand() {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (a, b) => a + Math.floor(rand() * (b - a + 1));
const chance = (p) => rand() < p;
const pad = (n, l = 2) => String(n).padStart(l, "0");

const PRENOMS_F = ["Camille", "Léa", "Manon", "Chloé", "Emma", "Inès", "Sarah", "Julie", "Laura", "Clara", "Anaïs", "Marie", "Lucie", "Pauline", "Céline", "Nathalie", "Sophie", "Isabelle", "Amira", "Yasmine", "Fatou", "Elodie", "Margaux", "Jeanne", "Louise", "Zoé", "Alice", "Charlotte"];
const PRENOMS_H = ["Lucas", "Hugo", "Thomas", "Nicolas", "Julien", "Maxime", "Antoine", "Mehdi", "Karim", "Alexandre", "Pierre", "Louis", "Gabriel", "Arthur", "Nathan", "Théo", "Paul", "Romain", "Vincent", "Olivier", "Mamadou", "Yanis", "Samuel", "Jules", "Adrien", "Benoît", "François", "Raphaël"];
const NOMS = ["Martin", "Bernard", "Dubois", "Thomas", "Robert", "Richard", "Petit", "Durand", "Leroy", "Moreau", "Simon", "Laurent", "Lefebvre", "Michel", "Garcia", "David", "Bertrand", "Roux", "Vincent", "Fournier", "Morel", "Girard", "André", "Mercier", "Dupont", "Lambert", "Bonnet", "François", "Martinez", "Legrand", "Garnier", "Faure", "Rousseau", "Blanc", "Guerin", "Muller", "Henry", "Roussel", "Nicolas", "Perrin", "Morin", "Mathieu", "Clement", "Gauthier", "Dumont", "Lopez", "Fontaine", "Chevalier", "Robin", "Masson", "Benali", "Nguyen", "Diallo", "Haddad", "Traoré", "Cohen", "Ferreira", "Da Silva"];
const VILLES = [
  { ville: "Paris", cps: ["75003", "75008", "75011", "75012", "75015", "75017", "75018", "75020"], poids: 4 },
  { ville: "Lyon", cps: ["69002", "69003", "69006", "69007"], poids: 2 },
  { ville: "Marseille", cps: ["13001", "13006", "13008"], poids: 2 },
  { ville: "Toulouse", cps: ["31000", "31400"], poids: 1 },
  { ville: "Bordeaux", cps: ["33000", "33800"], poids: 1 },
  { ville: "Lille", cps: ["59000", "59800"], poids: 1 },
  { ville: "Nantes", cps: ["44000", "44100"], poids: 1 },
  { ville: "Strasbourg", cps: ["67000"], poids: 1 },
  { ville: "Montpellier", cps: ["34000", "34070"], poids: 1 },
  { ville: "Nice", cps: ["06000", "06100"], poids: 1 },
];
const VILLES_PONDEREES = VILLES.flatMap((v) => Array(v.poids).fill(v));
const RUES = ["rue de la République", "avenue Jean Jaurès", "boulevard Victor Hugo", "rue Pasteur", "place de la Mairie", "rue Nationale", "avenue de la Gare", "rue des Lilas", "rue Voltaire", "boulevard Gambetta", "rue du Général Leclerc", "avenue Foch"];

// Tarifs indicatifs (secteur 1), durée de rendez-vous et motifs par spécialité
const SPECIALITES = [
  { nom: "Médecin généraliste", n: 14, tarif: 30, durees: [15, 20], dr: true, tele: 0.7, motifs: ["Consultation", "Renouvellement d'ordonnance", "Certificat médical", "Vaccination", "Suivi maladie chronique"] },
  { nom: "Dentiste", n: 8, tarif: 30, durees: [30], dr: true, tele: 0, motifs: ["Contrôle", "Détartrage", "Douleur dentaire", "Soin de carie"] },
  { nom: "Masseur-kinésithérapeute", n: 8, tarif: 20, durees: [30], dr: false, tele: 0, motifs: ["Rééducation", "Lombalgie", "Entorse", "Kinésithérapie respiratoire"] },
  { nom: "Pédiatre", n: 5, tarif: 35, durees: [20], dr: true, tele: 0.3, motifs: ["Consultation enfant", "Vaccination", "Examen obligatoire", "Suivi de croissance"] },
  { nom: "Gynécologue", n: 5, tarif: 50, durees: [20], dr: true, tele: 0.2, motifs: ["Suivi gynécologique", "Contraception", "Suivi de grossesse", "Frottis"] },
  { nom: "Psychologue", n: 5, tarif: 60, durees: [45, 60], dr: false, tele: 0.9, motifs: ["Première consultation", "Suivi", "Thérapie de couple"] },
  { nom: "Dermatologue", n: 4, tarif: 50, durees: [20], dr: true, tele: 0.3, motifs: ["Contrôle des grains de beauté", "Acné", "Eczéma", "Contrôle annuel"] },
  { nom: "Ophtalmologue", n: 4, tarif: 50, durees: [15], dr: true, tele: 0, motifs: ["Contrôle de la vue", "Renouvellement de lunettes", "Fond d'œil"] },
  { nom: "ORL", n: 4, tarif: 50, durees: [20], dr: true, tele: 0.1, motifs: ["Otite", "Sinusite", "Bilan auditif"] },
  { nom: "Cardiologue", n: 3, tarif: 55, durees: [30], dr: true, tele: 0.5, motifs: ["Bilan cardiaque", "Électrocardiogramme", "Suivi hypertension"] },
];
const HORAIRES = [
  { jours: [1, 2, 3, 4, 5], plages: [{ debut: "09:00", fin: "12:00" }, { debut: "14:00", fin: "18:00" }] },
  { jours: [1, 2, 3, 4, 5], plages: [{ debut: "08:30", fin: "12:30" }, { debut: "13:30", fin: "17:30" }] },
  { jours: [2, 3, 4, 5, 6], plages: [{ debut: "09:00", fin: "13:00" }, { debut: "14:00", fin: "17:00" }] },
  { jours: [1, 2, 4, 5], plages: [{ debut: "08:00", fin: "12:00" }, { debut: "14:00", fin: "19:00" }] },
];
const LANGUES = ["Anglais", "Espagnol", "Arabe", "Italien", "Allemand", "Portugais"];
// Plage 06 39 98 xx xx réservée par l'ARCEP aux œuvres de fiction
const telFictif = () => `06 39 98 ${pad(between(0, 99))} ${pad(between(0, 99))}`;
const sansAccent = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");

function genPraticiens() {
  const res = [];
  for (const sp of SPECIALITES) {
    for (let i = 0; i < sp.n; i++) {
      const femme = chance(0.55);
      const v = pick(VILLES_PONDEREES);
      const secteur = sp.nom === "Psychologue" ? null : chance(0.7) ? 1 : 2;
      const depassement = secteur === 2 ? between(2, 8) * 5 : 0;
      res.push({
        civilite: sp.dr ? "Dr" : femme ? "Mme" : "M.",
        prenom: pick(femme ? PRENOMS_F : PRENOMS_H),
        nom: pick(NOMS),
        specialite: sp.nom,
        adresse: { rue: `${between(1, 120)} ${pick(RUES)}`, code_postal: pick(v.cps), ville: v.ville },
        telephone: telFictif(),
        secteur,
        conventionne: secteur !== null,
        tarif_consultation: sp.tarif + depassement,
        teleconsultation: chance(sp.tele),
        langues: ["Français", ...(chance(0.4) ? [pick(LANGUES)] : [])],
        moyens_paiement: chance(0.8) ? ["Carte bancaire", "Chèques", "Espèces"] : ["Chèques", "Espèces"],
        motifs: sp.motifs,
        duree_rdv_min: pick(sp.durees),
        horaires: pick(HORAIRES),
        accepte_nouveaux_patients: chance(0.8),
      });
    }
  }
  return res;
}

function genPatients(n) {
  const res = [];
  const emails = new Set();
  for (let i = 0; i < n; i++) {
    const femme = chance(0.52);
    const prenom = pick(femme ? PRENOMS_F : PRENOMS_H);
    const nom = pick(NOMS);
    let email = `${sansAccent(prenom)}.${sansAccent(nom)}@example.com`;
    for (let k = 2; emails.has(email); k++) email = `${sansAccent(prenom)}.${sansAccent(nom)}${k}@example.com`;
    emails.add(email);
    const v = pick(VILLES_PONDEREES);
    res.push({
      civilite: femme ? "Mme" : "M.",
      prenom, nom, email,
      telephone: telFictif(),
      date_naissance: new Date(Date.UTC(between(1940, 2023), between(0, 11), between(1, 28))),
      ville: v.ville,
      code_postal: pick(v.cps),
      cree_le: new Date(Date.now() - between(1, 900) * 86400000),
    });
  }
  return res;
}

function genRendezVous(praticiens, patients) {
  const now = new Date();
  const aujourdhui = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const occupe = new Set(); // patient|horaire, pour éviter qu'un patient soit à deux endroits
  const res = [];
  const motifsPar = Object.fromEntries(SPECIALITES.map((s) => [s.nom, s.motifs]));
  for (const p of praticiens) {
    // Chaque praticien a sa patientèle locale (+ quelques patients d'ailleurs)
    const locaux = patients.filter((pt) => pt.ville === p.adresse.ville);
    const patientele = locaux.length > 20 ? locaux : patients;
    const popularite = 0.6 + rand() * 0.4;
    for (let d = -45; d <= 28; d++) {
      const jour = new Date(aujourdhui.getFullYear(), aujourdhui.getMonth(), aujourdhui.getDate() + d);
      // Taux de remplissage : élevé dans le passé et les jours proches, plus faible loin dans le futur
      const remplissage = d < 0 ? 0.75 : Math.max(0.12, 0.85 - d * 0.03);
      for (const debut of creneauxDuJour(p, jour)) {
        if (!chance(remplissage * popularite)) continue;
        const patient = chance(0.9) ? pick(patientele) : pick(patients);
        const cle = `${patient._id}|${debut.getTime()}`;
        if (occupe.has(cle)) continue;
        const passe = debut < now;
        const r = rand();
        const statut = passe ? (r < 0.84 ? "honore" : r < 0.9 ? "absent" : "annule") : r < 0.9 ? "confirme" : "annule";
        if (statut !== "annule") occupe.add(cle);
        const delai = between(0, Math.min(30, d + 45)) * 86400000 + between(1, 600) * 60000;
        res.push({
          praticien_id: p._id,
          patient_id: patient._id,
          debut,
          fin: finDuCreneau(p, debut),
          motif: pick(motifsPar[p.specialite]),
          type: p.teleconsultation && chance(0.2) ? "teleconsultation" : "cabinet",
          statut,
          cree_le: new Date(Math.min(debut.getTime() - delai, now.getTime() - between(1, 600) * 60000)),
        });
      }
    }
  }
  return res;
}

const client = new MongoClient(MONGODB_URI);
await client.connect();
const db = client.db(DB_NAME);

for (const c of ["praticiens", "patients", "rendez_vous"]) await db.collection(c).drop().catch(() => {});

const praticiens = genPraticiens();
const patients = genPatients(6000);
await db.collection("praticiens").insertMany(praticiens);
await db.collection("patients").insertMany(patients);
const rdv = genRendezVous(praticiens, patients);
for (let i = 0; i < rdv.length; i += 5000) await db.collection("rendez_vous").insertMany(rdv.slice(i, i + 5000));

await db.collection("praticiens").createIndexes([{ key: { specialite: 1, "adresse.ville": 1 } }, { key: { nom: 1 } }]);
await db.collection("patients").createIndex({ email: 1 }, { unique: true });
await db.collection("rendez_vous").createIndexes([
  // Empêche la double réservation d'un même créneau (les rendez-vous annulés libèrent le créneau)
  { key: { praticien_id: 1, debut: 1 }, unique: true, name: "creneau_unique", partialFilterExpression: { statut: { $in: ["confirme", "honore", "absent"] } } },
  { key: { patient_id: 1, debut: 1 } },
  { key: { debut: 1 } },
]);

console.log(`Base "${DB_NAME}" : ${praticiens.length} praticiens, ${patients.length} patients, ${rdv.length} rendez-vous`);
await client.close();
