# searxng-js

[English](README.md) · **简体中文**

[![npm](https://img.shields.io/npm/v/@searxng-js/searxng)](https://www.npmjs.com/package/@searxng-js/searxng)
[![ci](https://github.com/AkaraChen/searxng/actions/workflows/ci.yml/badge.svg)](https://github.com/AkaraChen/searxng/actions/workflows/ci.yml)

给 Node / Bun 应用加上网页搜索：不要 API key，不要 Docker，不要 Python。`npm install` 之后调用 `startServer()`，本机就跑起一个私有的 [SearXNG](https://github.com/searxng/searxng) 元搜索引擎，并附带类型完整的客户端。

```ts
import { startServer } from "@searxng-js/searxng";

await using server = await startServer();
const { results } = await server.client.search({ q: "zig comptime", timeRange: "year" });
for (const r of results) console.log(r.title, r.url, r.engines);
// 离开作用域时服务自动停止
```

（`await using` 需要 Bun、Node 24+ 或经 TypeScript 编译；否则手动调用 `await server.stop()`。）

## 这是什么

SearXNG 是开源的元搜索引擎：把一次查询同时发给多个搜索引擎（可用的约 260 个，包括 Google、DuckDuckGo、Brave、Wikipedia、GitHub、arXiv 等），再把结果合并、排序。它本身是个 Python Web 应用，通常要用 Docker 或 Python 虚拟环境来部署。

本仓库把它变成一个可以直接装的依赖：

- **每个平台一个可执行文件。** 用 [Nuitka](https://nuitka.net) 把 SearXNG 连同 Python 运行时编译成单个文件，21–23 MiB，机器上不需要预装任何东西。
- **npm 包 `@searxng-js/searxng`。** 自动带上对应平台的二进制，负责启动、等待就绪、退出时关闭；另附 SearXNG JSON API 的类型化客户端。

## 能带来什么

- **没有 API key、没有配额、不按次计费。** 商业搜索 API 按查询收费；这里查询直接从你的机器发往各搜索引擎。
- **一个依赖搞定。** `npm install` 就是全部配置。用户不用装 Docker、Python 或系统包，也不用有人专门维护一台搜索服务器。
- **能塞进单文件应用。** `bun build --compile` 会把二进制嵌进你的可执行文件，发布一个文件就自带搜索能力。
- **干净退出。** 服务是你进程的子进程：调用 `stop()`、进程正常退出，甚至被 SIGKILL 强杀时，它都会跟着退出，不留孤儿进程。
- **多引擎聚合，更抗故障。** 每条结果都标明来自哪些引擎，`unresponsive_engines` 告诉你哪些引擎失败了。某个引擎把你封了，也不至于一无所获。
- **有类型。** 请求参数和响应都有 TypeScript 类型，不必翻 SearXNG 源码去猜返回了什么。

适合的场景：给 LLM Agent 做联网搜索工具、命令行工具、桌面应用、爬虫和调研脚本，以及需要真实搜索结果的集成测试。

## 安装

```sh
npm install @searxng-js/searxng   # 或 pnpm add / bun add / yarn add
```

需要 Node ≥ 20.3 或 Bun。包管理器只会安装与当前平台匹配的二进制包：

| 平台 | 包 | 说明 |
|---|---|---|
| Linux x64 | `@searxng-js/linux-x64` | glibc 2.35 及以上（Ubuntu 22.04、Debian 12 及更新版本）；不支持 musl/Alpine |
| macOS arm64 | `@searxng-js/darwin-arm64` | Apple 芯片 |
| Windows x64 | `@searxng-js/win32-x64` | |

其他平台可以[自行构建二进制](docs/internals.md#building-the-binary)，再通过 `binaryPath` 传入路径。

## 用法

### 启动服务并搜索

```ts
import { startServer, SearxngError } from "@searxng-js/searxng";

const server = await startServer();          // 在 127.0.0.1 上自动选空闲端口
console.log(server.url);                     // 例如 http://127.0.0.1:40213

try {
  const res = await server.client.search({
    q: "量子计算",
    language: "zh-CN",
    categories: ["general", "news"],
    page: 1,
    safeSearch: 1,
  });
  console.log(res.results.length, res.infoboxes, res.suggestions);
} catch (err) {
  if (err instanceof SearxngError) console.error(err.status, err.message);
} finally {
  await server.stop();
}
```

首次启动时二进制要先解压到用户缓存目录，最长约 4 秒（Windows；Linux 和 macOS 约 2 秒）。之后直接运行已解压的服务，不到 1 秒（Linux 上约 0.6 秒）。

`q` 支持 SearXNG 的查询语法，例如 `site:github.com`、`!wikipedia`、`:de`。

### 作为 LLM Agent 的搜索工具

```ts
const server = await startServer();

async function webSearch(query: string) {
  const { results } = await server.client.search({ q: query });
  return results.slice(0, 8).map((r) => ({ title: r.title, url: r.url, snippet: r.content }));
}
```

服务启动一次，之后每次调用复用即可。

### 打包进单个可执行文件

```sh
bun install --os=linux --cpu=x64   # 为每个目标平台安装对应的二进制包
bun build --compile --target=bun-linux-x64 app.ts
```

Bun 只会嵌入目标平台的二进制。首次运行时解压到 `~/.cache/searxng-js`（Windows 为 `%LOCALAPPDATA%\searxng-js`），之后复用。

### 自定义配置，或连接已有实例

```ts
await startServer({ settingsPath: "./settings.yml" });   // 使用你自己的 SearXNG settings.yml

import { createClient } from "@searxng-js/searxng";
const client = createClient({ baseUrl: "https://searx.example.org" });   // 该实例需开启 JSON 格式
```

## API

**`startServer(options?)`**：在 `/healthz` 响应后返回 `{ url, port, pid, executable, client, exited, stop() }`。配合 `await using` 可自动停止。

| 选项 | 默认值 | 说明 |
|---|---|---|
| `binaryPath` | `$SEARXNG_BINARY`，否则用平台包 | SearXNG 可执行文件路径 |
| `port` / `host` | 空闲端口 / `127.0.0.1` | |
| `settingsPath` | 临时目录中的最小配置 | 开启 JSON API，关闭 limiter |
| `secretKey` | 每次启动随机生成 | |
| `env`、`args` | | 传给服务进程的额外环境变量和参数 |
| `timeoutMs` | 60 秒 | 等待服务就绪的时间 |
| `reuseExtraction` | `true` | 首次启动后直接运行已解压的服务，跳过二进制的启动器 |
| `signal` | | 用于中止启动 |
| `onOutput` | | 接收服务的 stdout 和 stderr |

如果服务提前退出、超时或 `signal` 被中止，会以 `StartServerError` 拒绝，其中附带服务输出的最后 8 KB。`stop(graceMs = 10_000)` 先发 SIGTERM，宽限期过后发 SIGKILL；Windows 上直接结束整个进程树。

**`createClient({ baseUrl, fetch?, headers?, timeoutMs? })`**：返回可用于任意 SearXNG 实例的客户端：

- `search({ q, categories?, engines?, language?, page?, timeRange?, safeSearch? })` 返回 `{ results, answers, infoboxes, suggestions, corrections, unresponsive_engines }`。参数用 camelCase，列表会自动用逗号拼接；响应保留 SearXNG 原有字段名。
- `config()` 返回实例的引擎、分类、插件和语言列表。
- `health()` 服务正常时返回 `true`，从不抛异常。

非 2xx 响应会抛出 `SearxngError`，带 `status` 和 SearXNG 的错误信息。每个请求默认 30 秒超时，同时也响应你传入的 `signal`。

## 工作原理

1. `nuitka/build.py` 拉取固定 commit 的 SearXNG，连同依赖和 Python 运行时一起编译成 Nuitka onefile 二进制。HTML 界面的静态资源、用不到的依赖和调试符号都被去掉。SearXNG 源码不做任何修改。
2. CI 在 Linux、macOS、Windows 上构建并测试二进制。发布时每个平台的二进制各自作为一个 npm 包（设置了 `os`/`cpu`/`libc`），作为主包的可选依赖。
3. `startServer()` 找到二进制、写入配置，在空闲端口上用随机密钥启动它。二进制本身是个启动器，每次启动都要校验已解压的文件；首次启动之后，客户端会跳过它、直接运行已解压的服务，省下约 0.5 秒和 35 MiB 内存。它持有服务的 stdin 管道并设置 `SEARXNG_EXIT_ON_STDIN_EOF=1`，因此即使退出处理函数没来得及执行，你的进程一退出服务也会退出。

更多细节见 [docs/internals.md](docs/internals.md)（英文）：体积与启动时间的测量、两个只在编译版中出现的 bug、可移植性以及发布流程。

## 与其他方式对比

| | 本项目 | 官方 Docker 镜像 | Python venv |
|---|---|---|---|
| 体积 | 21–23 MiB，单个文件 | 约 98 MB，另需 Docker | 解压后约 150–200 MB |
| 机器上需要 | 无 | Docker | Python 3 |
| 启动 | Linux 上约 0.6 秒（首次最长约 4 秒） | 容器启动时间 | 约 0.6 秒 |
| 生命周期 | 跟随你的进程 | 需自行管理 | 需自行管理 |

## 局限

- **只提供 JSON API。** HTML 界面没有 CSS、JS 和翻译。
- **不支持 valkey/redis。** 设置 `valkey.url` 会导致服务启动失败，因此也没有基于 valkey 的 limiter。
- **搜索引擎可能封禁或限流**，这点与任何 SearXNG 实例相同。云服务器和 CI 的 IP 更容易被封，请留意 `unresponsive_engines`。
- **预编译二进制只有 linux-x64（glibc）、darwin-arm64、win32-x64。** macOS 二进制未签名、未公证。
- **内存：** Linux 上空闲时 RSS 约 95 MiB，搜索几次后约 120 MiB，和从源码运行 SearXNG（约 80 和 115 MiB）接近。少启用一些引擎（配置里的 `use_default_settings.engines.keep_only`）还能更省。

## 从源码构建

```sh
cd nuitka
python build.py fetch
python -m pip install -r searxng/requirements.txt -r requirements-build.txt
python build.py build      # -> build/searxng[.exe]
python smoke.py            # 启动二进制并跑几个真实查询
```

需要 Python 3.13 和 C 编译器。用自己构建的二进制跑客户端测试：在 `packages/client` 下执行 `SEARXNG_BINARY=../../nuitka/build/searxng bun test`。发布流程见 [docs/internals.md](docs/internals.md#releasing)。

## 许可证

- `@searxng-js/searxng`（`packages/client` 中的客户端）采用 **MIT**：它只负责启动二进制并通过 HTTP 通信。
- 二进制包及本仓库其余部分与 SearXNG 一样采用 **AGPL-3.0-or-later**。每个二进制包都附带所有打包内容的许可证全文，并注明对应源码的位置。

基于 [SearXNG](https://github.com/searxng/searxng) 和 [Nuitka](https://nuitka.net) 构建。本项目与 SearXNG 官方无关。
