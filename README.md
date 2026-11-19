# Windowed Lite

Version allegee de [Windowed](https://github.com/dralletje/Windowed) (Michiel Dral, ISC), reecrite pour le navigateur Search (WebKit, WKWebExtension).

Quand un site demande le plein ecran, l'extension peut :

- **In-window** : la video remplit l'onglet, pas l'ecran (Echap pour sortir)
- **Natif** : le vrai plein ecran macOS
- **Demander** : petit menu avec `I` / `F` / `P` (Picture-in-Picture si une video est dispo)

`Shift` au moment du clic sur le bouton plein ecran force le menu. Les reglages se font par site ou par defaut depuis le bouton de l'extension. Les anciens reglages de Windowed (`mode(host)`, `pip(host)`) sont relus, `windowed` devient `in-window`.

Pour une video flottante au-dessus des autres apps, Search a deja **Float Video** en natif (`Cmd+Shift+P`), donc ce mode n'est pas reimplemente ici.

## Installation dans Search

Charger le dossier **`extension/`** (pas la racine du repo) : Settings > Extensions, extension non empaquetee. Pour Chrome : `chrome://extensions` > mode developpeur > "Charger l'extension non empaquetee" > `extension/`.

Passer de la v1 a la v2 demande de **supprimer puis reinstaller** l'extension : la v2 demande deux permissions de plus (`scripting` et l'acces a tous les sites).

## Structure

```
src/         code source lisible et commente
extension/   version minifiee generee, celle qu'on charge dans le navigateur
build.mjs    src/ -> extension/  (npm install puis npm run build)
```

## Architecture (v2)

- `page.js` (7,8 Ko minifie) est le seul script injecte dans les pages. Il ne lit aucun reglage et n'envoie aucun message au chargement.
- Les reglages sont transformes en petits scripts `cfg/*.js` (~200 octets) enregistres via `scripting.registerContentScripts`, uniquement pour les sites dont le reglage differe du defaut. Avec le defaut "Demander", la plupart des pages ne recoivent que `page.js`.
- `bg.js` ne se reveille qu'a l'installation, au demarrage du navigateur et quand un reglage change, pour regenerer ces scripts. Jamais pendant la navigation.
- La popup applique un changement tout de suite a l'onglet ouvert, et lit le diagnostic seulement quand on l'ouvre.
- Plus aucun script dans le monde isole : dans Search, ca evite aussi la couche de compatibilite (~70 Ko) que le navigateur ajoute devant ces scripts.

Le reglage d'une video integree (iframe) suit le site de la video : un embed YouTube dans un article utilise le reglage de youtube.com.

## Ce qui a change par rapport a Windowed

| | Windowed v34 | Windowed Lite |
|---|---|---|
| JS injecte dans **chaque frame** | ~72 Ko (Content.js + polyfill + script page) | 7,8 Ko (+ ~200 octets sur les sites regles) |
| Service worker | oui, reveille par chaque frame et chaque navigation | seulement a l'installation, au demarrage et quand un reglage change |
| Document offscreen (WebView cachee dans Search) | oui, cree pour connaitre le theme clair/sombre | aucun |
| Messages au chargement d'une frame | 2 `runtime.sendMessage` + 1 `fetch` de debug | aucun |
| Par touche clavier | 1 `postMessage` sur toute la page | rien (simple booleen) |
| Listener `message` de la page | `querySelectorAll('iframe')` a chaque message du site | sort tout de suite si le message n'est pas a nous |
| Mise en avant de l'element | `all: initial` sur tous les parents + MutationObserver + clonage | API Popover (top layer), aucun parent touche |
| Permissions | `tabs`, `storage`, `offscreen` | `activeTab`, `storage`, `scripting`, acces aux sites |

Bugs corriges au passage :

- **Miniature figee + son qui continue apres un changement d'onglet.** Quand le site retirait l'element du DOM (YouTube reconstruit son lecteur), l'original affichait un `cloneNode()` de l'element. Le clone contient la miniature mais pas le flux, et la vraie `<video>`, detachee, continue a jouer le son. Ici, aucun clone : si l'element est deplace, il est remis au premier plan ; s'il disparait, on sort proprement du mode. Au retour sur l'onglet, l'element est remis dans le top layer et le lecteur recalcule sa taille.
- Le style inline de l'element est sauvegarde et restaure propriete par propriete, donc les changements faits par le lecteur ou par le Float Video de Search pendant le mode ne sont pas ecrases.
- `requestFullscreen()` renvoie bien une Promise (l'original renvoyait `undefined`).
- L'appel casse `document.fullscreenElement.postMessage.sendMessage(...)` a disparu.

## Diagnostic

La popup affiche l'etat du script sur l'onglet : `Actif - mode ... - N intercepte(s) - derniere animation : ...`.

- `intercepte(s)` : appels a `requestFullscreen` pris en charge.
- `derniere animation` : nombre d'images affichees pendant le dernier zoom, ou la raison pour laquelle il n'a pas eu lieu (par exemple "Reduire les animations" actif dans macOS).
- `Script absent de la page` : la page a ete ouverte avant l'installation ou le rechargement de l'extension, il faut la recharger.

## Plein ecran total

A l'entree, la transition est celle de macOS (la fenetre glisse vers son propre espace) : une page web ne peut pas la modifier. A la sortie, une fois la page revenue dans la fenetre, la video retourne a sa place avec la meme animation que le mode in-window.

## Limites connues

- Le bouton plein ecran des controles natifs de `<video>` (sans lecteur JS) passe par le moteur, pas par `requestFullscreen`, donc il n'est pas intercepte.
- Les styles CSS `:fullscreen` du site ne s'appliquent pas en mode in-window (meme chose dans l'original).
- Le mode "Windowed" de l'original (onglet detache en popup) est volontairement retire : dans Search, `windows.create` avec un onglet existant cree une fenetre normale, pas une popup, donc ce mode ne marchait pas comme prevu.

## Licence

ISC, voir [LICENSE](LICENSE). Base sur [Windowed](https://github.com/dralletje/Windowed) de Michiel Dral (ISC).
