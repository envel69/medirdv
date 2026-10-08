// Surveillance de la charge de l'API sur une fenêtre glissante.
// Quand la charge dépasse un seuil (débit ou latence p95), appelle `onDepassement` (au plus une fois par période de répit).

export function creerMoniteurCharge({
  fenetreMs = 60000,
  maxRps = 40,
  maxP95Ms = 1000,
  minRequetes = 100,   // évite de conclure sur trop peu de requêtes
  repitMs = 30 * 60000, // délai minimal entre deux déclenchements
  intervalleMs = 5000,
  ignorer = () => false,
  onDepassement,
}) {
  const mesures = []; // { t: fin de la requête, d: durée en ms }
  const etat = {
    niveau: "normal",
    depuis: new Date(),
    dernier_declenchement: null,
    declenchements: 0,
  };

  function middleware(req, res, next) {
    if (ignorer(req)) return next();
    const debut = performance.now();
    res.on("finish", () => mesures.push({ t: Date.now(), d: performance.now() - debut }));
    next();
  }

  function instantane() {
    const limite = Date.now() - fenetreMs;
    while (mesures.length && mesures[0].t < limite) mesures.shift();
    const n = mesures.length;
    const durees = mesures.map((m) => m.d).sort((a, b) => a - b);
    const p95 = n ? durees[Math.min(n - 1, Math.ceil(n * 0.95) - 1)] : 0;
    return {
      fenetre_s: fenetreMs / 1000,
      requetes: n,
      rps: n / (fenetreMs / 1000),
      p95_ms: p95,
      seuils: { max_rps: maxRps, max_p95_ms: maxP95Ms, min_requetes: minRequetes, repit_min: repitMs / 60000 },
    };
  }

  async function evaluer() {
    const m = instantane();
    const raisons = [];
    if (m.requetes >= minRequetes) {
      if (m.rps > maxRps) raisons.push(`débit ${m.rps.toFixed(1)} req/s > ${maxRps}`);
      if (m.p95_ms > maxP95Ms) raisons.push(`p95 ${Math.round(m.p95_ms)} ms > ${maxP95Ms} ms`);
    }
    const niveau = raisons.length ? "elevee" : "normal";
    if (niveau !== etat.niveau) { etat.niveau = niveau; etat.depuis = new Date(); }
    if (!raisons.length) return;

    const dernier = etat.dernier_declenchement && new Date(etat.dernier_declenchement.date).getTime();
    if (dernier && Date.now() - dernier < repitMs) return; // déjà déclenché récemment

    const declenchement = { date: new Date().toISOString(), raisons, mesures: m, resultat: "en cours" };
    etat.dernier_declenchement = declenchement;
    etat.declenchements++;
    try {
      const r = await onDepassement(declenchement);
      declenchement.resultat = r.ok ? "ok" : "echec";
      declenchement.message = r.message;
    } catch (e) {
      declenchement.resultat = "echec";
      declenchement.message = e.message;
    }
    console.warn(`[charge] ${raisons.join(", ")} → ${declenchement.message}`);
  }

  let timer = null;
  return {
    middleware,
    demarrer() { timer = setInterval(() => evaluer().catch(console.error), intervalleMs); timer.unref(); },
    arreter() { clearInterval(timer); },
    etat: () => ({ ...etat, mesures: instantane() }),
  };
}
