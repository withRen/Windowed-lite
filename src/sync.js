// Transforme les reglages (storage.sync) en scripts enregistres.
// Appele par bg.js a l'installation / au demarrage, et par la popup a chaque
// changement. Rien ne tourne pendant la navigation : les pages recoivent
// leurs reglages sous forme d'un petit fichier cfg/*.js injecte directement.
//
// Cles de stockage (compatibles avec l'ancien Windowed) :
//   mode(*), pip(*)            reglage par defaut
//   mode(<host>), pip(<host>)  reglage d'un site
const api = globalThis.browser ?? globalThis.chrome;

export const MODES = ["ask", "in-window", "fullscreen"];
const clean = (m) => (m === "windowed" ? "in-window" : MODES.includes(m) ? m : undefined);
export const combo = (mode, pip) => `${mode}${pip ? "-pip" : ""}`;
const pattern = (host) => `*://${host.replace(/:\d+$/, "")}/*`;

export async function readSettings() {
  const all = (await api.storage.sync.get(null)) ?? {};
  const def = { mode: clean(all["mode(*)"]) ?? "ask", pip: all["pip(*)"] === true };
  const sites = new Map();
  for (const [k, v] of Object.entries(all)) {
    const m = /^(mode|pip)\((.+)\)$/.exec(k);
    if (!m || m[2] === "*") continue;
    const site = sites.get(m[2]) ?? {};
    if (m[1] === "mode") site.mode = clean(v);
    else site.pip = v === true;
    sites.set(m[2], site);
  }
  return { def, sites };
}

export async function sync() {
  const { def, sites } = await readSettings();
  const defCombo = combo(def.mode, def.pip);

  // Sites regroupes par reglage effectif, seulement s'il differe du defaut.
  const groups = new Map();
  for (const [host, s] of sites) {
    const c = combo(s.mode ?? def.mode, s.pip ?? def.pip);
    if (c === defCombo) continue;
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(pattern(host));
  }

  const base = { runAt: "document_start", allFrames: true, world: "MAIN", persistAcrossSessions: true };
  const scripts = [];
  for (const [c, matches] of groups) {
    scripts.push({ ...base, id: `wl-${c}`, matches, js: [`cfg/${c}.js`] });
  }
  // Le defaut "ask" sans PiP est deja celui de page.js : aucun script a ajouter.
  if (defCombo !== "ask") {
    const excludeMatches = [...groups.values()].flat();
    scripts.push({ ...base, id: "wl-default", matches: ["<all_urls>"], excludeMatches, js: [`cfg/${defCombo}.js`] });
  }

  const old = (await api.scripting.getRegisteredContentScripts()).map((s) => s.id).filter((id) => id.startsWith("wl-"));
  if (old.length) await api.scripting.unregisterContentScripts({ ids: old });
  if (scripts.length) await api.scripting.registerContentScripts(scripts);
  return scripts.length;
}
