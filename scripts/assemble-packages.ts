/**
 * Assembles the per-platform npm packages from the CI build artifacts.
 *
 *   bun scripts/assemble-packages.ts --artifacts <dir> [--out dist-npm] [--require-all]
 *
 * <dir> holds the `searxng-<target>` artifacts of the ci workflow, each with
 * build/searxng[.exe], build/build-info.json and build/licenses/. For every
 * target found this writes <out>/<target>/ with package.json, bin/, index.js
 * (Node: the binary's path), index.bun.js (Bun: a file import, so that
 * `bun build --compile` embeds the binary), BUILD-INFO.json, LICENSE,
 * THIRD-PARTY-NOTICES.md, licenses/ and README.md.
 */
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { packageName, type Target, TARGETS } from "../packages/client/src/targets.ts";
import {
  args,
  CLIENT_DIR,
  DEFAULT_NPM_DIR,
  fail,
  log,
  MAIN_PACKAGE,
  REPOSITORY,
  REPOSITORY_URL,
  ROOT,
  readJson,
  run,
  sha256File,
} from "./lib.ts";

interface BuildInfo {
  size: number;
  searxng_commit: string;
  platform: string;
  python: string;
  cache_subdir: string;
}

const values = args({
  artifacts: { type: "string" },
  out: { type: "string" },
  "require-all": { type: "boolean" },
});
if (!values.artifacts) fail("--artifacts <dir> is required");
const outDir = values.out ?? DEFAULT_NPM_DIR;
const { version } = await readJson<{ version: string }>(join(CLIENT_DIR, "package.json"));
const sourceCommit = process.env.GITHUB_SHA ?? (await run("git", ["rev-parse", "HEAD"], { cwd: ROOT, capture: true })).trim();

const artifactDir = (t: Target) => join(values.artifacts as string, `searxng-${t.id}`, "build");
const present = TARGETS.filter((t) => existsSync(join(artifactDir(t), t.executable)));
const missing = TARGETS.filter((t) => !present.includes(t));
if (values["require-all"] && missing.length) fail(`no binary for: ${missing.map((t) => t.id).join(", ")}`);
if (present.length === 0) fail(`no binaries under ${values.artifacts}`);

function describe(t: Target): string {
  return t.libc ? `${t.id} (${t.libc} 2.35 or newer)` : t.id;
}

function manifest(t: Target, info: BuildInfo) {
  return {
    name: packageName(t),
    version,
    description: `SearXNG as one executable for ${describe(t)}, used by ${MAIN_PACKAGE}`,
    license: "AGPL-3.0-or-later",
    repository: { type: "git", url: REPOSITORY_URL, directory: "nuitka" },
    os: [t.os],
    cpu: [t.cpu],
    ...(t.libc ? { libc: [t.libc] } : {}),
    type: "module",
    exports: {
      ".": { types: "./index.d.ts", bun: "./index.bun.js", default: "./index.js" },
      "./package.json": "./package.json",
    },
    files: ["bin", "index.js", "index.bun.js", "index.d.ts", "BUILD-INFO.json", "THIRD-PARTY-NOTICES.md", "licenses"],
    preferUnplugged: true,
    publishConfig: { access: "public" },
    searxng: { commit: info.searxng_commit, python: info.python, sourceCommit },
  };
}

function notices(info: BuildInfo): string {
  const source = `https://github.com/${REPOSITORY}/tree/v${version}`;
  return `# Third-party notices

\`bin/\` holds [SearXNG](https://github.com/searxng/searxng) (AGPL-3.0-or-later), compiled with
[Nuitka](https://nuitka.net) into one executable together with CPython ${info.python} and the Python
packages SearXNG needs.

## Corresponding source

- SearXNG: https://github.com/searxng/searxng/tree/${info.searxng_commit}
- Build scripts, entry point, stubs and Nuitka plugins: ${source} (\`nuitka/\`), built from commit ${sourceCommit}

## Licences of the bundled components

The binary is AGPL-3.0-or-later as a whole. \`licenses/\` holds the full licence texts of its parts:

- \`licenses/<distribution>-<version>/\`: the licence files of CPython and of every Python
  distribution installed for the build, as shipped in their wheels. Some (pygments, typer, valkey
  and their dependencies) are installed but replaced by stubs and are not in the binary.
- \`licenses/static/\`: the C libraries that wheels link statically without shipping their licences:
  curl-impersonate, libcurl, BoringSSL, nghttp2, ngtcp2, nghttp3, c-ares, brotli, zstd, zlib and
  libidn2 (in curl_cffi), libiconv (in lxml), libyaml (in PyYAML), libffi (in cffi). Its README.md
  lists versions and how each is used; libidn2 and libiconv are used under GPL-2.0-or-later.
- \`licenses/NATIVE-LIBRARIES.txt\`: every shared library and extension module in the binary.

lxml's own licence file covers libxml2 and libxslt (MIT); babel ships CLDR data (Unicode licence,
in babel's licence file). Nuitka's runtime, compiled into the binary, is AGPL-3.0 with the Nuitka
Runtime Library Exception (licenses/Nuitka-*).
`;
}

