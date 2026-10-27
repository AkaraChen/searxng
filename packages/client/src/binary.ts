import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { packageName, TARGETS } from "./targets.ts";

export class SearxngBinaryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SearxngBinaryError";
  }
}

// Literal conditions and specifiers on purpose: `bun build --compile` inlines
// process.platform and process.arch for its target, drops the other branches
// and embeds only that platform's binary (the package need not even be
// installed for the other targets).
async function importPlatformPackage(): Promise<string | undefined> {
  if (process.platform === "linux" && process.arch === "x64") return (await import("@searxng-js/linux-x64")).default;
  if (process.platform === "darwin" && process.arch === "arm64") return (await import("@searxng-js/darwin-arm64")).default;
  if (process.platform === "win32" && process.arch === "x64") return (await import("@searxng-js/win32-x64")).default;
  return undefined;
}

/**
 * The SearXNG executable from the installed platform package
 * (`@searxng-js/<platform>-<arch>`), ready to spawn. Inside an executable made
 * with `bun build --compile` the binary is embedded; it is unpacked once to the
 * user cache directory.
 */
export async function resolveBinary(): Promise<string> {
  const host = `${process.platform}-${process.arch}`;
  const target = TARGETS.find((t) => t.os === process.platform && t.cpu === process.arch);
  if (!target) {
    const supported = TARGETS.map((t) => t.id).join(", ");
    throw new SearxngBinaryError(`No prebuilt SearXNG binary for ${host} (supported: ${supported}). Pass binaryPath or set SEARXNG_BINARY.`);
  }
  let path: string | undefined;
  try {
    path = await importPlatformPackage();
  } catch (cause) {
    const libc = target.libc ? ` It needs ${target.libc} 2.35 or newer, so it is not installed on musl systems.` : "";
    throw new SearxngBinaryError(
      `${packageName(target)} is not installed. It is an optional dependency of @searxng-js/searxng: ` +
        `reinstall without --omit=optional / --no-optional, or pass binaryPath.${libc}`,
      { cause },
    );
  }
  if (!path) throw new SearxngBinaryError(`${packageName(target)} did not provide a binary path`);
  return prepareBinary(path);
}

/** Embedded files of a compiled Bun executable: /$bunfs/... or B:\~BUN\... on Windows. */
export function isEmbeddedPath(path: string): boolean {
  return /^(\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/.test(path);
}

function cacheDir(): string {
  if (process.platform === "win32") return process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  const xdg = process.env.XDG_CACHE_HOME;
  return xdg?.startsWith("/") ? xdg : join(homedir(), ".cache");
}

/**
 * Makes a binary path spawnable: unpacks a binary embedded in a compiled Bun
 * executable, and restores the executable bit some package managers drop.
 */
export async function prepareBinary(path: string): Promise<string> {
  if (isEmbeddedPath(path)) return unpackEmbedded(path);
  if (process.platform !== "win32") {
    try {
      await access(path, constants.X_OK);
    } catch {
      try {
        await chmod(path, 0o755);
      } catch (cause) {
        throw new SearxngBinaryError(`SearXNG binary at ${path} is missing or not executable`, { cause });
      }
    }
  }
  return path;
}

async function unpackEmbedded(path: string): Promise<string> {
  // Bun names embedded files <name>-<content hash>.<ext>, so the name identifies
  // the content. Without an extension the name ends in "." (Windows drops that).
  const dir = join(cacheDir(), "searxng-js", basename(path).replace(/\.+$/, ""));
  const target = join(dir, process.platform === "win32" ? "searxng.exe" : "searxng");
  const { size } = await stat(path);
  const unpacked = async () => (await stat(target).catch(() => undefined))?.size === size;
  if (await unpacked()) return target;
  await mkdir(dir, { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, await readFile(path), { mode: 0o755 });
  try {
    await rename(temp, target);
  } catch (err) {
    // Another process unpacked it first (and on Windows may be running it).
    await rm(temp, { force: true });
    if (!(await unpacked())) throw err;
  }
  return target;
}
