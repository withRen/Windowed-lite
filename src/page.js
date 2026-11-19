// Windowed Lite - script injecte dans le "MAIN world" de chaque frame.
// Objectif : ne rien faire tant que la page ne demande pas le plein ecran.
// Aucun timer, aucun MutationObserver, aucun message envoye au chargement,
// aucune lecture de reglages : ils arrivent par un petit script cfg/*.js
// enregistre par sync.js pour les sites concernes (voir sync.js).
(() => {
  "use strict";
  // Si ce script tourne dans le monde isole de l'extension (le navigateur a
  // ignore "world": "MAIN"), patcher Element.prototype ici n'aurait aucun
  // effet sur la page. On se re-injecte alors dans la vraie page.
  const ext = globalThis.browser ?? globalThis.chrome;
  let isolated = false;
  try { isolated = !!ext?.runtime?.id; } catch {}
  if (isolated) {
    const s = document.createElement("script");
    s.src = ext.runtime.getURL("page.js");
    s.onload = s.onerror = () => s.remove();
    (document.head || document.documentElement).append(s);
    return;
  }
  if (window.__windowedLite) return;
  window.__windowedLite = true;

  const EP = Element.prototype;
  const DP = Document.prototype;
  const TAG = "__windowed";
  const isTop = window.top === window;

  // Reglages : "ask" sans PiP par defaut. Un script cfg/*.js passe avant
  // (window.__wlCfg) ou apres (evenement "windowed-lite:config").
  let cfg = { mode: "ask", pip: false };
  const setCfg = (json) => { try { cfg = JSON.parse(json); } catch {} };
  if (typeof window.__wlCfg === "string") setCfg(window.__wlCfg);
  let shift = false;

  // Etat du mode "in-window"
  let active = null; // element actuellement "plein ecran" dans l'onglet
  let restore = null; // fonction pour tout remettre comme avant
  let chooser = null;

  // ---------- utilitaires ----------
  const pick = (proto, names) => {
    for (const n of names) if (typeof proto[n] === "function") return proto[n];
    return null;
  };
  const nativeRequest = pick(EP, ["requestFullscreen", "webkitRequestFullscreen", "webkitRequestFullScreen"]);
  const nativeExit = pick(DP, ["exitFullscreen", "webkitExitFullscreen", "webkitCancelFullScreen"]);
  if (!nativeRequest) return;

  // Le vrai document.fullscreenElement, meme quand on le falsifie.
  const nativeGetters = ["fullscreenElement", "webkitFullscreenElement", "webkitCurrentFullScreenElement"]
    .map((k) => Object.getOwnPropertyDescriptor(DP, k)?.get).filter(Boolean);
  const realFullscreenElement = () => {
    for (const g of nativeGetters) { const v = g.call(document); if (v) return v; }
    return null;
  };

  // Diagnostic lu par la popup (scripting.executeScript), uniquement quand
  // on l'ouvre. Non enumerable pour rester discret.
  const diag = { intercepted: 0, bypassed: 0, anim: "", get mode() { return cfg.mode; } };
  Object.defineProperty(window, "__wlDiag", { value: diag });

  const fire = (target) => {
    for (const type of ["fullscreenchange", "webkitfullscreenchange"]) {
      target.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
    }
    window.dispatchEvent(new Event("resize"));
  };

  // Faux document.fullscreenElement / screen.width pendant le mode in-window
  // (YouTube et d'autres lecteurs verifient ces valeurs).
  const spoof = (el) => {
    const d = { configurable: true, get: () => el };
    const t = { configurable: true, get: () => true };
    for (const k of ["fullscreenElement", "webkitFullscreenElement", "webkitCurrentFullScreenElement"]) {
      try { Object.defineProperty(document, k, d); } catch {}
    }
    for (const k of ["fullscreen", "webkitIsFullScreen"]) {
      try { Object.defineProperty(document, k, t); } catch {}
    }
    try { Object.defineProperty(screen, "width", { configurable: true, get: () => innerWidth }); } catch {}
    try { Object.defineProperty(screen, "height", { configurable: true, get: () => innerHeight }); } catch {}
  };
  const unspoof = () => {
    for (const k of ["fullscreenElement", "webkitFullscreenElement", "webkitCurrentFullScreenElement",
      "fullscreen", "webkitIsFullScreen"]) delete document[k];
    delete screen.width;
    delete screen.height;
  };

  // ---------- mode in-window ----------
  // Le coeur de l'optimisation : au lieu de marquer chaque parent avec
  // "all: initial" et de surveiller le DOM (version originale), on place
  // l'element dans le "top layer" du navigateur via l'API Popover.
  // Il echappe ainsi a tous les overflow/transform/z-index de ses parents,
  // sans toucher au reste de la page.
  const STYLE = {
    position: "fixed", inset: "0", width: "100%", height: "100%",
    "max-width": "none", "max-height": "none", margin: "0", padding: "0",
    border: "0", transform: "none", background: "#000", overflow: "hidden",
  };

  // Animation d'entree : un vrai zoom continu de la video.
  // YouTube ne met pas son lecteur en plein ecran mais toute l'appli
  // (ytd-app), qui fait deja presque la taille de la page : on anime donc a
  // partir de la VIDEO. L'element est transforme pour que sa video (a sa
  // place finale) se superpose a la video d'origine, puis revient a la normale.
  //
  // Seulement translate + scale : WebKit confie ces proprietes au compositeur
  // (GPU), donc l'animation reste fluide meme quand YouTube bloque le thread
  // principal pour refaire sa mise en page. Ajouter clip-path (ou toute autre
  // propriete non composable) suffit a tout repasser sur le thread principal,
  // et l'animation saccade : ne pas en ajouter.
  const mainVideo = (el) => {
    if (el.tagName === "VIDEO") return el;
    let best = null, area = 0;
    for (const v of el.getElementsByTagName("video")) {
      const r = v.getBoundingClientRect();
      if (r.width * r.height > area) { area = r.width * r.height; best = v; }
    }
    return best;
  };
  const OPTS = { duration: 300, easing: "cubic-bezier(.22,1,.36,1)" }; // ease-out doux
  const frames = (el, target, from) => {
    const e = el.getBoundingClientRect();
    const to = target.getBoundingClientRect();
    if (!to.width || !to.height) return null;
    const sx = from.width / to.width, sy = from.height / to.height;
    // Origine en haut a gauche de l'element : le point "to" va sur "from".
    const tx = from.left - e.left - (to.left - e.left) * sx;
    const ty = from.top - e.top - (to.top - e.top) * sy;
    return {
      key: [tx, ty, sx, sy],
      kf: [
        { transformOrigin: "0 0", translate: `${tx}px ${ty}px`, scale: `${sx} ${sy}` },
        { transformOrigin: "0 0", translate: "0px 0px", scale: "1 1" },
      ],
    };
  };
  // "from" = position de la video (ou de l'element) avant l'entree.
  const grow = (el, target, from) => {
    if (!isTop || !el.animate || !from.width || !from.height) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return; // evalue a la demande, pas au chargement
    try {
      const first = frames(el, target, from);
      if (!first) return;
      // 1re image : la video est tenue a sa place d'origine (animation en
      // pause) pendant que le lecteur finit sa mise en page plein ecran.
      const hold = el.animate(first.kf, OPTS);
      hold.pause();
      // Image suivante : mise en page terminee. On mesure sans la pose
      // (cancel), puis un seul zoom part de la position finale reelle.
      requestAnimationFrame(() => {
        if (active !== el) return hold.cancel();
        hold.cancel();
        el.animate((frames(el, target, from) ?? first).kf, OPTS);
      });
    } catch {}
  };

  // Entree reelle dans le mode in-window. "animate" : petit zoom de la boite
  // elle-meme (cas sans video accessible, ex : une iframe vue du parent).
  const doEnter = (el, animate) => {
    if (active === el) return;
    if (active) exitInWindow(false, true);
    const from = el.getBoundingClientRect();

    // On sauvegarde et restaure propriete par propriete, sans jamais
    // reecrire tout l'attribut style : si le lecteur (ou le Float Video de
    // Search) touche au style pendant ce temps, on n'ecrase pas ses changements.
    const props = Object.keys(STYLE);
    if (typeof el.showPopover !== "function" || el.hasAttribute("popover")) props.push("z-index");
    const saved = props.map((p) => [p, el.style.getPropertyValue(p), el.style.getPropertyPriority(p)]);
    for (const p of props) el.style.setProperty(p, p === "z-index" ? "2147483647" : STYLE[p], "important");

    const usePopover = typeof el.showPopover === "function" && !el.hasAttribute("popover");
    const lift = () => {
      if (!usePopover || !el.isConnected) return;
      try {
        if (el.matches(":popover-open")) el.hidePopover();
        el.setAttribute("popover", "manual");
        el.showPopover();
      } catch {}
    };
    lift();

    const htmlOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";

    const onKey = (e) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.stopPropagation();
        leave();
      }
    };

    // Bug de l'original : si le site retirait l'element du DOM (YouTube le fait
    // quand il reconstruit son lecteur), Windowed le CLONAIT et affichait le
    // clone. Un clone contient la miniature mais pas le flux video, pendant que
    // la vraie <video>, detachee, continuait a jouer le son. Ici, jamais de
    // clone : si l'element est deplace on le remet au premier plan, s'il a
    // disparu on sort proprement du mode et le lecteur reprend sa forme normale.
    const check = () => {
      if (active !== el) return;
      if (!el.isConnected) exitInWindow();
      else if (usePopover && !el.matches(":popover-open")) lift();
    };
    const mo = new MutationObserver(check);
    mo.observe(el.getRootNode(), { childList: true, subtree: true });

    // Retour sur l'onglet (apres un changement d'onglet ou le Float Video de
    // Search) : WebKit peut ne pas recomposer la couche video d'un element du
    // top layer, d'ou une image figee. On le remet au premier plan et on
    // relance le calcul de taille du lecteur.
    const onVisible = () => {
      if (document.visibilityState !== "visible" || active !== el) return;
      check();
      if (active !== el) return;
      lift();
      requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    };

    window.addEventListener("keydown", onKey, true);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onVisible);

    active = el;
    restore = () => {
      mo.disconnect();
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onVisible);
      if (usePopover) {
        try { if (el.matches(":popover-open")) el.hidePopover(); } catch {}
        el.removeAttribute("popover");
      }
      for (const [p, v, prio] of saved) {
        if (v) el.style.setProperty(p, v, prio);
        else el.style.removeProperty(p);
      }
      if (el.getAttribute("style") === "") el.removeAttribute("style");
      document.documentElement.style.overflow = htmlOverflow;
    };

    spoof(el);
    fire(el); // le lecteur se met en page "plein ecran" ici...
    if (animate) grow(el, el, from);
    // Si on est dans une iframe, le parent doit agrandir l'iframe elle-meme.
    if (!isTop) parent.postMessage({ [TAG]: "enter" }, "*");
  };


  // ---------- animations d'entree / de sortie, facon ouverture d'app iOS ----------
  // On ne peut pas animer la mise en page de YouTube : il la refait quand il
  // veut (parfois plusieurs images plus tard) et ca "pop". On anime donc une
  // CAPTURE de l'image en cours, posee dans un calque au-dessus de tout :
  //  - la capture reste nette et zoome avec un ressort, coins arrondis qui
  //    se referment ;
  //  - derriere, le reste de la fenetre se floute puis passe au noir
  //    (backdrop-filter fixe dont on anime seulement l'opacite : GPU).
  // Entree : zoom de la place de la video vers le plein onglet, puis on entre
  // en in-window sous le calque, et la capture s'efface sur la vraie video.
  // Sortie : l'inverse. On sort sous le calque, on attend que le lecteur ait
  // repris sa place dans la page, et la capture y retourne en rapetissant.
  let zooming = null; // animation en cours (entree ou sortie)
  let home = null; // place de la video dans la page avant l'entree (coordonnees du document)
  // Ressort : demarre vite, depasse a peine (~2 %) et se pose. Echantillonne
  // en linear() (Safari 17.2+), calcule au premier zoom ; Bezier sinon.
  const SPRING_MS = 560;
  let springEasing = null;
  const spring = () => {
    if (springEasing) return springEasing;
    if (!CSS.supports("animation-timing-function", "linear(0, 1)")) {
      return (springEasing = "cubic-bezier(.2,.9,.25,1.04)");
    }
    const zeta = 0.78, w0 = 13; // amortissement, pulsation (rad/s)
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    const pts = [];
    for (let i = 0; i <= 40; i++) {
      const t = (i / 40) * (SPRING_MS / 1000);
      const x = 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
      pts.push(+x.toFixed(4));
    }
    pts[40] = 1;
    return (springEasing = `linear(${pts.join(",")})`);
  };
  const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const RADIUS = 16; // arrondi a l'ecran quand la video est petite

  const cancelZoom = () => {
    if (!zooming) return;
    zooming.cancelled = true;
    zooming.ov.remove();
    window.removeEventListener("keydown", zooming.onKey, true);
    zooming = null;
  };

  // Calque : fond flou + voile noir + capture de la video posee sur "rect".
  const buildLayer = (video, rect) => {
    const ov = document.createElement("div");
    ov.style.cssText =
      "position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:0;" +
      "border:0;background:transparent;overflow:hidden;pointer-events:none;z-index:2147483647;color-scheme:normal";
    const blur = document.createElement("div");
    blur.style.cssText =
      "position:absolute;inset:0;opacity:0;-webkit-backdrop-filter:blur(30px) saturate(1.15);backdrop-filter:blur(30px) saturate(1.15)";
    const dark = document.createElement("div");
    dark.style.cssText = "position:absolute;inset:0;background:#000;opacity:0";
    // box porte le zoom (GPU), clip les coins arrondis, cv la capture.
    // Chaque effet sur son propre element : si WebKit ne sait pas animer
    // l'arrondi sur le GPU, le zoom de "box" y reste quand meme.
    const box = document.createElement("div");
    box.style.cssText =
      `position:absolute;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;transform-origin:0 0`;
    const clip = document.createElement("div");
    clip.style.cssText = "position:absolute;inset:0;overflow:hidden;background:#000";
    const cv = document.createElement("canvas");
    cv.width = video.videoWidth || Math.round(rect.width * devicePixelRatio);
    cv.height = video.videoHeight || Math.round(rect.height * devicePixelRatio);
    // Video protegee (DRM) : la capture reste noire, l'animation reste fluide.
    try { cv.getContext("2d").drawImage(video, 0, 0, cv.width, cv.height); } catch {}
    cv.style.cssText = "display:block;width:100%;height:100%";
    clip.append(cv);
    box.append(clip);
    ov.append(blur, dark, box);
    (document.body || document.documentElement).append(ov);
    // Toujours au-dessus du lecteur : le dernier entre dans le top layer gagne.
    const onTop = () => {
      try {
        if (ov.matches(":popover-open")) ov.hidePopover();
        ov.setAttribute("popover", "manual");
        ov.showPopover();
      } catch {}
    };
    onTop();
    return { ov, blur, dark, box, clip, onTop };
  };

  // Transformation qui pose la boite (placee sur "at") sur le rectangle "r".
  const place = (at, r) => ({
    translate: `${r.left - at.left}px ${r.top - at.top}px`,
    scale: `${r.width / at.width} ${r.height / at.height}`,
  });
  const IDENTITY = { translate: "0px 0px", scale: "1 1" };

  // Compteur d'images pour le diagnostic de la popup.
  const measure = (anim, label) => {
    const t0 = performance.now();
    let n = 0;
    const count = () => { n++; if (anim.playState === "running") requestAnimationFrame(count); };
    requestAnimationFrame(count);
    anim.finished.then(() => { diag.anim = `${label} ${n} images en ${Math.round(performance.now() - t0)} ms`; }, () => {});
  };

  const contain = (video, fallback) => {
    const W = innerWidth, H = innerHeight;
    const ar = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : fallback.width / fallback.height;
    let w = W, h = W / ar;
    if (h > H) { h = H; w = H * ar; }
    return { left: (W - w) / 2, top: (H - h) / 2, width: w, height: h };
  };

  const zoomIn = (el, video) => {
    const from = video.getBoundingClientRect();
    if (!from.width || !from.height) return doEnter(el, true);
    const to = contain(video, from); // place finale, centree
    home = { left: from.left + scrollX, top: from.top + scrollY, width: from.width };
    const L = buildLayer(video, to);

    // Echap pendant le zoom : on annule tout.
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); cancelZoom(); } };
    window.addEventListener("keydown", onKey, true);
    const z = (zooming = { el, ov: L.ov, onKey, cancelled: false });

    const ease = spring();
    const opts = { duration: SPRING_MS, easing: ease, fill: "forwards" };
    // Le reste de la fenetre se floute vite, puis s'assombrit jusqu'au noir.
    L.blur.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: "ease-out", fill: "forwards" });
    L.dark.animate([{ opacity: 0 }, { opacity: 0.25, offset: 0.4 }, { opacity: 1 }], { duration: SPRING_MS, easing: "ease-in", fill: "forwards" });
    L.clip.animate([{ borderRadius: `${RADIUS * (to.width / from.width)}px` }, { borderRadius: "0px" }], opts);
    const zoom = L.box.animate([place(to, from), IDENTITY], opts);
    measure(zoom, "entree :");

    zoom.finished.then(() => {
      if (z.cancelled) return;
      window.removeEventListener("keydown", onKey, true);
      doEnter(el, false);
      L.onTop(); // le lecteur vient de passer dans le top layer : le calque repasse devant
      // Attend que la vraie video soit a sa place (700 ms max), puis fondu.
      const t0 = performance.now();
      const near = (r, x, y, w2) => Math.abs(r.left - x) < 4 && Math.abs(r.top - y) < 4 && Math.abs(r.width - w2) < 4;
      const wait = () => {
        if (z.cancelled) return;
        const r = mainVideo(el)?.getBoundingClientRect();
        const ready = r && (near(r, to.left, to.top, to.width) || near(r, 0, 0, innerWidth));
        if (!ready && performance.now() - t0 < 700) return requestAnimationFrame(wait);
        L.ov.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: "ease-out" })
          .finished.then(() => { if (zooming === z) zooming = null; L.ov.remove(); });
      };
      requestAnimationFrame(wait);
    }, () => {});
  };

  const zoomOut = (el, video) => {
    const from = video.getBoundingClientRect(); // la video en grand
    if (!from.width || !from.height) return exitInWindow();
    const L = buildLayer(video, from);
    // Calque deja "plein" : fond flou et noir, capture en grand.
    L.blur.style.opacity = "1";
    L.dark.style.opacity = "1";
    L.onTop();
    exitInWindow(); // sortie reelle sous le calque (avant d'enregistrer z : exitInWindow annule tout zoom en cours)
    L.onTop();
    const z = (zooming = { el, ov: L.ov, onKey: null, cancelled: false, leaving: true });

    // Attend que le lecteur ait repris sa place dans la page (500 ms max) :
    // soit la video est revenue la ou elle etait avant l'entree, soit elle
    // ne bouge plus depuis 6 images et n'est plus en grand.
    const t0 = performance.now();
    let last = null, stable = 0;
    const near = (r, x, y, w2) => Math.abs(r.left - x) < 4 && Math.abs(r.top - y) < 4 && Math.abs(r.width - w2) < 4;
    const settle = () => {
      if (z.cancelled) return;
      const v = mainVideo(el) ?? video;
      const r = v.isConnected ? v.getBoundingClientRect() : null;
      stable = r && last && near(r, last.left, last.top, last.width) ? stable + 1 : 0;
      last = r;
      const atHome = r && home && near(r, home.left - scrollX, home.top - scrollY, home.width);
      const big = r && (near(r, from.left, from.top, from.width) || Math.abs(r.width - innerWidth) < 4);
      if (!(atHome || (stable >= 6 && !big)) && performance.now() - t0 < 500) return requestAnimationFrame(settle);
      const visible = r && r.width > 0 && r.bottom > 0 && r.top < innerHeight;
      const done = () => { if (zooming === z) zooming = null; L.ov.remove(); };
      if (!visible) {
        L.ov.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: "ease-out" }).finished.then(done, done);
        return;
      }
      const ease = spring();
      const opts = { duration: SPRING_MS, easing: ease, fill: "forwards" };
      // Le noir part vite, le flou se dissipe ensuite : la page reapparait.
      L.dark.animate([{ opacity: 1 }, { opacity: 0.25, offset: 0.45 }, { opacity: 0 }], { duration: SPRING_MS, easing: "ease-out", fill: "forwards" });
      L.blur.animate([{ opacity: 1 }, { opacity: 1, offset: 0.35 }, { opacity: 0 }], { duration: SPRING_MS, easing: "ease-in-out", fill: "forwards" });
      L.clip.animate([{ borderRadius: "0px" }, { borderRadius: `${RADIUS * (from.width / r.width)}px` }], opts);
      const zoom = L.box.animate([IDENTITY, place(from, r)], opts);
      measure(zoom, "sortie :");
      // A la fin, la capture est pile sur la vraie video : on la retire en fondu court.
      zoom.finished.then(() => {
        if (z.cancelled) return;
        L.ov.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: "ease-out" }).finished.then(done, done);
      }, () => {});
    };
    requestAnimationFrame(settle);
  };

  const enterInWindow = (el) => {
    closeChooser();
    if (active === el || (zooming?.el === el && !zooming.leaving)) return;
    cancelZoom();
    const video = isTop && el.animate ? mainVideo(el) : null;
    if (!video) {
      if (isTop) diag.anim = "zoom simple (aucune video trouvee dans l'element)";
      return doEnter(el, isTop);
    }
    if (reducedMotion()) {
      diag.anim = "desactivee : \"Reduire les animations\" est actif dans macOS";
      return doEnter(el, false);
    }
    zoomIn(el, video);
  };

  // Sortie demandee par l'utilisateur ou la page (Echap, bouton du lecteur).
  const leave = () => {
    if (zooming?.leaving) return; // deja en train de sortir
    if (zooming && !active) return cancelZoom(); // encore en train d'entrer
    if (!active) return;
    const el = active;
    const video = isTop && el.animate ? mainVideo(el) : null;
    if (!video || reducedMotion()) return exitInWindow();
    cancelZoom();
    zoomOut(el, video);
  };


  // up = prevenir la frame parente, down = prevenir l'iframe enfant
  const exitInWindow = (up = true, down = true) => {
    cancelZoom();
    if (!active) return;
    const el = active;
    restore();
    active = restore = null;
    unspoof();
    fire(el.isConnected ? el : document); // un element detache ne fait pas remonter l'evenement
    if (down && el.tagName === "IFRAME") el.contentWindow?.postMessage({ [TAG]: "exit-child" }, "*");
    if (up && !isTop) parent.postMessage({ [TAG]: "exit" }, "*");
  };

  // ---------- menu de choix (cree uniquement a la demande) ----------
  let chooserOff = null;
  const closeChooser = () => {
    if (chooser) { chooser.remove(); chooser = null; chooserOff(); }
  };

  const showChooser = (el, original) => {
    closeChooser();
    const video = el.tagName === "VIDEO" ? el : el.querySelector?.("video");
    const canPip = !!(video && video.requestPictureInPicture && !video.disablePictureInPicture && video.readyState >= 1);

    const host = document.createElement("div");
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
    const root = host.attachShadow({ mode: "closed" });
    const r = el.getBoundingClientRect();
    const x = Math.min(Math.max(r.left + r.width / 2, 90), innerWidth - 90);
    const y = Math.min(Math.max(r.top + r.height / 2, 80), innerHeight - 80);
    // Construit avec createElement / textContent : YouTube (et d'autres)
    // imposent les Trusted Types, qui interdisent innerHTML dans la page.
    // C'est ce qui empechait le menu de s'afficher.
    const style = document.createElement("style");
    style.textContent =
      `menu{all:initial;position:fixed;left:${x}px;top:${y}px;transform:translate(-50%,-50%);` +
      "pointer-events:auto;display:flex;flex-direction:column;min-width:170px;padding:6px;" +
      "background:rgba(20,20,20,.92);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);" +
      "border:1px solid rgba(255,255,255,.12);border-radius:10px;font:14px -apple-system,system-ui,sans-serif;color:#fff}" +
      "button{all:unset;display:flex;justify-content:space-between;gap:16px;padding:7px 10px;border-radius:6px;cursor:pointer}" +
      "button:hover,button:focus-visible{background:rgba(255,255,255,.12)}" +
      "kbd{font:12px ui-monospace,monospace;opacity:.55}";
    const menu = document.createElement("menu");
    const items = [["i", "In-window"], ["f", "Plein ecran"]];
    if (canPip) items.push(["p", "Picture-in-Picture"]);
    for (const [key, label] of items) {
      const btn = document.createElement("button");
      btn.dataset.a = key;
      btn.append(label);
      const kbd = document.createElement("kbd");
      kbd.textContent = key.toUpperCase();
      btn.append(kbd);
      menu.append(btn);
    }
    root.append(style, menu);

    // Les actions natives (plein ecran, PiP) doivent rester synchrones
    // pour garder le "user gesture" du clic ou de la touche.
    const run = (a) => {
      closeChooser();
      if (a === "i") enterInWindow(el);
      else if (a === "f") original();
      else if (a === "p" && canPip) video.requestPictureInPicture().catch(() => {});
    };
    menu.addEventListener("click", (e) => {
      const b = e.target.closest?.("button");
      if (b) run(b.dataset.a);
    });
    // Ecoute au niveau window (capture) tant que le menu est ouvert :
    // marche meme si le site vole le focus. Retire des la fermeture.
    const onKey = (e) => {
      const k = e.key.toLowerCase();
      if (k === "escape") { e.stopPropagation(); e.preventDefault(); closeChooser(); }
      else if (k === "i" || k === "f" || (k === "p" && canPip)) { e.stopPropagation(); e.preventDefault(); run(k); }
    };
    const onDown = (e) => { if (!e.composedPath().includes(host)) closeChooser(); };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
    chooserOff = () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown, true);
    };

    (document.body || document.documentElement).appendChild(host);
    chooser = host;
  };

  // ---------- remplacement de requestFullscreen / exitFullscreen ----------
  let allowNative = false; // vrai quand c'est nous qui lancons le plein ecran natif
  const request = function (...args) {
    const el = this;
    const original = () => { allowNative = true; return nativeRequest.apply(el, args); };
    const mode = shift ? "ask" : cfg.mode;
    diag.intercepted++;

    if (mode === "fullscreen") return original();

    if (cfg.pip && !shift) {
      const v = el.tagName === "VIDEO" ? el : el.querySelector?.("video");
      if (v?.requestPictureInPicture && !v.disablePictureInPicture && v.readyState >= 1) {
        return v.requestPictureInPicture().then(() => {}, () => original());
      }
    }

    try {
      if (mode === "in-window") enterInWindow(el);
      else showChooser(el, original);
      return Promise.resolve(); // la spec renvoie une Promise (l'original renvoyait undefined)
    } catch (err) {
      console.warn("[Windowed Lite] fallback plein ecran natif", err);
      return original();
    }
  };

  const exit = function (...args) {
    if (zooming || active) { leave(); return Promise.resolve(); }
    return nativeExit ? nativeExit.apply(document, args) : Promise.resolve();
  };

  for (const n of ["requestFullscreen", "webkitRequestFullscreen", "webkitRequestFullScreen"]) {
    if (typeof EP[n] === "function") EP[n] = request;
  }
  for (const n of ["exitFullscreen", "webkitExitFullscreen", "webkitCancelFullScreen"]) {
    if (typeof DP[n] === "function") DP[n] = exit;
  }

  // ---------- filet de securite ----------
  // Si la page entre quand meme en plein ecran natif sans passer par nous
  // (fonction gardee de cote, autre API...), on le detecte et on le convertit
  // en in-window ou en menu, selon le reglage.
  let convertTo = null;
  const onNativeChange = () => {
    const real = realFullscreenElement();
    if (real) closeChooser(); // le menu ne doit jamais rester par-dessus un plein ecran natif
    if (real) {
      if (convertTo || allowNative || cfg.mode === "fullscreen" || shift) return;
      diag.bypassed++;
      convertTo = real;
      nativeExit?.call(document);
    } else {
      allowNative = false;
      const el = convertTo;
      convertTo = null;
      if (!el || !el.isConnected) return;
      if (cfg.mode === "in-window") enterInWindow(el);
      else showChooser(el, () => { allowNative = true; return nativeRequest.call(el); });
    }
  };
  document.addEventListener("fullscreenchange", onNativeChange, true);
  document.addEventListener("webkitfullscreenchange", onNativeChange, true);

  // ---------- communication ----------
  // Un seul listener, qui sort immediatement pour tout message qui n'est pas
  // a nous (l'original faisait un querySelectorAll('iframe') a CHAQUE message).
  window.addEventListener("message", (e) => {
    const t = e.data?.[TAG];
    if (t === undefined) return;
    if (t === "exit-child") {
      if (e.source === parent) exitInWindow(false, true);
      return;
    }
    // Messages venant d'une iframe enfant : on retrouve l'iframe concernee.
    let frame = null;
    for (const f of document.getElementsByTagName("iframe")) {
      if (f.contentWindow === e.source) { frame = f; break; }
    }
    if (!frame) return;
    if (t === "enter") enterInWindow(frame);
    else if (t === "exit" && active === frame) exitInWindow();
  });

  // Touche Shift = forcer le menu de choix. Un simple booleen, pas de postMessage.
  const trackShift = (e) => { shift = e.shiftKey; };
  window.addEventListener("keydown", trackShift, { capture: true, passive: true });
  window.addEventListener("keyup", trackShift, { capture: true, passive: true });

  document.addEventListener("windowed-lite:config", (e) => setCfg(e.detail));
  // Si le script cfg est passe avant nous dans un autre monde, il repond a ce ping.
  document.dispatchEvent(new CustomEvent("windowed-lite:ping"));
})();
