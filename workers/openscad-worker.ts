import type { WorkerCompileRequest, WorkerCompileResponse } from "@/lib/scad/types";

// Minimal surface of the Emscripten module we consume. The vendored,
// unmodified openscad.js/openscad.wasm binaries (GPL — see
// public/openscad/NOTICE.txt) are loaded at runtime over HTTP; nothing
// here is derived from OpenSCAD source.
interface OpenScadInstance {
  FS: {
    writeFile(path: string, data: string | Uint8Array): void;
    readFile(path: string): Uint8Array;
    mkdirTree?(path: string): void;
    createPath?(parent: string, path: string, canRead?: boolean, canWrite?: boolean): void;
  };
  callMain(args: string[]): number | undefined;
  formatException?(ptr: number): string;
}

interface OpenScadModuleOptions {
  noInitialRun: boolean;
  print(line: string): void;
  printErr(line: string): void;
  locateFile(path: string): string;
}

type OpenScadFactory = (opts: OpenScadModuleOptions) => Promise<OpenScadInstance>;

// Opaque dynamic import: keeps Turbopack/webpack from trying to bundle the
// vendored module (both the technical and the license boundary).
const importAtRuntime = new Function("u", "return import(u)") as (
  url: string,
) => Promise<{ default: OpenScadFactory }>;

const ctx = self as unknown as {
  location: { origin: string };
  postMessage(message: WorkerCompileResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerCompileRequest>) => void) | null;
};

ctx.onmessage = async (event: MessageEvent<WorkerCompileRequest>) => {
  const { source, jobId, files } = event.data;
  const stderr: string[] = [];
  try {
    const { default: OpenSCAD } = await importAtRuntime(`${ctx.location.origin}/openscad/openscad.js`);
    const instance = await OpenSCAD({
      noInitialRun: true,
      print: (line) => stderr.push(line),
      printErr: (line) => stderr.push(line),
      locateFile: (path) => `/openscad/${path}`,
    });

    if (files && files.length > 0) {
      if (typeof instance.FS.mkdirTree === "function") instance.FS.mkdirTree("/uploads");
      else instance.FS.createPath?.("/", "uploads", true, true);
      for (const file of files) {
        instance.FS.writeFile(
          file.path,
          typeof file.data === "string" ? file.data : new Uint8Array(file.data),
        );
      }
    }

    instance.FS.writeFile("/input.scad", source);

    let exitCode: number | null = null;
    try {
      exitCode = instance.callMain([
        "/input.scad",
        "--backend=manifold",
        "--export-format=binstl",
        "-o",
        "/out.stl",
      ]) ?? null;
    } catch (err: unknown) {
      if (typeof err === "object" && err !== null && "status" in err && typeof err.status === "number") {
        exitCode = err.status; // Emscripten ExitStatus
      } else if (typeof err === "number" && typeof instance.formatException === "function") {
        stderr.push(instance.formatException(err)); // C++ exception pointer
        exitCode = 1;
      } else {
        stderr.push(String(err));
        exitCode = 1;
      }
    }

    let stl: Uint8Array | null = null;
    try {
      stl = instance.FS.readFile("/out.stl");
    } catch {
      stl = null;
    }

    if (stl && stl.length > 0 && (exitCode === null || exitCode === 0)) {
      // Copy out of the wasm heap; the copy's buffer is exactly sized and
      // safe to transfer (the worker is done with it).
      const copy = stl.slice();
      ctx.postMessage({ type: "done", jobId, stl: copy.buffer, stderr }, [copy.buffer]);
    } else {
      ctx.postMessage({ type: "error", jobId, stderr, exitCode: exitCode ?? 1 });
    }
  } catch (err) {
    stderr.push(`Compiler failed to start: ${err instanceof Error ? err.message : String(err)}`);
    ctx.postMessage({ type: "error", jobId, stderr, exitCode: null });
  }
};
