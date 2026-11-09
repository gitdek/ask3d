import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Not our code: vendored OpenSCAD/Draco builds, the Python sidecar and
    // its gitignored venvs, runtime data.
    "public/**",
    "statue-service/**",
    // Invariant's verification projects: its gate runs and checks them with
    // their own toolchain, as Node runs them, apart from the app's.
    "invariant/**",
    ".library/**",
    ".logs/**",
  ]),
]);

export default eslintConfig;
