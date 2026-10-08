// Calcul des créneaux à partir des horaires d'un praticien (heure locale du serveur)
// horaires = { jours: [1..6] (1 = lundi), plages: [{ debut: "09:00", fin: "12:00" }, ...] }

const MINUTE = 60 * 1000;

function hm(str) {
  const [h, m] = str.split(":").map(Number);
  return { h, m };
}

// "2026-10-08" -> Date à minuit local
export function parseJour(str) {
  const [y, mo, d] = str.split("-").map(Number);
  return new Date(y, mo - 1, d);
}

export function formatJour(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

// getDay() : 0 = dimanche ; on veut 1 = lundi ... 7 = dimanche
const jourSemaine = (date) => date.getDay() || 7;

export function creneauxDuJour(praticien, jour) {
  const { horaires, duree_rdv_min } = praticien;
  if (!horaires.jours.includes(jourSemaine(jour))) return [];
  const res = [];
  for (const plage of horaires.plages) {
    const a = hm(plage.debut), b = hm(plage.fin);
    const debut = new Date(jour.getFullYear(), jour.getMonth(), jour.getDate(), a.h, a.m);
    const fin = new Date(jour.getFullYear(), jour.getMonth(), jour.getDate(), b.h, b.m);
    for (let t = debut.getTime(); t + duree_rdv_min * MINUTE <= fin.getTime(); t += duree_rdv_min * MINUTE) {
      res.push(new Date(t));
    }
  }
  return res;
}

export function estUnCreneau(praticien, date) {
  const jour = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return creneauxDuJour(praticien, jour).some((c) => c.getTime() === date.getTime());
}

export function finDuCreneau(praticien, debut) {
  return new Date(debut.getTime() + praticien.duree_rdv_min * MINUTE);
}
