import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractedServer, prepareBinary, resolveBinary } from "./binary.ts";
import { createClient, type SearxngClient } from "./client.ts";

/** Settings used when no `settingsPath` is given: JSON API on, no limiter, no valkey. */
export const DEFAULT_SETTINGS = `use_default_settings: true
general:
  instance_name: searxng
search:
  formats: [html, json]
server:
  limiter: false
  image_proxy: false
valkey:
  url: false
`;

export interface StartServerOptions {
  /**
   * The SearXNG executable. Default: `$SEARXNG_BINARY`, else the binary of the
   * installed platform package (see {@link resolveBinary}).
   */
  binaryPath?: string;
  /** Extra arguments for the executable. */
  args?: readonly string[];
  /** Default: a free port. */
  port?: number;
  /** Default: `127.0.0.1`. */
  host?: string;
  /**
   * A SearXNG settings.yml. Default: {@link DEFAULT_SETTINGS} in a temporary
   * directory. Port, host and secret are always passed as SEARXNG_PORT,
   * SEARXNG_BIND_ADDRESS and SEARXNG_SECRET, which override the file.
   */
  settingsPath?: string;
  /** Default: random per start. */
  secretKey?: string;
  /** Extra environment for the server process. */
  env?: Record<string, string>;
  /** How long to wait for `/healthz`; default 60 s (the first start unpacks the binary). */
  timeoutMs?: number;
  /**
   * Run the server executable that an earlier start of the binary extracted,
   * without the binary's onefile launcher (about 0.5 s faster, 35 MiB less).
   * Falls back to the binary when there is none or it exits before it is ready.
   * Default: true.
   */
  reuseExtraction?: boolean;
  /** Aborting before the server is ready kills it and rejects. */
  signal?: AbortSignal;
  /** Server output (stdout and stderr), as it arrives. */
  onOutput?: (chunk: string) => void;
}

export interface SearxngServer extends AsyncDisposable {
  readonly url: string;
  readonly port: number;
  readonly pid: number;
  /** What was spawned: the binary, or the server executable it extracted earlier. */
  readonly executable: string;
  readonly client: SearxngClient;
  /** Resolves with the exit code (or null when killed by a signal) once the process exits. */
  readonly exited: Promise<number | null>;
  /**
   * SIGTERM, then SIGKILL after `graceMs` (default 10 s); on Windows, kills the
   * process tree at once. Removes generated settings. Idempotent.
   *
   * When the binary runs, its onefile launcher stops its server child itself,
   * SIGKILLing it after 5 s; a SIGKILL to the launcher before that would orphan
   * the child.
   */
  stop(graceMs?: number): Promise<void>;
}

export class StartServerError extends Error {
  /** The last few KB of server output. */
  readonly output: string;

  constructor(message: string, output: string) {
    super(output ? `${message}\n--- server output ---\n${output}` : message);
    this.name = "StartServerError";
    this.output = output;
  }
}

async function freePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, host, () => {
      const address = srv.address();
      srv.close(() => (address && typeof address === "object" ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startServer(options: StartServerOptions = {}): Promise<SearxngServer> {
  const given = options.binaryPath ?? process.env.SEARXNG_BINARY;
  let binaryPath: string;
  try {
    binaryPath = given ? await prepareBinary(given) : await resolveBinary();
  } catch (err) {
    throw new StartServerError(`cannot start SearXNG: ${(err as Error).message}`, "");
  }
  const extraction = options.reuseExtraction === false ? undefined : await extractedServer(binaryPath).catch(() => undefined);
  options.signal?.throwIfAborted();
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? (await freePort(host));

  let tempDir: string | undefined;
  let settingsPath = options.settingsPath;
  if (!settingsPath) {
    tempDir = await mkdtemp(join(tmpdir(), "searxng-"));
    settingsPath = join(tempDir, "settings.yml");
    await writeFile(settingsPath, DEFAULT_SETTINGS);
  }
  const removeTempDir = async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  };

  const env = {
    ...process.env,
    ...options.env,
    SEARXNG_SETTINGS_PATH: settingsPath,
    SEARXNG_PORT: String(port),
    SEARXNG_BIND_ADDRESS: host,
    SEARXNG_SECRET: options.secretKey ?? randomBytes(32).toString("hex"),
    // Nothing is written to stdin: the server exits when the pipe closes,
    // which also happens when this process dies without running exit handlers.
    SEARXNG_EXIT_ON_STDIN_EOF: "1",
    ...(extraction ? { SEARXNG_EXTRACTION_RECORD: extraction.record } : {}),
  };
  const timeoutMs = options.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;

  const launch = async (executable: string): Promise<SearxngServer> => {
    const child: ChildProcess = spawn(executable, options.args ?? [], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let output = "";
    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      output = (output + text).slice(-8192);
      options.onOutput?.(text);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    let spawnError: Error | undefined;
    const exited = new Promise<number | null>((resolve) => {
      child.once("error", (err) => {
        spawnError = err;
        resolve(null);
      });
      child.once("exit", (code) => resolve(code));
    });
    let hasExited = false;
    void exited.then(() => {
      hasExited = true;
    });

    // On Windows, kill() is TerminateProcess on the onefile bootstrap only and
    // its server child keeps running (and holding the port): kill the tree.
    const taskkill = ["/pid", String(child.pid), "/T", "/F"];
    const windowsTree = process.platform === "win32" && child.pid !== undefined;

    // Do not leave the server behind when this process exits.
    const killOnExit = () => {
      if (windowsTree) spawnSync("taskkill", taskkill, { stdio: "ignore", windowsHide: true });
      child.kill("SIGKILL");
    };
    process.once("exit", killOnExit);

    let killing: Promise<void> | undefined;
    const kill = (graceMs: number) => {
      killing ??= (async () => {
        if (!hasExited && windowsTree) {
          await new Promise((resolve) =>
            spawn("taskkill", taskkill, { stdio: "ignore", windowsHide: true })
              .once("error", resolve)
              .once("exit", resolve),
          );
        }
        if (!hasExited) {
          child.kill("SIGTERM");
          const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
          await exited;
          clearTimeout(timer);
        }
        process.removeListener("exit", killOnExit);
      })();
      return killing;
    };

    const url = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
    const client = createClient({ baseUrl: url });
    try {
      while (!(await client.health({ signal: AbortSignal.timeout(2000) }))) {
        if (spawnError) throw new StartServerError(`cannot start ${executable}: ${spawnError.message}`, output);
        if (hasExited) throw new StartServerError(`SearXNG exited with code ${child.exitCode} before it was ready`, output);
        options.signal?.throwIfAborted();
        if (Date.now() > deadline) throw new StartServerError(`SearXNG did not answer /healthz within ${timeoutMs} ms`, output);
        await sleep(100);
      }
    } catch (err) {
      await kill(0);
      throw err;
    }

    let stopping: Promise<void> | undefined;
    const stop = (graceMs = 10_000) => {
      stopping ??= kill(graceMs).then(removeTempDir);
      return stopping;
    };
    return {
      url,
      port,
      pid: child.pid as number,
      executable,
      client,
      exited,
      stop,
      [Symbol.asyncDispose]: () => stop(),
    };
  };

  try {
    if (extraction?.executable) {
      try {
        return await launch(extraction.executable);
      } catch (err) {
        if (options.signal?.aborted || Date.now() > deadline) throw err;
        // The extraction may be damaged: the binary checks every file of it and
        // repairs what differs. It writes a new record once it runs.
        await rm(extraction.record, { force: true });
      }
    }
    return await launch(binaryPath);
  } catch (err) {
    await removeTempDir();
    throw err;
  }
}
