export interface ScadError {
  message: string;
  line?: number;
  file?: string;
  raw?: string;
}

/** Extra file written into the compiler's virtual FS before callMain. */
export interface CompileFile {
  /** Absolute virtual path, e.g. "/uploads/model.stl". */
  path: string;
  /** Binary (STL) or text (.dat heightmap / .scad) content. */
  data: ArrayBuffer | string;
}

export interface WorkerCompileRequest {
  type: "compile";
  source: string;
  jobId: number;
  files?: CompileFile[];
}

export type WorkerCompileResponse =
  | { type: "done"; jobId: number; model: ArrayBuffer; stderr: string[] }
  | { type: "error"; jobId: number; stderr: string[]; exitCode: number | null };

export type CompilerStatus = "idle" | "compiling" | "done" | "error" | "timeout";

export interface CompileSuccess {
  source: string;
  stl: ArrayBuffer;
  stderr: string[];
}

export interface CompileFailure {
  source: string;
  errors: ScadError[];
  stderr: string[];
  /**
   * "compile": the code is at fault — eligible for LLM auto-repair.
   * "timeout": the model is too heavy — surface, don't repair.
   * "environment": the compiler itself failed to load/start — surface, don't repair.
   */
  kind: "compile" | "timeout" | "environment";
}
