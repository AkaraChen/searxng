/**
 * Installs the packed packages into a fresh project through a local registry,
 * checks that the package manager picked exactly this platform's binary
 * package, and starts SearXNG with `startServer()` and no binary path.
 *
 *   bun scripts/install-test.ts --tarballs dist-npm/tarballs --pm npm|bun [--compile]
 *
 * npm runs the check with Node, bun with Bun. --compile (bun only) also builds
 * the check with `bun build --compile` and runs that executable with
 * node_modules moved away, as an app like sex ships it: the binary must come
 * from the executable itself and be unpacked to the cache directory.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageName, TARGETS } from "../packages/client/src/targets.ts";
import { args, DEFAULT_NPM_DIR, fail, log, MAIN_PACKAGE, run, tarballManifest } from "./lib.ts";
import { startLocalRegistry } from "./local-registry.ts";

const CHECK = `
import { resolveBinary, startServer } from "${MAIN_PACKAGE}";

try {
  const binary = await resolveBinary();
  const server = await startServer({ timeoutMs: 180_000 });
  try {
    const config = await server.client.config();
    if (config.engines.length < 100) throw new Error("only " + config.engines.length + " engines loaded");
    let results = -1; // the search needs the network; reported, not enforced
    try {
      const res = await server.client.search({ q: "python programming language", engines: ["wikipedia"] });
      results = res.results.length + res.infoboxes.length;
    } catch (err) {
      console.error("search failed:", err);
    }
    console.log("CHECK " + JSON.stringify({ binary, engines: config.engines.length, results }));
  } finally {
    await server.stop();
  }
  process.exit(0);
} catch (err) {
  console.error(err);
  process.exit(1);
}
`;

const values = args({ tarballs: { type: "string" }, pm: { type: "string" }, compile: { type: "boolean" } });
const tarballs = values.tarballs ?? join(DEFAULT_NPM_DIR, "tarballs");
const pm = values.pm ?? "npm";
if (pm !== "npm" && pm !== "bun") fail("--pm must be npm or bun");
if (values.compile && pm !== "bun") fail("--compile needs --pm bun");
const target = TARGETS.find((t) => t.os === process.platform && t.cpu === process.arch);
if (!target) fail(`no target for ${process.platform}-${process.arch}`);

let version = "";
for (const file of (await readdir(tarballs)).filter((f) => f.endsWith(".tgz"))) {
  const manifest = tarballManifest(await readFile(join(tarballs, file)));
  if (manifest.name === MAIN_PACKAGE) version = manifest.version;
}
if (!version) fail(`no ${MAIN_PACKAGE} tarball in ${tarballs}`);

const work = await mkdtemp(join(tmpdir(), "searxng-install-"));
const project = join(work, "project");
const registry = await startLocalRegistry(tarballs);
log(`local registry ${registry.url} serves ${registry.packages.join(", ")}`);

function parseCheck(output: string): { binary: string; engines: number; results: number } {
  const line = output.split(/\r?\n/).find((l) => l.startsWith("CHECK "));
  if (!line) fail(`the check printed no result:\n${output}`);
  return JSON.parse(line.slice("CHECK ".length));
}

try {
  await mkdir(project);
  await writeFile(
    join(project, "package.json"),
    JSON.stringify({ name: "searxng-install-test", private: true, type: "module", dependencies: { [MAIN_PACKAGE]: version } }, null, 2),
  );
  await writeFile(join(project, "check.mjs"), CHECK);
  const env = { ...process.env, npm_config_registry: registry.url, npm_config_cache: join(work, "npm-cache"), BUN_INSTALL_CACHE_DIR: join(work, "bun-cache") };
  if (pm === "npm") {
    await run("npm", ["install", "--no-audit", "--no-fund", "--registry", registry.url], { cwd: project, env });
  } else {
    await writeFile(join(project, "bunfig.toml"), `[install]\nregistry = "${registry.url}"\n`);
    await run("bun", ["install"], { cwd: project, env });
  }

  const scope = join(project, "node_modules", "@searxng-js");
  const installed = (await readdir(scope)).filter((name) => name !== "searxng").map((name) => `@searxng-js/${name}`);
  log(`installed platform packages: ${installed.join(", ") || "none"}`);
  if (installed.length !== 1 || installed[0] !== packageName(target)) fail(`expected only ${packageName(target)}`);

  const runtime = pm === "npm" ? "node" : "bun";
  const plain = parseCheck(await run(runtime, ["check.mjs"], { cwd: project, env, capture: true }));
  log(`${runtime}: ${JSON.stringify(plain)}`);
  if (!plain.binary.replaceAll("\\", "/").includes(`node_modules/@searxng-js/${target.id}/`)) fail(`binary not from ${packageName(target)}: ${plain.binary}`);

  if (values.compile) {
    const exe = join(work, "compiled", process.platform === "win32" ? "check.exe" : "check");
    await run("bun", ["build", "--compile", "check.mjs", "--outfile", exe], { cwd: project, env });
    await rename(join(project, "node_modules"), join(project, "node_modules.off"));
    const cache = join(work, "cache");
    const compiledEnv = { ...env, XDG_CACHE_HOME: cache, LOCALAPPDATA: cache };
    const compiled = parseCheck(await run(exe, [], { cwd: join(work, "compiled"), env: compiledEnv, capture: true }));
    log(`compiled: ${JSON.stringify(compiled)}`);
    if (!compiled.binary.startsWith(join(cache, "searxng-js"))) fail(`compiled binary not unpacked to ${cache}: ${compiled.binary}`);
    if (!existsSync(compiled.binary)) fail(`${compiled.binary} does not exist`);
  }
  log("install test passed");
} finally {
  await registry.close();
  await rm(work, { recursive: true, force: true }).catch(() => {});
}
