// Resolve only the unchanged hook's two boundaries. TypeScript is the
// package's existing compiler; transpilation does not instrument the hook.
import { readFile } from "node:fs/promises";
import ts from "typescript";

const isHook = (url = "") => /\/hooks\/use-statue-task\.ts(?:\?.*)?$/.test(url);
const facade = (group, names) => "data:text/javascript," + encodeURIComponent(
  names.map(name => `export const ${name} = (...args) => globalThis.__statueConformance.${group}.${name}(...args);`).join("\n"),
);

export async function resolve(specifier, context, next) {
  if (isHook(context.parentURL)) {
    if (specifier === "react") return {
      url: facade("react", ["useState", "useRef", "useCallback", "useEffect"]), shortCircuit: true,
    };
    if (specifier === "../lib/statue") return {
      url: facade("statue", ["createStatueTask", "fetchLatestStatueTask", "fetchStatueModel",
        "getDismissedStatueTaskId", "pollStatueTask", "setDismissedStatueTaskId", "statueHealth"]),
      shortCircuit: true,
    };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (isHook(url)) return {
    format: "module", shortCircuit: true,
    source: ts.transpileModule(await readFile(new URL(url), "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      fileName: "use-statue-task.ts",
    }).outputText,
  };
  return next(url, context);
}
