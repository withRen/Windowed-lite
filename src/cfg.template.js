// Modele des fichiers cfg/*.js (genere par build.mjs, un par reglage).
// Pose le reglage pour page.js, qu'il passe avant ou apres lui.
(() => {
  const c = __CFG__;
  window.__wlCfg = c;
  const send = () => document.dispatchEvent(new CustomEvent("windowed-lite:config", { detail: c }));
  document.addEventListener("windowed-lite:ping", send);
  send();
})();
