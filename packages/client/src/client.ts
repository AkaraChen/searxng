import type { SearchParams, SearchResponse, SearxngConfig } from "./types.ts";

/** The subset of `fetch` the client uses; pass your own for proxies, retries or tests. */
export type FetchLike = (url: string, init: { headers?: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

export interface ClientOptions {
  /** e.g. `http://127.0.0.1:8888` (a trailing slash or path prefix is fine). */
  baseUrl: string;
  fetch?: FetchLike;
  headers?: Record<string, string>;
  /** Per-request timeout; default 30 s. Combined with a caller's `signal`. */
  timeoutMs?: number;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

/** Non-2xx response from SearXNG; `body` is the raw response text. */
export class SearxngError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, url: string) {
    let detail = body.slice(0, 200);
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      if (typeof parsed.error === "string") detail = parsed.error;
    } catch {}
    super(`SearXNG ${status} for ${url}: ${detail}`);
    this.name = "SearxngError";
    this.status = status;
    this.body = body;
  }
}

export interface SearxngClient {
  readonly baseUrl: string;
  search(params: SearchParams, options?: RequestOptions): Promise<SearchResponse>;
  config(options?: RequestOptions): Promise<SearxngConfig>;
  /** `true` when `/healthz` answers `OK`; never throws. */
  health(options?: RequestOptions): Promise<boolean>;
}

const list = (value: string | readonly string[]) => (typeof value === "string" ? value : value.join(","));

export function searchQuery(params: SearchParams): URLSearchParams {
  const query = new URLSearchParams({ q: params.q, format: "json" });
  if (params.categories !== undefined) query.set("categories", list(params.categories));
  if (params.engines !== undefined) query.set("engines", list(params.engines));
  if (params.language !== undefined) query.set("language", params.language);
  if (params.page !== undefined) query.set("pageno", String(params.page));
  if (params.timeRange !== undefined) query.set("time_range", params.timeRange);
  if (params.safeSearch !== undefined) query.set("safesearch", String(params.safeSearch));
  return query;
}

export function createClient(options: ClientOptions): SearxngClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? 30_000;

  async function request(path: string, init: RequestOptions = {}): Promise<Response> {
    const url = `${baseUrl}${path}`;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    const res = await doFetch(url, { headers: options.headers, signal });
    if (!res.ok) throw new SearxngError(res.status, await res.text(), url);
    return res;
  }

  return {
    baseUrl,
    async search(params, init) {
      return (await (await request(`/search?${searchQuery(params)}`, init)).json()) as SearchResponse;
    },
    async config(init) {
      return (await (await request("/config", init)).json()) as SearxngConfig;
    },
    async health(init) {
      try {
        return (await (await request("/healthz", init)).text()) === "OK";
      } catch {
        return false;
      }
    },
  };
}
