import { readSettings } from "./sync.js";

const api = globalThis.browser ?? globalThis.chrome;
const $ = (s) => document.querySelector(s);

let host = null;
let tabId = null;
const key = (kind, scope) => `${kind}(${scope === "all" ? "*" : host})`;

const render = async () => {
  const { def, sites } = await readSettings();
  const site = (host && sites.get(host)) || {};
  for (const seg of document.querySelectorAll(".seg")) {
    const mode = seg.dataset.scope === "all" ? def.mode : site.mode ?? def.mode;
    for (const b of seg.children) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
  }
  $('[data-pip="all"]').checked = def.pip;
  if (host) {
    $('[data-pip="site"]').checked = site.pip ?? def.pip;
    $("#reset").hidden = site.mode === undefined && site.pip === undefined;
  }
  return { mode: site.mode ?? def.mode, pip: site.pip ?? def.pip };
};

// Enregistre (bg.js regenere les scripts) et applique tout de suite a
// l'onglet ouvert ; les autres onglets le prennent a leur prochain chargement.
const apply = async (change) => {
  await change();
  const cfg = await render();
  if (tabId == null) return;
  try {
    await api.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      args: [JSON.stringify(cfg)],
      func: (c) => document.dispatchEvent(new CustomEvent("windowed-lite:config", { detail: c })),
    });
  } catch {}
  showStatus();
};

document.addEventListener("click", (e) => {
  const b = e.target.closest(".seg button");
  if (b) apply(() => api.storage.sync.set({ [key("mode", b.parentElement.dataset.scope)]: b.dataset.mode }));
  if (e.target.id === "reset" && host) apply(() => api.storage.sync.remove([key("mode", "site"), key("pip", "site")]));
});
document.addEventListener("change", (e) => {
  const scope = e.target.dataset.pip;
  if (scope) apply(() => api.storage.sync.set({ [key("pip", scope)]: e.target.checked }));
});

// Etat du script sur la page, lu seulement a l'ouverture de la popup.
async function showStatus() {
  const el = $("#status");
  try {
    const [res] = await api.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const d = window.__wlDiag;
        return d ? { intercepted: d.intercepted, mode: d.mode, anim: d.anim } : null;
      },
    });
    const d = res?.result;
    el.textContent = d
      ? `Actif - mode ${d.mode} - ${d.intercepted} intercepte(s)` +
        (d.anim ? ` - derniere animation : ${d.anim}` : "")
      : "Script absent de la page : recharge-la.";
  } catch {
    el.textContent = "Impossible de lire l'etat de cet onglet.";
  }
}

(async () => {
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab?.url ?? "");
    if (url.protocol.startsWith("http")) {
      host = url.hostname;
      tabId = tab.id;
      $("#host").textContent = host;
      $("#site").hidden = false;
      showStatus();
    }
  } catch {}
  render();
})();
