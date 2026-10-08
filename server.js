import express from "express";
import { MongoClient, ObjectId } from "mongodb";
import { creneauxDuJour, estUnCreneau, finDuCreneau, formatJour, parseJour } from "./lib/creneaux.js";

const { MONGODB_URI, DB_NAME = "doctolib", PORT = 3001, LATENCE_SIMULEE_MS = "0" } = process.env;

const client = new MongoClient(MONGODB_URI);
await client.connect();
const db = client.db(DB_NAME);
const praticiens = db.collection("praticiens");
const patients = db.collection("patients");
const rendezVous = db.collection("rendez_vous");
console.log(`Connecté à MongoDB (${DB_NAME})`);

// Cache mémoire des praticiens : peu nombreux et rarement modifiés, mais lus à chaque
// consultation d'agenda et réservation. Économise des opérations (le cluster M0 est limité
// en opérations/s). Rechargé après chaque écriture via l'API et au plus tard toutes les 60 s
// (modifications faites hors API, ex. depuis Compass).
const cachePraticiens = { parId: new Map(), charge_le: 0, enCours: null };
async function rechargerPraticiens() {
  cachePraticiens.enCours ??= praticiens.find().toArray().then((liste) => {
    cachePraticiens.parId = new Map(liste.map((p) => [String(p._id), p]));
    cachePraticiens.charge_le = Date.now();
  }).finally(() => { cachePraticiens.enCours = null; });
  return cachePraticiens.enCours;
}
async function tousLesPraticiens() {
  if (Date.now() - cachePraticiens.charge_le > 60000) await rechargerPraticiens();
  return [...cachePraticiens.parId.values()];
}
async function getPraticien(_id) {
  if (Date.now() - cachePraticiens.charge_le > 60000) await rechargerPraticiens();
  return cachePraticiens.parId.get(String(_id)) ?? null;
}
await rechargerPraticiens();

const app = express();
app.use(express.json());
app.use(express.static("public"));

// Latence artificielle sur les routes de l'API (sert à vérifier que la CI détecte bien une lenteur)
const latence = parseInt(LATENCE_SIMULEE_MS) || 0;
if (latence > 0) {
  console.warn(`⚠ Latence simulée : +${latence} ms par requête`);
  app.use((req, res, next) => setTimeout(next, latence));
}

const JOUR = 86400000;
const STATUTS = ["confirme", "honore", "absent", "annule"];
const STATUTS_ACTIFS = ["confirme", "honore", "absent"]; // occupent le créneau

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const route = (fn) => (req, res, next) => fn(req, res).catch(next);

