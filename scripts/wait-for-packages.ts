/**
 * Waits until every platform package resolves at a version on the npm registry.
 *
 *   bun scripts/wait-for-packages.ts --version 0.1.0 [--timeout 600] [--interval 10]
 *
 * The release workflow publishes the platform packages first and runs this
 * before the main package, whose optionalDependencies must all be installable.
 * Installers read the abbreviated packument, and the registry CDN caches it
 * (404s included), so each probe asks for that representation without cache,
 * and a package needs two successful polls in a row.
 */
import { packageName, TARGETS } from "../packages/client/src/targets.ts";
import { args, fail, log } from "./lib.ts";

const values = args({ version: { type: "string" }, timeout: { type: "string" }, interval: { type: "string" } });
const version = values.version ?? fail("--version is required");
const timeoutMs = Number(values.timeout ?? 600) * 1000;
const intervalMs = Number(values.interval ?? 10) * 1000;
const ACCEPT = "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*";

async function resolves(name: string): Promise<boolean> {
  try {
    const url = `https://registry.npmjs.org/${name.replace("/", "%2f")}?t=${Date.now()}-${Math.random()}`;
    const res = await fetch(url, { headers: { accept: ACCEPT, "cache-control": "no-cache" }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return false;
    const packument = (await res.json()) as { versions?: Record<string, unknown> };
    return Boolean(packument.versions?.[version]);
  } catch {
    return false;
  }
}

const names = TARGETS.map(packageName);
const streak = new Map(names.map((n) => [n, 0]));
const deadline = Date.now() + timeoutMs;
while (true) {
  for (const name of names) streak.set(name, (await resolves(name)) ? (streak.get(name) ?? 0) + 1 : 0);
  const pending = names.filter((n) => (streak.get(n) ?? 0) < 2);
  if (pending.length === 0) break;
  if (Date.now() > deadline) fail(`not resolvable at ${version} after ${timeoutMs / 1000} s: ${pending.join(", ")}`);
  log(`waiting for ${pending.join(", ")}@${version}`);
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
log(`all platform packages resolve at ${version}`);
