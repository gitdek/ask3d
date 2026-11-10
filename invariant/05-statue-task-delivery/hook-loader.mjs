// Only dependency injection and TypeScript compilation; the hook's source is
// loaded from the package and is never patched or copied into the driver.
import { readFile } from "node:fs/promises";
import ts from "typescript";

let hookURL;
export function initialize({ hook }) { hookURL = hook; }

export async function resolve(specifier, context, next) {
  if (context.parentURL === hookURL) {
    if (specifier === "react") return { url: "invariant:react", shortCircuit: true };
    if (specifier === "../lib/statue") return { url: "invariant:statue", shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  const exports = url === "invariant:react"
    ? ["useState", "useRef", "useCallback", "useEffect"]
    : url === "invariant:statue"
      ? ["createStatueTask", "fetchLatestStatueTask", "fetchStatueModel",
         "getDismissedStatueTaskId", "pollStatueTask", "setDismissedStatueTaskId", "statueHealth"]
      : null;
  if (exports) return {
    format: "module", shortCircuit: true,
    source: exports.map(name => `export const ${name} = (...args) => globalThis.__statueHarness.${name}(...args);`).join("\n"),
  };
  if (url === hookURL) return {
    format: "module", shortCircuit: true,
    source: ts.transpileModule(await readFile(new URL(url), "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      fileName: "use-statue-task.ts",
    }).outputText,
  };
  return next(url, context);
}
