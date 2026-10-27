/**
 * One-time setup of npm trusted publishing. The owner of the @searxng-js npm
 * org runs it locally, right before pushing the first release tag:
 *
 *   bun scripts/bootstrap-npm.ts [--dry-run]
 *
 * npm can only trust packages that exist, and a new trust configuration
 * expires unless it publishes within 2 days. So this
 *   1. publishes a placeholder 0.0.0 of every package that does not exist yet
 *      and deprecates it,
 *   2. trusts .github/workflows/release.yml of AkaraChen/searxng (GitHub
 *      environment "npm") to publish every package,
 * and the v<version> tag must be pushed within 2 days afterwards.
 *
 * It uses a temporary npm config and logs in there with
 * `npm login --auth-type=web` (browser + 2FA); tokens from the environment or
 * your own config are ignored, since the trust endpoints reject them. npm asks
 * for 2FA again at the first publish or trust call. Re-running skips what is
 * done. Needs npm 11.15 or newer.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageName, TARGETS } from "../packages/client/src/targets.ts";
import { args, fail, log, MAIN_PACKAGE, RELEASE_ENVIRONMENT, RELEASE_WORKFLOW, REPOSITORY, REPOSITORY_URL, run } from "./lib.ts";

const REGISTRY = "https://registry.npmjs.org/";
const PLACEHOLDER = "0.0.0";
const DEPRECATION = "Placeholder that let npm trusted publishing be set up; install 0.1.0 or later.";

const values = args({ "dry-run": { type: "boolean" } });
const packages = [...TARGETS.map(packageName), MAIN_PACKAGE];

const npmVersion = (await run("npm", ["--version"], { capture: true })).trim();
const [major = 0, minor = 0] = npmVersion.split(".").map(Number);
if (major < 11 || (major === 11 && minor < 15)) fail(`npm ${npmVersion} is too old; run npm install -g npm@^11.15.0`);

const dir = await mkdtemp(join(tmpdir(), "searxng-npm-bootstrap-"));
const userconfig = join(dir, ".npmrc");
await writeFile(userconfig, `registry=${REGISTRY}\n`, { mode: 0o600 });
const env: NodeJS.ProcessEnv = {
  ...process.env,
  npm_config_userconfig: userconfig,
  npm_config_globalconfig: join(dir, "global-npmrc"),
  npm_config_registry: REGISTRY,
  NODE_AUTH_TOKEN: undefined,
  NPM_TOKEN: undefined,
  npm_config__authToken: undefined,
};
const npm = (argv: string[], capture = false) => run("npm", argv, { env, capture });
const exists = (name: string) => npm(["view", name, "name"], true).then(() => true, () => false);
let loggedIn = false;

try {
  const missing: string[] = [];
  for (const name of packages) if (!(await exists(name))) missing.push(name);
  log(`not on npm yet: ${missing.join(", ") || "none"}`);

  if (values["dry-run"]) {
    for (const name of missing) log(`would publish ${name}@${PLACEHOLDER} and deprecate it`);
    for (const name of packages) log(`would trust ${name} -> ${REPOSITORY} ${RELEASE_WORKFLOW} (environment ${RELEASE_ENVIRONMENT})`);
  } else {
    log("logging in to npm: a browser window opens; finish the login with 2FA");
    await npm(["login", "--auth-type=web"]);
    loggedIn = true;
    log(`logged in as ${(await npm(["whoami"], true)).trim()}`);

    for (const name of missing) {
      const pkgDir = join(dir, name.replace("/", "__"));
      await mkdir(pkgDir);
      const license = name === MAIN_PACKAGE ? "MIT" : "AGPL-3.0-or-later";
      const manifest = { name, version: PLACEHOLDER, description: DEPRECATION, license, repository: { type: "git", url: REPOSITORY_URL } };
      await writeFile(join(pkgDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      await writeFile(join(pkgDir, "README.md"), `# ${name}\n\n${DEPRECATION}\n\nSee https://github.com/${REPOSITORY}.\n`);
      await npm(["publish", pkgDir, "--access", "public"]);
    }
    for (const name of missing) await npm(["deprecate", `${name}@${PLACEHOLDER}`, DEPRECATION]);

    for (const name of packages) {
      const existing = await npm(["trust", "list", name, "--json"], true).catch(() => "");
      if (existing.trim() && existing.trim() !== "[]" && existing.trim() !== "{}") {
        log(`${name} already has a trust relationship, skipping`);
        continue;
      }
      await npm(["trust", "github", name, "--file", RELEASE_WORKFLOW, "--repo", REPOSITORY, "--env", RELEASE_ENVIRONMENT, "--allow-publish", "--yes"]);
    }
    log("done. Push the release tag within 2 days, or the trust configurations expire.");
  }
} finally {
  if (loggedIn) await npm(["logout"]).catch(() => {});
  await rm(dir, { recursive: true, force: true });
}
