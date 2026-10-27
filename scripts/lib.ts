import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { gunzipSync } from "node:zlib";

export const ROOT = join(import.meta.dir, "..");
export const CLIENT_DIR = join(ROOT, "packages", "client");
export const DEFAULT_NPM_DIR = join(ROOT, "dist-npm");
export const MAIN_PACKAGE = "@searxng-js/searxng";
export const REPOSITORY = "AkaraChen/searxng";
/** npm trusted publishing checks repository.url against the workflow's repository. */
export const REPOSITORY_URL = `git+https://github.com/${REPOSITORY}.git`;
export const RELEASE_WORKFLOW = "release.yml";
export const RELEASE_ENVIRONMENT = "npm";

export function log(message: string): void {
  console.log(`[release] ${message}`);
}

export function fail(message: string): never {
  console.error(`[release] error: ${message}`);
  process.exit(1);
}

export function args<T extends NonNullable<ParseArgsConfig["options"]>>(options: T) {
  return parseArgs({ options, strict: true, allowPositionals: false }).values;
}

/** Runs a command; npm is a .cmd shim on Windows, hence the shell there. */
export function run(
  cmd: string,
  argv: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; capture?: boolean } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!options.capture) log(`$ ${cmd} ${argv.join(" ")}`);
    const child = spawn(cmd, argv, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: process.platform === "win32",
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk: Buffer) => (out += chunk));
    child.stderr?.on("data", (chunk: Buffer) => (err += chunk));
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} ${argv.join(" ")} exited with ${code}${err ? `\n${err}` : ""}`)),
    );
  });
}

export async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

/** package/package.json of an npm tarball, without a tar binary. */
export function tarballManifest(tarball: Buffer): { name: string; version: string } & Record<string, unknown> {
  const tar = gunzipSync(tarball);
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    if (name === "") break;
    const size = Number.parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/s, "").trim() || "0", 8);
    const body = offset + 512;
    if (name === "package/package.json") return JSON.parse(tar.subarray(body, body + size).toString("utf8"));
    offset = body + Math.ceil(size / 512) * 512;
  }
  throw new Error("package/package.json not found in tarball");
}
