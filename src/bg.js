// Ne se reveille qu'a l'installation, au demarrage du navigateur et quand
// un reglage change, pour (re)enregistrer les scripts de reglages.
// Jamais pendant la navigation.
import { sync } from "./sync.js";

const api = globalThis.browser ?? globalThis.chrome;
let queue = Promise.resolve();
const run = () => (queue = queue.then(sync).catch(console.warn)); // jamais deux sync en parallele

api.runtime.onInstalled.addListener(run);
api.runtime.onStartup.addListener(run);
api.storage.onChanged.addListener((_changes, area) => { if (area === "sync") run(); });