function oid(value, champ = "id") {
  if (typeof value !== "string" || !ObjectId.isValid(value)) throw new HttpError(400, `${champ} invalide`);
  return new ObjectId(value);
}
function pagination(req) {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
  return { page, limit, skip: (page - 1) * limit };
}
const regexSure = (s) => ({ $regex: s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" });
const pick = (body, champs) => Object.fromEntries(Object.entries(body ?? {}).filter(([k]) => champs.includes(k)));

// ---------- Validation ----------

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
function validerHoraires(h) {
  const ok = h && Array.isArray(h.jours) && h.jours.every((j) => Number.isInteger(j) && j >= 1 && j <= 7)
    && Array.isArray(h.plages) && h.plages.length > 0
    && h.plages.every((p) => HHMM.test(p.debut) && HHMM.test(p.fin) && p.debut < p.fin);
  if (!ok) throw new HttpError(400, "horaires invalides : { jours: [1..7], plages: [{ debut: 'HH:MM', fin: 'HH:MM' }] }");
}

const RESSOURCES = {
  praticiens: {
    collection: praticiens,
    champs: ["civilite", "prenom", "nom", "specialite", "adresse", "telephone", "secteur", "conventionne", "tarif_consultation",
      "teleconsultation", "langues", "moyens_paiement", "motifs", "duree_rdv_min", "horaires", "accepte_nouveaux_patients"],
    requis: ["nom", "specialite", "duree_rdv_min", "horaires"],
    valider(doc) {
      if (doc.duree_rdv_min !== undefined && !(Number.isInteger(doc.duree_rdv_min) && doc.duree_rdv_min >= 5 && doc.duree_rdv_min <= 180))
        throw new HttpError(400, "duree_rdv_min doit être un entier entre 5 et 180");
      if (doc.horaires !== undefined) validerHoraires(doc.horaires);
    },
    filtre(q) {
      const f = {};
      if (q.specialite) f.specialite = q.specialite;
      if (q.ville) f["adresse.ville"] = q.ville;
      if (q.teleconsultation !== undefined) f.teleconsultation = q.teleconsultation === "true";
      if (q.q) f.$or = [{ nom: regexSure(q.q) }, { prenom: regexSure(q.q) }, { specialite: regexSure(q.q) }];
      return f;
    },
    tri: { nom: 1, prenom: 1 },
  },
  patients: {
    collection: patients,
    champs: ["civilite", "prenom", "nom", "email", "telephone", "date_naissance", "ville", "code_postal"],
    requis: ["prenom", "nom", "email"],
    valider(doc) {
      if (doc.email !== undefined && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(doc.email)) throw new HttpError(400, "email invalide");
      if (doc.date_naissance !== undefined) {
        const d = new Date(doc.date_naissance);
        if (isNaN(d)) throw new HttpError(400, "date_naissance invalide");
        doc.date_naissance = d;
      }
    },
    filtre(q) {
      const f = {};
      if (q.ville) f.ville = q.ville;
      if (q.q) f.$or = [{ nom: regexSure(q.q) }, { prenom: regexSure(q.q) }, { email: regexSure(q.q) }];
      return f;
    },
    tri: { nom: 1, prenom: 1 },
    // Suppression d'un compte patient : ses rendez-vous sont supprimés aussi
    async apresSuppression(_id) { await rendezVous.deleteMany({ patient_id: _id }); },
  },
};
RESSOURCES.praticiens.apresSuppression = async (_id) => { await rendezVous.deleteMany({ praticien_id: _id }); };
RESSOURCES.praticiens.apresEcriture = rechargerPraticiens;

// ---------- CRUD générique : praticiens et patients ----------

for (const [nom, r] of Object.entries(RESSOURCES)) {
  const base = `/${nom}`;

  app.get(base, route(async (req, res) => {
    const { page, limit, skip } = pagination(req);
    const filtre = r.filtre(req.query);
    const data = await r.collection.find(filtre).sort(r.tri).skip(skip).limit(limit).toArray();
    // Le total est connu sans requête supplémentaire quand la première page n'est pas pleine
    const total = page === 1 && data.length < limit ? data.length : await r.collection.countDocuments(filtre);
    res.json({ total, page, limit, data });
  }));

  app.get(`${base}/:id`, route(async (req, res) => {
    const doc = await r.collection.findOne({ _id: oid(req.params.id) });
    if (!doc) throw new HttpError(404, "introuvable");
    res.json(doc);
  }));

  app.post(base, route(async (req, res) => {
    const doc = pick(req.body, r.champs);
    const manquants = r.requis.filter((k) => doc[k] === undefined || doc[k] === "");
    if (manquants.length) throw new HttpError(400, `champs obligatoires manquants : ${manquants.join(", ")}`);
    r.valider(doc);
    doc.cree_le = new Date();
    const { insertedId } = await r.collection.insertOne(doc);
    await r.apresEcriture?.();
    res.status(201).json({ _id: insertedId, ...doc });
  }));

  app.put(`${base}/:id`, route(async (req, res) => {
    const _id = oid(req.params.id);
    const doc = pick(req.body, r.champs);
    const manquants = r.requis.filter((k) => doc[k] === undefined || doc[k] === "");
    if (manquants.length) throw new HttpError(400, `champs obligatoires manquants : ${manquants.join(", ")}`);
    r.valider(doc);
    const avant = await r.collection.findOne({ _id }, { projection: { cree_le: 1 } });
    if (!avant) throw new HttpError(404, "introuvable");
    const result = await r.collection.findOneAndReplace({ _id }, { ...doc, cree_le: avant.cree_le }, { returnDocument: "after" });
    await r.apresEcriture?.();
    res.json(result);
  }));

  app.patch(`${base}/:id`, route(async (req, res) => {
    const _id = oid(req.params.id);
    const maj = pick(req.body, r.champs);
    if (!Object.keys(maj).length) throw new HttpError(400, "aucun champ valide à modifier");
    r.valider(maj);
    const result = await r.collection.findOneAndUpdate({ _id }, { $set: maj }, { returnDocument: "after" });
    if (!result) throw new HttpError(404, "introuvable");
    await r.apresEcriture?.();
    res.json(result);
  }));

  app.delete(`${base}/:id`, route(async (req, res) => {
    const _id = oid(req.params.id);
    const { deletedCount } = await r.collection.deleteOne({ _id });
    if (!deletedCount) throw new HttpError(404, "introuvable");
    await r.apresSuppression(_id);
    await r.apresEcriture?.();
    res.status(204).end();
  }));
}

// ---------- Disponibilités ----------

// GET /praticiens/:id/disponibilites?debut=2026-10-08&jours=7
app.get("/praticiens/:id/disponibilites", route(async (req, res) => {
  const praticien = await getPraticien(oid(req.params.id));
  if (!praticien) throw new HttpError(404, "praticien introuvable");
  const now = new Date();
  const debut = req.query.debut ? parseJour(req.query.debut) : new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (isNaN(debut)) throw new HttpError(400, "debut invalide (format AAAA-MM-JJ)");
  const jours = Math.min(31, Math.max(1, parseInt(req.query.jours) || 7));
  const fin = new Date(debut.getFullYear(), debut.getMonth(), debut.getDate() + jours);

  const pris = await rendezVous
    .find({ praticien_id: praticien._id, statut: { $in: STATUTS_ACTIFS }, debut: { $gte: debut, $lt: fin } }, { projection: { debut: 1 } })
    .toArray();
  const occupes = new Set(pris.map((r) => r.debut.getTime()));

  const resultat = [];
  for (let i = 0; i < jours; i++) {
    const jour = new Date(debut.getFullYear(), debut.getMonth(), debut.getDate() + i);
    const creneaux = creneauxDuJour(praticien, jour).filter((c) => c > now && !occupes.has(c.getTime()));
    resultat.push({ date: formatJour(jour), creneaux });
  }
  res.json({ praticien_id: praticien._id, duree_rdv_min: praticien.duree_rdv_min, jours: resultat });
}));

// ---------- Rendez-vous ----------

const LOOKUPS = [
  { $lookup: { from: "praticiens", localField: "praticien_id", foreignField: "_id", as: "praticien",
    pipeline: [{ $project: { civilite: 1, prenom: 1, nom: 1, specialite: 1, adresse: 1, tarif_consultation: 1 } }] } },
  { $lookup: { from: "patients", localField: "patient_id", foreignField: "_id", as: "patient",
    pipeline: [{ $project: { civilite: 1, prenom: 1, nom: 1, email: 1 } }] } },
  { $set: { praticien: { $first: "$praticien" }, patient: { $first: "$patient" } } },
];

// GET /rendez-vous?patient_id=&praticien_id=&statut=&du=&au=&details=true
app.get("/rendez-vous", route(async (req, res) => {
  const { page, limit, skip } = pagination(req);
  const q = req.query;
  const filtre = {};
  if (q.patient_id) filtre.patient_id = oid(q.patient_id, "patient_id");
  if (q.praticien_id) filtre.praticien_id = oid(q.praticien_id, "praticien_id");
  if (q.statut) filtre.statut = { $in: q.statut.split(",") };
  if (q.du || q.au) {
    filtre.debut = {};
    if (q.du) filtre.debut.$gte = new Date(q.du);
    if (q.au) filtre.debut.$lt = new Date(q.au);
  }
  const ordre = q.ordre === "desc" ? -1 : 1;
  const pipeline = [{ $match: filtre }, { $sort: { debut: ordre } }, { $skip: skip }, { $limit: limit }];
  if (q.details === "true") pipeline.push(...LOOKUPS);
  const [total, data] = await Promise.all([rendezVous.countDocuments(filtre), rendezVous.aggregate(pipeline).toArray()]);
  res.json({ total, page, limit, data });
}));

app.get("/rendez-vous/:id", route(async (req, res) => {
  const [doc] = await rendezVous.aggregate([{ $match: { _id: oid(req.params.id) } }, ...LOOKUPS]).toArray();
  if (!doc) throw new HttpError(404, "rendez-vous introuvable");
  res.json(doc);
}));

// POST /rendez-vous { praticien_id, patient_id, debut, motif?, type? }
app.post("/rendez-vous", route(async (req, res) => {
  const { praticien_id, patient_id, debut: debutStr, motif, type = "cabinet" } = req.body ?? {};
  const pid = oid(praticien_id, "praticien_id");
  const patId = oid(patient_id, "patient_id");
  const debut = new Date(debutStr);
  if (isNaN(debut)) throw new HttpError(400, "debut invalide (date ISO attendue)");
  if (!["cabinet", "teleconsultation"].includes(type)) throw new HttpError(400, "type doit être 'cabinet' ou 'teleconsultation'");

  const [praticien, patient] = await Promise.all([getPraticien(pid), patients.findOne({ _id: patId }, { projection: { _id: 1 } })]);
  if (!praticien) throw new HttpError(404, "praticien introuvable");
  if (!patient) throw new HttpError(404, "patient introuvable");
  if (debut <= new Date()) throw new HttpError(400, "impossible de réserver un créneau passé");
  if (!estUnCreneau(praticien, debut)) throw new HttpError(400, "ce créneau ne correspond pas aux horaires du praticien");
  if (type === "teleconsultation" && !praticien.teleconsultation) throw new HttpError(400, "ce praticien ne propose pas la téléconsultation");
  if (motif && praticien.motifs?.length && !praticien.motifs.includes(motif)) throw new HttpError(400, "motif non proposé par ce praticien");

  const fin = finDuCreneau(praticien, debut);
  const conflit = await rendezVous.findOne({ patient_id: patId, statut: { $in: STATUTS_ACTIFS }, debut: { $lt: fin }, fin: { $gt: debut } });
  if (conflit) throw new HttpError(409, "le patient a déjà un rendez-vous sur ce créneau");

  const doc = { praticien_id: pid, patient_id: patId, debut, fin, motif: motif || praticien.motifs?.[0] || "Consultation", type, statut: "confirme", cree_le: new Date() };
  try {
    const { insertedId } = await rendezVous.insertOne(doc);
    res.status(201).json({ _id: insertedId, ...doc });
  } catch (e) {
    if (e.code === 11000) throw new HttpError(409, "ce créneau vient d'être réservé");
    throw e;
  }
}));

// PATCH /rendez-vous/:id { statut?, motif? }  (ex. { "statut": "annule" })
app.patch("/rendez-vous/:id", route(async (req, res) => {
  const _id = oid(req.params.id);
  const maj = pick(req.body, ["statut", "motif"]);
  if (!Object.keys(maj).length) throw new HttpError(400, "seuls 'statut' et 'motif' sont modifiables");
  if (maj.statut && !STATUTS.includes(maj.statut)) throw new HttpError(400, `statut invalide (${STATUTS.join(", ")})`);
  try {
    const result = await rendezVous.findOneAndUpdate({ _id }, { $set: { ...maj, modifie_le: new Date() } }, { returnDocument: "after" });
    if (!result) throw new HttpError(404, "rendez-vous introuvable");
    res.json(result);
  } catch (e) {
    if (e.code === 11000) throw new HttpError(409, "le créneau a été repris entre-temps");
    throw e;
  }
}));

app.delete("/rendez-vous/:id", route(async (req, res) => {
  const { deletedCount } = await rendezVous.deleteOne({ _id: oid(req.params.id) });
  if (!deletedCount) throw new HttpError(404, "rendez-vous introuvable");
  res.status(204).end();
}));

// ---------- Statistiques ----------

// GET /stats?ville=&specialite=
app.get("/stats", route(async (req, res) => {
  const liste = (await tousLesPraticiens()).filter((p) =>
    (!req.query.ville || p.adresse?.ville === req.query.ville) && (!req.query.specialite || p.specialite === req.query.specialite));
  const parId = new Map(liste.map((p) => [String(p._id), p]));
  const tz = "Europe/Paris";
  const now = new Date();
  const dans7j = new Date(now.getTime() + 7 * JOUR);

  const [f] = await rendezVous.aggregate([
    { $match: { praticien_id: { $in: liste.map((p) => p._id) } } },
    { $facet: {
      parPraticienStatut: [{ $group: { _id: { p: "$praticien_id", s: "$statut" }, n: { $sum: 1 } } }],
      parJour: [{ $group: { _id: { j: { $dateToString: { date: "$debut", format: "%Y-%m-%d", timezone: tz } }, s: "$statut" }, n: { $sum: 1 } } }],
      parHeure: [{ $match: { statut: { $ne: "annule" } } }, { $group: { _id: { $hour: { date: "$debut", timezone: tz } }, n: { $sum: 1 } } }],
      parType: [{ $group: { _id: "$type", n: { $sum: 1 } } }],
      parMotif: [{ $group: { _id: "$motif", n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 8 }],
      delai: [{ $match: { statut: { $ne: "annule" } } },
        { $group: { _id: null, moyen: { $avg: { $subtract: ["$debut", "$cree_le"] } } } }],
      sept: [{ $match: { debut: { $gte: now, $lt: dans7j }, statut: { $in: STATUTS_ACTIFS } } }, { $group: { _id: "$praticien_id", n: { $sum: 1 } } }],
      patientsActifs: [{ $group: { _id: "$patient_id" } }, { $count: "n" }],
    } },
  ]).toArray();

  const compte = Object.fromEntries(STATUTS.map((s) => [s, 0]));
  const parSpe = new Map(), parVille = new Map(), parPrat = new Map();
  for (const { _id, n } of f.parPraticienStatut) {
    const p = parId.get(String(_id.p));
    if (!p) continue;
    compte[_id.s] += n;
    for (const [map, k] of [[parSpe, p.specialite], [parVille, p.adresse.ville], [parPrat, String(p._id)]]) {
      if (!map.has(k)) map.set(k, Object.fromEntries(STATUTS.map((s) => [s, 0])));
      map.get(k)[_id.s] += n;
    }
  }
  const total = STATUTS.reduce((a, s) => a + compte[s], 0);

  // Taux de remplissage à 7 jours : créneaux réservés / créneaux ouverts
  const reserves7 = new Map(f.sept.map((x) => [String(x._id), x.n]));
  const remplissage = new Map();
  for (const p of liste) {
    let ouverts = 0;
    for (let i = 0; i < 8; i++) {
      const jour = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      ouverts += creneauxDuJour(p, jour).filter((c) => c > now && c < dans7j).length;
    }
    const r = remplissage.get(p.specialite) ?? { ouverts: 0, reserves: 0 };
    r.ouverts += ouverts;
    r.reserves += reserves7.get(String(p._id)) ?? 0;
    remplissage.set(p.specialite, r);
  }

  const jours = new Map();
  for (const { _id, n } of f.parJour) {
    if (!jours.has(_id.j)) jours.set(_id.j, Object.fromEntries(STATUTS.map((s) => [s, 0])));
    jours.get(_id.j)[_id.s] = n;
  }
  const tele = f.parType.find((t) => t._id === "teleconsultation")?.n ?? 0;
  const nbPatients = await patients.estimatedDocumentCount();

  res.json({
    genere_le: now,
    totaux: {
      praticiens: liste.length,
      patients: nbPatients,
      patients_actifs: f.patientsActifs[0]?.n ?? 0,
      rendez_vous: total,
      a_venir: compte.confirme,
      honores: compte.honore,
      taux_annulation: total ? compte.annule / total : 0,
      taux_absence: compte.honore + compte.absent ? compte.absent / (compte.honore + compte.absent) : 0,
      part_teleconsultation: total ? tele / total : 0,
      delai_moyen_jours: f.delai[0] ? f.delai[0].moyen / JOUR : null,
    },
    par_statut: compte,
    par_jour: [...jours.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, c]) => ({ date, ...c })),
    par_heure: f.parHeure.map((h) => ({ heure: h._id, rendez_vous: h.n })).sort((a, b) => a.heure - b.heure),
    par_specialite: [...parSpe.entries()].map(([specialite, c]) => {
      const ps = liste.filter((p) => p.specialite === specialite);
      const r = remplissage.get(specialite);
      return {
        specialite, ...c,
        total: STATUTS.reduce((a, s) => a + c[s], 0),
        praticiens: ps.length,
        tarif_moyen: ps.reduce((a, p) => a + (p.tarif_consultation ?? 0), 0) / ps.length,
        remplissage_7j: r && r.ouverts ? r.reserves / r.ouverts : 0,
      };
    }).sort((a, b) => b.total - a.total),
    par_ville: [...parVille.entries()].map(([ville, c]) => ({
      ville, total: STATUTS.reduce((a, s) => a + c[s], 0), praticiens: liste.filter((p) => p.adresse.ville === ville).length,
    })).sort((a, b) => b.total - a.total),
    par_motif: f.parMotif.map((m) => ({ motif: m._id, rendez_vous: m.n })),
    top_praticiens: [...parPrat.entries()].map(([id, c]) => {
      const p = parId.get(id);
      return { _id: id, nom: `${p.civilite} ${p.prenom} ${p.nom}`, specialite: p.specialite, ville: p.adresse.ville,
        rendez_vous: c.honore + c.confirme, taux_annulation: (c.annule) / (c.honore + c.confirme + c.absent + c.annule || 1) };
    }).sort((a, b) => b.rendez_vous - a.rendez_vous).slice(0, 10),
  });
}));

// ---------- Erreurs ----------

app.use((req, res) => res.status(404).json({ erreur: "route introuvable" }));
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ erreur: err.message });
  if (err.type === "entity.parse.failed") return res.status(400).json({ erreur: "JSON invalide" });
  if (err.code === 11000) return res.status(409).json({ erreur: "cette ressource existe déjà (doublon)", champs: err.keyValue });
  console.error(err);
  res.status(500).json({ erreur: "erreur serveur" });
});

app.listen(PORT, () => console.log(`API lancée sur http://localhost:${PORT}`));
