// Tests unitaires du calcul du baromètre W/L (sans réseau)
import { test } from "node:test";
import assert from "node:assert/strict";
import { calculerBarometre } from "../lib/github.js";

const run = (id, conclusion, minutesAvant, duree = 120) => {
  const debut = new Date(Date.UTC(2026, 9, 8, 12, 0) - minutesAvant * 60000);
  return { id, run_number: id, conclusion, event: "push", head_sha: "abcdef0123", display_title: `run ${id}`, html_url: `https://x/${id}`,
    run_started_at: debut.toISOString(), updated_at: new Date(debut.getTime() + duree * 1000).toISOString() };
};

test("compte W/L, ignore les annulations et calcule le taux", () => {
  const b = calculerBarometre([run(1, "success", 50), run(2, "failure", 40), run(3, "cancelled", 30), run(4, "success", 20), run(5, "timed_out", 10)]);
  assert.equal(b.victoires, 2);
  assert.equal(b.defaites, 2);
  assert.equal(b.ignorees, 1);
  assert.equal(b.taux_reussite, 0.5);
});

test("série en cours depuis la plus récente exécution", () => {
  const b = calculerBarometre([run(1, "failure", 40), run(2, "success", 30), run(3, "cancelled", 20), run(4, "success", 10), run(5, "success", 5)]);
  assert.deepEqual(b.serie, { type: "W", longueur: 3 });
  assert.equal(b.historique[0].id, 5, "historique trié du plus récent au plus ancien");
});

test("durée moyenne et cas sans exécution", () => {
  assert.equal(calculerBarometre([run(1, "success", 10, 60), run(2, "failure", 5, 180)]).duree_moyenne_s, 120);
  const vide = calculerBarometre([]);
  assert.equal(vide.taux_reussite, null);
  assert.equal(vide.serie, null);
});
