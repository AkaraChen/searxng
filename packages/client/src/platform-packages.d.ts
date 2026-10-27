// The platform packages are optional dependencies that exist only in releases;
// each default-exports the path of its binary.
declare module "@searxng-js/linux-x64" {
  const path: string;
  export default path;
}
declare module "@searxng-js/darwin-arm64" {
  const path: string;
  export default path;
}
declare module "@searxng-js/win32-x64" {
  const path: string;
  export default path;
}
