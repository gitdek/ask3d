export interface ScadError {
  message: string;
  line?: number;
  file?: string;
  raw?: string;
}

export interface WorkerCompileRequest {
  type: "compile";
  source: string;
  jobId: number;
}

export type WorkerCompileResponse =
  | { type: "done"; jobId: number; stl: ArrayBuffer; stderr: string[] }
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
  kind: "compile" | "timeout";
}
