// src/ (lisible, commente) -> extension/ (minifie, a charger dans le navigateur)
import { build, transform } from "esbuild";
import { rm, mkdir, cp, readFile, writeFile } from "node:fs/promises";

const out = "extension";
await rm(out, { recursive: true, force: true });
await mkdir(`${out}/cfg`, { recursive: true });

const common = { minify: true, target: ["safari17", "chrome120"], legalComments: "none", logLevel: "warning" };

// page.js : script autonome, injecte dans chaque frame
await build({ ...common, entryPoints: ["src/page.js"], outfile: `${out}/page.js`, format: "iife" });
// popup et worker : sync.js integre dans chacun, plus d'import a l'execution
for (const f of ["popup", "bg"]) {
  await build({ ...common, entryPoints: [`src/${f}.js`], outfile: `${out}/${f}.js`, bundle: true, format: "esm" });
}

// Un fichier cfg par reglage possible
const template = await readFile("src/cfg.template.js", "utf8");
for (const mode of ["ask", "in-window", "fullscreen"]) {
  for (const pip of [false, true]) {
    const name = `${mode}${pip ? "-pip" : ""}`;
    const src = template.replace("__CFG__", JSON.stringify(JSON.stringify({ mode, pip })));
    const { code } = await transform(src, { ...common, loader: "js" });
    await writeFile(`${out}/cfg/${name}.js`, code);
  }
}

for (const f of ["manifest.json", "popup.html", "icons"]) await cp(`src/${f}`, `${out}/${f}`, { recursive: true });
console.log("build ok ->", out);