function readme(t: Target, info: BuildInfo, sha256: string): string {
  return `# ${packageName(t)}

[SearXNG](https://github.com/searxng/searxng) as one self-contained executable for \`${describe(t)}\`.
Install [\`${MAIN_PACKAGE}\`](https://www.npmjs.com/package/${MAIN_PACKAGE}) instead: it depends on this
package through \`optionalDependencies\`, and its \`startServer()\` runs this binary.

| | |
| --- | --- |
| SearXNG | https://github.com/searxng/searxng/tree/${info.searxng_commit} |
| Built from | https://github.com/${REPOSITORY}/tree/${sourceCommit} |
| Python | ${info.python} |
| SHA-256 | \`${sha256}\` |

AGPL-3.0-or-later, like SearXNG; see LICENSE and THIRD-PARTY-NOTICES.md.
`;
}

// Every native library in a build must have its licence in nuitka/third-party-licenses
// (or come with a Python distribution whose licence files build.py collects).
const COVERED_NATIVE: RegExp[] = [
  /^_?[a-z0-9_]+\.(so|pyd)$/, // CPython extension modules and cffi's _cffi_backend
  /^(lxml|markupsafe|msgspec|yaml|curl_cffi|curl_cffi\.libs)\//, // wheels; their libraries are in static/
  /^(libpython3[.0-9]*\.(so[.0-9]*|dylib)|python3[0-9]*\.dll)$/,
  /^(libssl|libcrypto)[-.0-9]*\.(so[.0-9]*|dylib|dll)$/,
  /^(libffi|libbz2|liblzma|libsqlite3|libreadline|libtinfo|libuuid)[-.0-9]*\.(so[.0-9]*|dylib|dll)$/,
  /^sqlite3\.dll$/,
  /^vcruntime140(_1)?\.dll$/,
];

async function checkNativeLicences(t: Target, src: string): Promise<void> {
  const list = join(src, "licenses", "NATIVE-LIBRARIES.txt");
  if (!existsSync(list)) {
    if (values["require-all"]) fail(`${t.id}: licenses/NATIVE-LIBRARIES.txt is missing`);
    return;
  }
  const libs = (await readFile(list, "utf8")).split(/\r?\n/).filter(Boolean);
  const unknown = libs.filter((lib) => !COVERED_NATIVE.some((re) => re.test(lib)));
  if (unknown.length) {
    fail(`${t.id}: no licence on record for ${unknown.join(", ")}; add it to nuitka/third-party-licenses and COVERED_NATIVE`);
  }
}

const ENTRY_NODE = (exe: string) => `import { fileURLToPath } from "node:url";

export default fileURLToPath(new URL("./bin/${exe}", import.meta.url));
`;
// A file import: inside `bun build --compile` output this path points into the
// executable (Bun embeds the file); @searxng-js/searxng unpacks it before use.
const ENTRY_BUN = (exe: string) => `import path from "./bin/${exe}" with { type: "file" };

export default path;
`;
const ENTRY_TYPES = "declare const path: string;\nexport default path;\n";

for (const t of present) {
  const src = artifactDir(t);
  const dir = join(outDir, t.id);
  const info = await readJson<BuildInfo>(join(src, "build-info.json"));
  await checkNativeLicences(t, src);
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, "bin"), { recursive: true });
  const binary = join(dir, "bin", t.executable);
  await cp(join(src, t.executable), binary);
  await chmod(binary, 0o755); // artifacts drop the executable bit
  const sha256 = await sha256File(binary);
  if (existsSync(join(src, "licenses"))) await cp(join(src, "licenses"), join(dir, "licenses"), { recursive: true });
  else if (values["require-all"]) fail(`${t.id}: build/licenses is missing`);
  await cp(join(ROOT, "nuitka", "third-party-licenses"), join(dir, "licenses", "static"), { recursive: true });
  await cp(join(ROOT, "LICENSE"), join(dir, "LICENSE"));
  const buildInfo = { ...info, binary: `bin/${t.executable}`, sha256, package: packageName(t), version, sourceCommit };
  await writeFile(join(dir, "BUILD-INFO.json"), `${JSON.stringify(buildInfo, null, 2)}\n`);
  await writeFile(join(dir, "package.json"), `${JSON.stringify(manifest(t, info), null, 2)}\n`);
  await writeFile(join(dir, "index.js"), ENTRY_NODE(t.executable));
  await writeFile(join(dir, "index.bun.js"), ENTRY_BUN(t.executable));
  await writeFile(join(dir, "index.d.ts"), ENTRY_TYPES);
  await writeFile(join(dir, "THIRD-PARTY-NOTICES.md"), notices(info));
  await writeFile(join(dir, "README.md"), readme(t, info, sha256));
  log(`${packageName(t)}@${version}: ${(info.size / 1048576).toFixed(1)} MiB, sha256 ${sha256.slice(0, 12)}…`);
}
