// Appels à l'API GitHub : déclenchement du workflow et historique des exécutions (baromètre W/L)

const API = "https://api.github.com";

function entetes(token) {
  const h = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "medirdv" };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

// Lance le workflow (workflow_dispatch). Le token doit avoir la permission « Actions : lecture et écriture ».
export async function declencherWorkflow({ token, repo, workflow = "ci.yml", ref = "main", inputs = {} }) {
  if (!token) return { ok: false, message: "GITHUB_TOKEN absent : déclenchement impossible" };
  if (!repo) return { ok: false, message: "GITHUB_REPO absent" };
  const res = await fetch(`${API}/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    headers: { ...entetes(token), "Content-Type": "application/json" },
    body: JSON.stringify({ ref, inputs }),
  });
  if (res.status === 204) return { ok: true, message: `workflow ${workflow} déclenché sur ${ref}` };
  const corps = await res.text();
  let detail = corps.slice(0, 200);
  try { detail = JSON.parse(corps).message ?? detail; } catch {}
  return { ok: false, message: `GitHub a répondu ${res.status} : ${detail}` };
}

// Dernières exécutions terminées du workflow sur la branche principale
export async function chargerExecutions({ token, repo, workflow = "ci.yml", branche = "main", n = 30 }) {
  const url = `${API}/repos/${repo}/actions/workflows/${workflow}/runs?branch=${branche}&status=completed&per_page=${n}`;
  const res = await fetch(url, { headers: entetes(token) });
  if (!res.ok) throw new Error(`GitHub a répondu ${res.status}`);
  return (await res.json()).workflow_runs;
}

const VICTOIRES = new Set(["success"]);
const DEFAITES = new Set(["failure", "timed_out", "startup_failure"]);

// Baromètre W/L : W = pipeline réussi, L = pipeline en échec (les exécutions annulées ne comptent pas)
export function calculerBarometre(runs) {
  const historique = runs
    .map((r) => ({
      id: r.id,
      numero: r.run_number,
      resultat: VICTOIRES.has(r.conclusion) ? "W" : DEFAITES.has(r.conclusion) ? "L" : "-",
      conclusion: r.conclusion,
      evenement: r.event,
      sha: r.head_sha?.slice(0, 7),
      titre: r.display_title,
      url: r.html_url,
      date: r.run_started_at || r.created_at,
      duree_s: r.run_started_at && r.updated_at ? Math.round((new Date(r.updated_at) - new Date(r.run_started_at)) / 1000) : null,
    }))
    .sort((a, b) => new Date(b.date) - new Date(a.date)); // plus récent d'abord

  const comptees = historique.filter((h) => h.resultat !== "-");
  const victoires = comptees.filter((h) => h.resultat === "W").length;
  const defaites = comptees.length - victoires;
  let serie = null;
  if (comptees.length) {
    const type = comptees[0].resultat;
    let longueur = 0;
    while (longueur < comptees.length && comptees[longueur].resultat === type) longueur++;
    serie = { type, longueur };
  }
  const durees = comptees.map((h) => h.duree_s).filter((d) => d != null);
  return {
    victoires,
    defaites,
    ignorees: historique.length - comptees.length,
    taux_reussite: comptees.length ? victoires / comptees.length : null,
    serie,
    duree_moyenne_s: durees.length ? Math.round(durees.reduce((a, b) => a + b, 0) / durees.length) : null,
    historique,
  };
}
