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

interface OpenScadFS {
  writeFile(path: string, data: string | Uint8Array): void;
  readFile(path: string): Uint8Array;
  mkdirTree?(path: string): void;
  createPath?(parent: string, path: string, canRead?: boolean, canWrite?: boolean): void;
}

function ensureDir(fs: OpenScadFS, dir: string): void {
  if (typeof fs.mkdirTree === "function") fs.mkdirTree(dir);
  else fs.createPath?.("/", dir.replace(/^\//, ""), true, true);
}

function writeWithDirs(fs: OpenScadFS, path: string, data: string | Uint8Array): void {
  const dir = path.slice(0, path.lastIndexOf("/"));
  if (dir) ensureDir(fs, dir);
  fs.writeFile(path, data);
}

// Fonts live in the served bundle, not the wasm — write them into the
// virtual FS (fontconfig's default /etc/fonts/fonts.conf points at /fonts)
// so text() works. Same-origin fetches; the HTTP cache makes repeats cheap.
async function installFonts(fs: OpenScadFS, origin: string): Promise<void> {
  const [conf, regular, bold] = await Promise.all(
    ["fonts.conf", "DejaVuSans.ttf", "DejaVuSans-Bold.ttf"].map(async (name) => {
      const res = await fetch(`${origin}/openscad/fonts/${name}`);
      if (!res.ok) throw new Error(`font asset ${name} missing (${res.status})`);
      return new Uint8Array(await res.arrayBuffer());
    }),
  );
  writeWithDirs(fs, "/etc/fonts/fonts.conf", conf);
  writeWithDirs(fs, "/fonts/DejaVuSans.ttf", regular);
  writeWithDirs(fs, "/fonts/DejaVuSans-Bold.ttf", bold);
  ensureDir(fs, "/fontcache");
}

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

    for (const file of files ?? []) {
      writeWithDirs(
        instance.FS,
        file.path,
        typeof file.data === "string" ? file.data : new Uint8Array(file.data),
      );
    }
    if (/\btext\s*\(/.test(source)) await installFonts(instance.FS, ctx.location.origin);

    instance.FS.writeFile("/input.scad", source);

    // Always binary STL: the build's native 3MF writer is broken (wasm
    // signature mismatch in lib3mf) — 3MF is produced client-side instead.
    const outPath = "/out.stl";
    let exitCode: number | null = null;
    try {
      exitCode = instance.callMain([
        "/input.scad",
        "--backend=manifold",
        "--export-format=binstl",
        "-o",
        outPath,
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

    let model: Uint8Array | null = null;
    try {
      model = instance.FS.readFile(outPath);
    } catch {
      model = null;
    }

    if (model && model.length > 0 && (exitCode === null || exitCode === 0)) {
      // Copy out of the wasm heap; the copy's buffer is exactly sized and
      // safe to transfer (the worker is done with it).
      const copy = model.slice();
      ctx.postMessage({ type: "done", jobId, model: copy.buffer, stderr }, [copy.buffer]);
    } else {
      ctx.postMessage({ type: "error", jobId, stderr, exitCode: exitCode ?? 1 });
    }
  } catch (err) {
    stderr.push(`Compiler failed to start: ${err instanceof Error ? err.message : String(err)}`);
    ctx.postMessage({ type: "error", jobId, stderr, exitCode: null });
  }
};
