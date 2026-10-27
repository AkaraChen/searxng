/**
 * The platforms with a prebuilt binary. Each has an npm package
 * `@searxng-js/<id>` that holds `bin/<executable>`; the main package lists them
 * all as optional dependencies, and npm, pnpm and bun install the one whose
 * os/cpu/libc fields match. The release scripts and CI read this list too.
 */
export interface Target {
  id: "linux-x64" | "darwin-arm64" | "win32-x64";
  os: NodeJS.Platform;
  cpu: NodeJS.Architecture;
  /** Linux only: the build needs glibc 2.35 or newer. */
  libc?: "glibc";
  executable: string;
}

export const TARGETS: readonly Target[] = [
  { id: "linux-x64", os: "linux", cpu: "x64", libc: "glibc", executable: "searxng" },
  { id: "darwin-arm64", os: "darwin", cpu: "arm64", executable: "searxng" },
  { id: "win32-x64", os: "win32", cpu: "x64", executable: "searxng.exe" },
];

export const SCOPE = "@searxng-js";

export function packageName(target: Target): string {
  return `${SCOPE}/${target.id}`;
}
