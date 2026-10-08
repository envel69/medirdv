// Diffuseur Server-Sent Events des changements de créneaux (équivalent de SlotEvents.java du TP).
//
// Contrat du flux GET /creneaux/events (text/event-stream) :
//   event: ready         data: {"action":"reload"}                                  à chaque (re)connexion
//   event: slot-updated  data: {"slotId","praticienId","debut","status","version"}   après chaque écriture réussie
//   : keepalive                                                                      toutes les 15 s
// Aucune donnée personnelle n'est diffusée (ni patient, ni identifiant de rendez-vous).

export function creerDiffuseur({ heartbeatMs = 15000, retryMs = 3000 } = {}) {
  const clients = new Set(); // réponses HTTP ouvertes (un Set suffit : Node est mono-thread)
  let sequence = 0;          // identifiant d'événement local, croissant

  function retirer(res) {
    clients.delete(res);
  }

  // Écriture isolée : un client parti est retiré sans affecter les autres ni l'opération métier
  function ecrire(res, chunk) {
    if (res.destroyed || res.writableEnded) { retirer(res); return; }
    try {
      res.write(chunk);
    } catch {
      retirer(res);
    }
  }

  const message = (nom, data, id) => `id: ${id}\nevent: ${nom}\ndata: ${JSON.stringify(data)}\n\n`;

  function abonner(req, res) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // pas de mise en tampon par un éventuel proxy nginx
    });
    res.write(`retry: ${retryMs}\n\n`); // délai de reconnexion conseillé au navigateur
    clients.add(res);
    // Nettoyage : fermeture par le client (onglet fermé, rechargé, coupure) ou erreur réseau
    req.on("close", () => retirer(res));
    res.on("error", () => retirer(res));
    // ready : le client doit relire l'état courant (rattrape ce qui a changé pendant une coupure)
    ecrire(res, message("ready", { action: "reload" }, ++sequence));
  }

  function diffuser(nom, data) {
    const chunk = message(nom, data, ++sequence);
    for (const res of clients) ecrire(res, chunk);
    return sequence;
  }

  // Un créneau a changé : statut BOOKED (pris), AVAILABLE (libéré) ou UPDATED (agenda du praticien modifié)
  function creneauModifie({ praticienId, debut = null, status }) {
    const version = sequence + 1;
    const d = debut ? new Date(debut).toISOString() : null;
    return diffuser("slot-updated", {
      slotId: d ? `${praticienId}_${d}` : String(praticienId),
      praticienId: String(praticienId),
      debut: d,
      status,
      version,
    });
  }

  // Signal périodique : commentaire SSE qui garde la connexion ouverte à travers les proxys
  const heartbeat = setInterval(() => {
    for (const res of clients) ecrire(res, ": keepalive\n\n");
  }, heartbeatMs);
  heartbeat.unref();

  return {
    abonner,
    creneauModifie,
    connexions: () => clients.size,
    fermer() {
      clearInterval(heartbeat);
      for (const res of clients) res.end();
      clients.clear();
    },
  };
}
