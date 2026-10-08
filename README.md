# MédiRDV

[![CI](https://github.com/envel69/medirdv/actions/workflows/ci.yml/badge.svg)](https://github.com/envel69/medirdv/actions/workflows/ci.yml)

Clone simplifié de Doctolib : recherche de praticiens, disponibilités en temps réel, prise et annulation de rendez-vous, tableau de bord statistique.
Stack : **Node.js / Express 5 / MongoDB**, front en HTML/CSS/JS sans framework, tests de charge **k6**.

> Toutes les données sont fictives (générées par `seed.js`).

## Démarrer en local

```bash
npm install
cp .env.example .env      # puis renseigner MONGODB_URI
npm run seed              # ⚠ vide puis recrée les collections praticiens, patients, rendez_vous
npm start                 # http://localhost:3001
```

- Prise de rendez-vous : http://localhost:3001/
- Statistiques : http://localhost:3001/dashboard.html

## API

| Méthode | Route | Description |
|---|---|---|
| GET | `/praticiens?specialite=&ville=&teleconsultation=&q=` | Liste paginée (`page`, `limit`) |
| GET/POST/PUT/PATCH/DELETE | `/praticiens[/:id]` | CRUD praticiens |
| GET | `/praticiens/:id/disponibilites?debut=AAAA-MM-JJ&jours=7` | Créneaux libres |
| GET/POST/PUT/PATCH/DELETE | `/patients[/:id]` | CRUD patients (e-mail unique → 409) |
| GET | `/rendez-vous?patient_id=&praticien_id=&statut=&du=&au=&details=true` | Liste (jointures avec `details=true`) |
| POST | `/rendez-vous` | Réserver `{ praticien_id, patient_id, debut, motif?, type? }` |
| PATCH | `/rendez-vous/:id` | Modifier `statut` (ex. `annule`) ou `motif` |
| DELETE | `/rendez-vous/:id` | Supprimer |
| GET | `/stats?ville=&specialite=` | Indicateurs du tableau de bord |

La double réservation d'un créneau est empêchée par un **index unique partiel** MongoDB (`praticien_id + debut`, hors rendez-vous annulés).

## Temps réel (SSE) — TP « Synchroniser deux écrans »

Quand un patient réserve ou annule, **les autres écrans se mettent à jour sans rechargement** : agendas des praticiens,
« Mes rendez-vous », tableau de bord. Diffuseur : [`lib/sse.js`](lib/sse.js) ; client : fin de [`public/index.html`](public/index.html).

Flux `GET /creneaux/events` (`text/event-stream`) :

```
retry: 3000

id: 1
event: ready
data: {"action":"reload"}

id: 2
event: slot-updated
data: {"slotId":"<praticien>_<début>","praticienId":"…","debut":"2026-10-12T08:20:00.000Z","status":"BOOKED","version":2}

: keepalive
```

| Élément | Comportement |
|---|---|
| `ready` | envoyé à chaque (re)connexion → le client relit l'état courant (c'est ce qui rattrape une coupure : pas de replay) |
| `slot-updated` | après chaque écriture réussie : réservation (`BOOKED`), annulation ou suppression (`AVAILABLE`), agenda modifié (`UPDATED`) |
| Confidentialité | ni patient, ni identifiant de rendez-vous dans le flux ; seule la réponse du `POST` confirme une réservation |
| Nettoyage | client retiré à la fermeture de la connexion (`req.on("close")`) ou en cas d'erreur d'écriture, sans affecter la réservation |
| Keepalive | commentaire `: keepalive` toutes les 15 s |
| Client | un seul `EventSource` ; `onerror` → « Connexion interrompue » **sans `close()`** (reconnexion automatique) ; fermeture et arrêt des minuteurs à `pagehide` (drapeau `stopped`) ; relecture de sécurité toutes les 30 s |
| Conflit en direct | si le créneau ouvert dans la fenêtre de réservation est pris ailleurs, la fenêtre l'indique et désactive « Confirmer » |
| Diagnostic | `GET /creneaux/events/count` → nombre de connexions ouvertes |

Observer le flux : `curl.exe -N http://localhost:3001/creneaux/events`, puis réserver depuis le navigateur.

## Tests

```bash
npm test          # tests d'intégration (l'API doit tourner)
npm run perf      # test de charge k6 (seuils de lenteur)
npm run perf:rapport
```

## Intégration continue (GitHub Actions)

Le workflow [`.github/workflows/ci.yml`](.github/workflows/ci.yml) s'exécute à chaque push sur `main`, sur chaque pull request, **tous les jours à 5 h UTC** et à la demande :

1. **Tests de l'API** : MongoDB jetable dans le runner, génération des données, tests d'intégration.
2. **Tests de lenteur (k6)** : test de charge avec seuils (p95 par route, taux d'erreur, course au créneau).
   - Rapport dans le résumé de l'exécution + rapport HTML k6 en artefact.
   - **Seuil dépassé → une issue GitHub `lenteur` est ouverte** (ou commentée si elle existe déjà).
   - **Seuils de nouveau respectés sur `main` → l'issue est fermée automatiquement.**

Pour vérifier l'alerte : *Actions → CI → Run workflow* avec `latence_simulee_ms = 600`.

Seuils (dans `k6/load-test.js`) :

| Indicateur | Seuil |
|---|---|
| Recherche + disponibilités | p95 < 500 ms |
| `POST /rendez-vous` | p95 < 800 ms |
| `GET /stats` | p95 < 1,5 s |
| Erreurs HTTP | < 1 % |
| Course au créneau (20 réservations simultanées) | exactement 1 réussite |
