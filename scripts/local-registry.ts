/**
 * A tiny npm registry for install tests: serves packages from local tarballs
 * and proxies everything else to the public registry, so npm and bun resolve
 * the platform packages through their real os/cpu/libc rules before anything
 * is published.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { tarballManifest } from "./lib.ts";

const UPSTREAM = "https://registry.npmjs.org";

export interface LocalRegistry {
  url: string;
  packages: string[];
  close(): Promise<void>;
}

export async function startLocalRegistry(tarballDir: string): Promise<LocalRegistry> {
  const local = new Map<string, { manifest: ReturnType<typeof tarballManifest>; tarball: Buffer; file: string }>();
  for (const file of (await readdir(tarballDir)).filter((f) => f.endsWith(".tgz"))) {
    const tarball = await readFile(join(tarballDir, file));
    const manifest = tarballManifest(tarball);
    local.set(manifest.name, { manifest, tarball, file });
  }

  let origin = "";
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const file = /^\/-\/tarballs\/(.+)$/.exec(url.pathname)?.[1];
      if (file) {
        const entry = [...local.values()].find((v) => v.file === decodeURIComponent(file));
        if (!entry) return void res.writeHead(404).end();
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": entry.tarball.length });
        return void res.end(entry.tarball);
      }
      const entry = local.get(decodeURIComponent(url.pathname.slice(1)));
      if (entry) {
        const { manifest, tarball, file } = entry;
        const version = {
          ...manifest,
          _id: `${manifest.name}@${manifest.version}`,
          dist: {
            tarball: `${origin}/-/tarballs/${encodeURIComponent(file)}`,
            shasum: createHash("sha1").update(tarball).digest("hex"),
            integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
          },
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        return void res.end(JSON.stringify({ name: manifest.name, "dist-tags": { latest: manifest.version }, versions: { [manifest.version]: version } }));
      }
      if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405).end();
      const upstream = await fetch(`${UPSTREAM}${url.pathname}${url.search}`, { headers: { accept: req.headers.accept ?? "application/json" } });
      res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream" });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      res.writeHead(502, { "Content-Type": "text/plain" }).end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url: `${origin}/`, packages: [...local.keys()], close: () => new Promise((resolve) => server.close(() => resolve())) };
}
