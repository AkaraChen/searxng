/**
 * Packs the assembled platform packages and the main package into tarballs.
 *
 *   bun scripts/pack.ts [--npm-dir dist-npm] [--require-all]
 *
 * The main package gets `optionalDependencies` on every assembled platform
 * package at its own version, injected only for the duration of `npm pack`:
 * the committed package.json carries none, so development installs never look
 * for platform packages that are not published.
 * Output: <npm-dir>/tarballs/*.tgz and SHA256SUMS.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { packageName, TARGETS } from "../packages/client/src/targets.ts";
import { args, CLIENT_DIR, DEFAULT_NPM_DIR, fail, log, readJson, run, sha256File } from "./lib.ts";

const values = args({ "npm-dir": { type: "string" }, "require-all": { type: "boolean" } });
const npmDir = values["npm-dir"] ?? DEFAULT_NPM_DIR;
const out = join(npmDir, "tarballs");
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const manifestPath = join(CLIENT_DIR, "package.json");
const original = await readFile(manifestPath, "utf8");
const manifest = JSON.parse(original) as { version: string; optionalDependencies?: Record<string, string> };

const present = TARGETS.filter((t) => existsSync(join(npmDir, t.id, "package.json")));
const missing = TARGETS.filter((t) => !present.includes(t));
if (values["require-all"] && missing.length) fail(`not assembled: ${missing.map((t) => t.id).join(", ")}`);
if (present.length === 0) fail(`no assembled packages in ${npmDir}`);

for (const t of present) {
  const dir = join(npmDir, t.id);
  const pkg = await readJson<{ version: string }>(join(dir, "package.json"));
  if (pkg.version !== manifest.version) fail(`${packageName(t)} is ${pkg.version}, the main package is ${manifest.version}; assemble again`);
  await run("npm", ["pack", "--pack-destination", out], { cwd: dir });
}

await run("bun", ["run", "build"], { cwd: CLIENT_DIR });
const optionalDependencies = Object.fromEntries(present.map((t) => [packageName(t), manifest.version]));
await writeFile(manifestPath, `${JSON.stringify({ ...manifest, optionalDependencies }, null, 2)}\n`);
try {
  await run("npm", ["pack", "--pack-destination", out], { cwd: CLIENT_DIR });
} finally {
  await writeFile(manifestPath, original);
}

const tarballs = (await readdir(out)).filter((f) => f.endsWith(".tgz")).sort();
const sums = await Promise.all(tarballs.map(async (f) => `${await sha256File(join(out, f))}  ${f}`));
await writeFile(join(out, "SHA256SUMS"), `${sums.join("\n")}\n`);
log(`packed ${tarballs.length} tarballs into ${out}:\n${sums.join("\n")}`);
