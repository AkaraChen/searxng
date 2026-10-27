// Hand-written types for SearXNG's JSON API (SearXNG has no OpenAPI spec).
// Source of truth: searx/webapp.py (`/search`, `/config`) and
// searx/webutils.py `get_json_response` at the commit pinned in nuitka/build.py.

/** Categories of SearXNG's default settings; instances may add their own. */
export type Category =
  | "general"
  | "images"
  | "videos"
  | "news"
  | "map"
  | "music"
  | "it"
  | "science"
  | "files"
  | "social media"
  | "web"
  | "books"
  | "apps"
  | "packages"
  | "repos"
  | "q&a"
  | "scientific publications"
  | "dictionaries"
  | "currency"
  | "weather"
  | (string & {});

export type TimeRange = "day" | "week" | "month" | "year";

/** 0 = off, 1 = moderate, 2 = strict. */
export type SafeSearch = 0 | 1 | 2;

export interface SearchParams {
  /** Query; may contain SearXNG syntax such as `site:`, `!engine` or `:lang`. */
  q: string;
  categories?: Category | readonly Category[];
  /** Engine names as in `/config` (e.g. `"wikipedia"`, `"google news"`). */
  engines?: string | readonly string[];
  /** A SearXNG locale tag: `"en"`, `"zh-CN"`, `"de-CH"`, `"all"` or `"auto"`. */
  language?: string;
  /** 1-based page number. */
  page?: number;
  timeRange?: TimeRange;
  safeSearch?: SafeSearch;
}

/** `urllib.parse.urlparse` result: scheme, netloc, path, params, query, fragment. */
export type ParsedUrl = [string, string, string, string, string, string];

/**
 * A search result. Fields beyond the common ones depend on the result
 * template (e.g. `images.html`, `videos.html`, `map.html`, `paper.html`).
 */
export interface Result {
  url: string | null;
  title: string;
  content: string;
  /** Engine that produced this copy of the result. */
  engine: string;
  /** All engines that returned the result (merged by URL). */
  engines: string[];
  positions: number[];
  score: number;
  category: string;
  template: string;
  parsed_url: ParsedUrl | null;
  img_src?: string;
  thumbnail?: string;
  thumbnail_src?: string;
  iframe_src?: string;
  audio_src?: string;
  /** ISO 8601 date-time, when the engine provides one. */
  publishedDate?: string | null;
  pubdate?: string;
  length?: string | number | null;
  views?: string;
  author?: string;
  metadata?: string;
  priority?: "" | "high" | "low";
  [field: string]: unknown;
}

/** Direct answers from answerers and plugins (calculator, hashes, units, ...). */
export interface Answer {
  answer: string;
  url: string | null;
  engine: string;
  template: string;
  parsed_url: ParsedUrl | null;
  [field: string]: unknown;
}

export interface InfoboxUrl {
  title: string;
  url: string;
  official?: boolean;
  entity?: string;
}

export interface InfoboxAttribute {
  label: string;
  value?: string;
  image?: { src: string; alt?: string };
  entity?: string;
}

export interface Infobox {
  infobox: string;
  id?: string;
  content?: string;
  img_src?: string;
  urls?: InfoboxUrl[];
  attributes?: InfoboxAttribute[];
  engine: string;
  engines?: string[];
  [field: string]: unknown;
}

/** [engine name, error message], e.g. `["brave", "too many requests"]`. */
export type UnresponsiveEngine = [engine: string, error: string];

export interface SearchResponse {
  query: string;
  results: Result[];
  answers: Answer[];
  corrections: string[];
  infoboxes: Infobox[];
  suggestions: string[];
  unresponsive_engines: UnresponsiveEngine[];
}

export interface EngineInfo {
  name: string;
  shortcut: string;
  categories: string[];
  enabled: boolean;
  paging: boolean;
  safesearch: boolean;
  time_range_support: boolean;
  language_support: boolean;
  languages: string[];
  regions: string[];
  timeout: number;
}

export interface PluginInfo {
  name: string;
  enabled: boolean;
}

export interface SearxngConfig {
  instance_name: string;
  version: string;
  categories: string[];
  engines: EngineInfo[];
  plugins: PluginInfo[];
  /** Locale tag → display name. */
  locales: Record<string, string>;
  default_locale: string;
  default_theme: string;
  autocomplete: string;
  safe_search: SafeSearch;
  public_instance: boolean;
  default_doi_resolver: string;
  doi_resolvers: string[];
  brand: Record<string, string | false>;
  limiter: Record<string, boolean>;
}
