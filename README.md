# MédiRDV

[![CI/CD](https://github.com/envel69/medirdv/actions/workflows/ci.yml/badge.svg)](https://github.com/envel69/medirdv/actions/workflows/ci.yml)
[![Baromètre W/L](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/envel69/medirdv/barometre/barometre.json)](https://github.com/envel69/medirdv/actions/workflows/ci.yml)

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

## Tests

```bash
npm test          # tests d'intégration (l'API doit tourner)
npm run perf      # test de charge k6 (seuils de lenteur)
npm run perf:rapport
```

## CI/CD (GitHub Actions)

Le workflow [`.github/workflows/ci.yml`](.github/workflows/ci.yml) s'exécute à chaque push sur `main`, sur chaque pull request, **tous les jours à 5 h UTC**, à la demande, et **automatiquement quand l'API détecte une charge trop haute** :

1. **Tests de l'API** : MongoDB jetable dans le runner, génération des données, tests d'intégration.
2. **Tests de lenteur (k6)** : test de charge avec seuils (p95 par route, taux d'erreur, course au créneau).
   - Rapport dans le résumé de l'exécution + rapport HTML k6 en artefact.
   - **Seuil dépassé → une issue GitHub `lenteur` est ouverte** (ou commentée si elle existe déjà).
   - **Seuils de nouveau respectés sur `main` → l'issue est fermée automatiquement.**

3. **Livraison (CD)** — uniquement après un push vert sur `main` : construction de l'image Docker, test de fumée (`/sante`), publication sur `ghcr.io/envel69/medirdv` (`latest` + SHA du commit).
4. **Baromètre W/L** — compte les réussites (W) et échecs (L) des exécutions sur `main`, publie le badge ci-dessus (branche `barometre`) et un résumé dans l'exécution. Aussi visible dans le tableau de bord (`/dashboard.html`).
5. **Alerte charge élevée** — quand le workflow est lancé par l'API, ouvre (ou commente) une issue `charge` avec les mesures.

Pour vérifier l'alerte de lenteur : *Actions → CI/CD → Run workflow* avec `latence_simulee_ms = 600`.

```bash
docker pull ghcr.io/envel69/medirdv:latest
docker run -p 3001:3001 -e MONGODB_URI="mongodb+srv://..." ghcr.io/envel69/medirdv:latest
```

## Surveillance de charge → GitHub Actions

L'API mesure en continu son débit et sa latence p95 sur une fenêtre glissante de 60 s (`GET /monitoring`).
Si `débit > CHARGE_MAX_RPS` ou `p95 > CHARGE_MAX_P95_MS` (avec au moins `CHARGE_MIN_REQUETES` requêtes), elle **lance le workflow** via l'API GitHub
(`declencheur = charge`) : issue `charge` + tests + tests de lenteur. Un délai de `CHARGE_REPIT_MIN` minutes évite de relancer en boucle.

Configuration dans `.env` (voir `.env.example`) : `GITHUB_TOKEN` = token GitHub *fine-grained* limité à ce dépôt avec la permission **Actions : Read and write**.

Seuils (dans `k6/load-test.js`) :

| Indicateur | Seuil |
|---|---|
| Recherche + disponibilités | p95 < 500 ms |
| `POST /rendez-vous` | p95 < 800 ms |
| `GET /stats` | p95 < 1,5 s |
| Erreurs HTTP | < 1 % |
| Course au créneau (20 réservations simultanées) | exactement 1 réussite |
