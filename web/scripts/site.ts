import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSW, type GenerateSWOptions } from "workbox-build";
import { z } from "zod";

const Runtime = globalThis as typeof globalThis & {
  Bun: {
    build(options: {
      entrypoints: Array<string>;
      target: "browser";
      format: "esm";
      minify: boolean;
      splitting: boolean;
      sourcemap: "none";
      write: false;
    }): Promise<{
      success: boolean;
      logs: Array<unknown>;
      outputs: Array<{
        path: string;
        kind: string;
        type: string;
        text(): Promise<string>;
      }>;
    }>;
    file(path: string): Blob;
    serve(options: {
      hostname: string;
      port: number;
      fetch(request: Request): Response | Promise<Response>;
    }): {
      url: URL;
      stop(force?: boolean): void;
    };
  };
};

const CliOptionsSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("build") }).strict(),
  z
    .object({
      command: z.literal("dev"),
      host: z.string().min(1),
      port: z.number().int().min(1).max(65_535),
    })
    .strict(),
]);

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(webRoot, "..");
const distDir = resolve(webRoot, "dist");
const distAssetsDir = resolve(distDir, "assets");
const publicDir = resolve(webRoot, "public");
const generatedCssPath = resolve(publicDir, "assets/app.css");
const preparedChapterRoutesDir = resolve(webRoot, ".tmp", "prepared-routes-v1");
const sourceChaptersDir = resolve(workspaceRoot, "tts/out/chapters");
const browserEntry = resolve(webRoot, "src/main.ts");
const sourceScriptTag = '<script type="module" src="/src/main.ts"></script>';
const sourceStylesheetTag = '<link rel="stylesheet" href="/assets/app.css" />';
const downloadCacheName = "ri-reader-offline-v12";
const downloadCachePrefix = "ri-reader-offline-";

const chapterRoutePattern = /^\/([1-9]\d*)\/?$/;
const generatedRouteNamePattern = /^[1-9]\d*$/;
const audioAssetRoutePattern = /^\/([1-9]\d*)-[a-f0-9]{16}\.(webm|m4a)$/;
const sourceMapExtension = ".map";
const skippedPublicFiles = new Set(["sw.js", "assets/app.css"]);
const skippedPublicExtensions = new Set([sourceMapExtension, ".webm", ".m4a"]);
const contentTypesByExtension = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".m4a", "audio/mp4"],
  [".txt", "text/plain; charset=utf-8"],
  [".webm", "audio/webm"],
]);

function parseCli(argv: Array<string>) {
  const command = z.enum(["build", "dev"]).parse(argv[2]);
  if (command === "build") {
    if (argv.length > 3) {
      throw new Error(`Unexpected build arguments: ${argv.slice(3).join(" ")}`);
    }
    return CliOptionsSchema.parse({ command });
  }

  const options = {
    command,
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? "5173"),
  };

  for (let index = 3; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--host") {
      index += 1;
      options.host = argv[index] ?? "";
    } else if (argument.startsWith("--host=")) {
      options.host = argument.slice("--host=".length);
    } else if (argument === "--port") {
      index += 1;
      options.port = Number(argv[index]);
    } else if (argument.startsWith("--port=")) {
      options.port = Number(argument.slice("--port=".length));
    } else if (argument === "--strictPort") {
      continue;
    } else {
      throw new Error(`Unexpected dev argument: ${argument}`);
    }
  }

  return CliOptionsSchema.parse(options);
}

function isMissingFileError(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function pathExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

async function generatedChapterIds() {
  if (!(await pathExists(preparedChapterRoutesDir))) {
    throw new Error(`No prepared chapter routes found in ${preparedChapterRoutesDir}. Run bun run prepare first.`);
  }

  const entries = await readdir(preparedChapterRoutesDir, { withFileTypes: true });
  const chapterIds: Array<string> = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !generatedRouteNamePattern.test(entry.name)) {
      continue;
    }
    if (await pathExists(chapterRouteIndexPath(entry.name))) {
      chapterIds.push(entry.name);
    }
  }

  return chapterIds.sort((first, second) => Number(first) - Number(second));
}

function chapterRouteIndexPath(chapterId: string) {
  return resolve(preparedChapterRoutesDir, chapterId, "index.html");
}

function rewriteHtmlAssets(html: string, browserAssetPath: string, stylesheetAssetPath: string) {
  if (!html.includes(sourceScriptTag)) {
    throw new Error("Generated HTML is missing the browser entry script tag.");
  }

  return html
    .replaceAll(sourceScriptTag, `<script type="module" src="${browserAssetPath}"></script>`)
    .replaceAll(sourceStylesheetTag, `<link rel="stylesheet" href="${stylesheetAssetPath}" />`);
}

async function browserBundle(minify: boolean) {
  const result = await Runtime.Bun.build({
    entrypoints: [browserEntry],
    target: "browser",
    format: "esm",
    minify,
    splitting: false,
    sourcemap: "none",
    write: false,
  });

  if (!result.success) {
    throw new Error(`Browser bundle failed:\n${result.logs.map((log) => String(log)).join("\n")}`);
  }

  const scripts = result.outputs.filter((output) => output.kind === "entry-point" && output.path.endsWith(".js"));
  if (scripts.length !== 1) {
    throw new Error(`Expected one browser script output, received ${scripts.length}.`);
  }

  return scripts[0].text();
}

function assetHash(contents: string) {
  return createHash("sha256").update(contents).digest("hex").slice(0, 16);
}

function shouldCopyPublicFile(relativePath: string) {
  return !skippedPublicFiles.has(relativePath) && !skippedPublicExtensions.has(extname(relativePath));
}

async function copyPublicAssets(sourceDir: string, destinationDir: string, sourceRoot = sourceDir) {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  await mkdir(destinationDir, { recursive: true });

  for (const entry of entries) {
    const sourcePath = resolve(sourceDir, entry.name);
    const destinationPath = resolve(destinationDir, entry.name);
    const sourceRelativePath = relative(sourceRoot, sourcePath);

    if (entry.isDirectory()) {
      await copyPublicAssets(sourcePath, destinationPath, sourceRoot);
    } else if (entry.isFile() && shouldCopyPublicFile(sourceRelativePath)) {
      await copyFile(sourcePath, destinationPath);
    }
  }
}

function serviceWorkerConfig(globDirectory: string, swDest: string, globPatterns: Array<string>): GenerateSWOptions {
  return {
    swDest,
    globDirectory,
    globPatterns,
    globIgnores: ["**/*.map", "**/*.webm", "**/*.m4a"],
    maximumFileSizeToCacheInBytes: 2 * 1024 * 1024,
    dontCacheBustURLsMatching: /^assets\/app-[a-f0-9]{16}\.(?:js|css)$/,
    cleanupOutdatedCaches: true,
    clientsClaim: true,
    skipWaiting: false,
    navigationPreload: true,
    inlineWorkboxRuntime: true,
    sourcemap: false,
    disableDevLogs: true,
    runtimeCaching: [
      {
        urlPattern: ({ url }) =>
          url.origin === location.origin && /^\/[1-9]\d*-[a-f0-9]{16}\.(?:webm|m4a)$/.test(url.pathname),
        handler: "CacheFirst",
        options: {
          cacheName: downloadCacheName,
          cacheableResponse: { statuses: [200] },
          rangeRequests: true,
        },
      },
      {
        urlPattern: ({ request, url }) =>
          request.mode === "navigate" && url.origin === location.origin && /^\/[1-9]\d*\/?$/.test(url.pathname),
        handler: "NetworkFirst",
        options: {
          cacheName: downloadCacheName,
          networkTimeoutSeconds: 3,
          cacheableResponse: { statuses: [200] },
        },
      },
      {
        urlPattern: ({ url }) =>
          url.origin === location.origin &&
          (url.pathname === "/chapters/index.json" || /^\/assets\/app(?:-[a-f0-9]{16})?\.(?:js|css)$/.test(url.pathname)),
        handler: "NetworkFirst",
        options: {
          cacheName: downloadCacheName,
          networkTimeoutSeconds: 3,
          cacheableResponse: { statuses: [200] },
        },
      },
    ],
  };
}

function runtimeCacheCleanupCode() {
  return `
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames
          .filter(
            (cacheName) =>
              cacheName.startsWith(${JSON.stringify(downloadCachePrefix)}) &&
              cacheName !== ${JSON.stringify(downloadCacheName)},
          )
          .map((cacheName) => caches.delete(cacheName)),
      ),
    ),
  );
});
`.trim();
}

async function writeServiceWorker(globDirectory: string, swDest: string, globPatterns: Array<string>) {
  const result = await generateSW(serviceWorkerConfig(globDirectory, swDest, globPatterns));
  if (result.warnings.length > 0) {
    throw new Error(`Workbox service worker generation warnings:\n${result.warnings.join("\n")}`);
  }

  const generatedServiceWorker = await readFile(swDest, "utf8");
  await writeFile(swDest, `${generatedServiceWorker}\n${runtimeCacheCleanupCode()}\n`, "utf8");
  console.log(`Generated ${relative(webRoot, swDest)} with ${result.count} precached asset${result.count === 1 ? "" : "s"}.`);
}

function renderHeadersFile() {
  return `
/assets/*
  Cache-Control: public, max-age=31536000, immutable

/chapters/index.json
  Cache-Control: no-cache, must-revalidate

/sw.js
  Cache-Control: no-cache, must-revalidate
`.trimStart();
}

async function writeBundledAssets() {
  const [browserCode, stylesheetCode] = await Promise.all([
    browserBundle(true),
    readFile(generatedCssPath, "utf8"),
  ]);
  const browserHash = assetHash(browserCode);
  const stylesheetHash = assetHash(stylesheetCode);
  const browserAssetPath = `/assets/app-${browserHash}.js`;
  const stylesheetAssetPath = `/assets/app-${stylesheetHash}.css`;

  await Promise.all([
    writeFile(resolve(distAssetsDir, `app-${browserHash}.js`), browserCode, "utf8"),
    writeFile(resolve(distAssetsDir, `app-${stylesheetHash}.css`), stylesheetCode, "utf8"),
  ]);

  return { browserAssetPath, stylesheetAssetPath };
}

async function writeHtmlRoutes(
  chapterIds: Array<string>,
  browserAssetPath: string,
  stylesheetAssetPath: string,
) {
  const rootHtml = rewriteHtmlAssets(
    await readFile(resolve(webRoot, "index.html"), "utf8"),
    browserAssetPath,
    stylesheetAssetPath,
  );
  await writeFile(resolve(distDir, "index.html"), rootHtml, "utf8");

  for (const chapterId of chapterIds) {
    const routeDir = resolve(distDir, chapterId);
    const chapterHtml = rewriteHtmlAssets(
      await readFile(chapterRouteIndexPath(chapterId), "utf8"),
      browserAssetPath,
      stylesheetAssetPath,
    );
    await mkdir(routeDir, { recursive: true });
    await writeFile(resolve(routeDir, "index.html"), chapterHtml, "utf8");
  }
}

async function buildSite() {
  const chapterIds = await generatedChapterIds();

  await rm(distDir, { recursive: true, force: true });
  await mkdir(distAssetsDir, { recursive: true });
  await copyPublicAssets(publicDir, distDir);
  await writeFile(resolve(distDir, "_headers"), renderHeadersFile(), "utf8");

  const { browserAssetPath, stylesheetAssetPath } = await writeBundledAssets();
  await writeHtmlRoutes(chapterIds, browserAssetPath, stylesheetAssetPath);
  await writeServiceWorker(distDir, resolve(distDir, "sw.js"), ["assets/app-*.js", "assets/app-*.css", "robots.txt"]);

  console.log(
    `Built ${chapterIds.length} chapter route${chapterIds.length === 1 ? "" : "s"} with ${browserAssetPath} and ${stylesheetAssetPath}.`,
  );
}

function contentTypeFor(path: string) {
  return contentTypesByExtension.get(extname(path)) ?? "application/octet-stream";
}

function textResponse(message: string, status: number, headers: HeadersInit = {}) {
  const responseHeaders = new Headers(headers);
  if (!responseHeaders.has("Content-Type")) {
    responseHeaders.set("Content-Type", "text/plain; charset=utf-8");
  }
  return new Response(message, {
    status,
    headers: responseHeaders,
  });
}

function notFound(message: string) {
  return textResponse(message, 404);
}

function rangeNotSatisfiable(size: number) {
  return textResponse("Requested range is not satisfiable.", 416, {
    "Content-Range": `bytes */${size}`,
  });
}

function parseByteRange(rangeHeader: string, size: number) {
  if (!Number.isSafeInteger(size) || size <= 0) {
    return null;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match) {
    return null;
  }

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") {
    return null;
  }

  if (rawStart === "") {
    const suffixLength = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return null;
    }
    const start = Math.max(size - suffixLength, 0);
    return { start, end: size - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd === "" ? size - 1 : Number(rawEnd);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}

async function fileResponse(request: Request, path: string, headers: HeadersInit = {}) {
  let fileSize = 0;
  try {
    const fileStat = await stat(path);
    if (!fileStat.isFile()) {
      return null;
    }
    fileSize = fileStat.size;
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }

  const responseHeaders = new Headers(headers);
  responseHeaders.set("Accept-Ranges", "bytes");
  responseHeaders.set("Cache-Control", "no-store");
  if (!responseHeaders.has("Content-Type")) {
    responseHeaders.set("Content-Type", contentTypeFor(path));
  }
  const rangeHeader = request.headers.get("range");

  if (rangeHeader) {
    const range = parseByteRange(rangeHeader, fileSize);
    if (!range) {
      return rangeNotSatisfiable(fileSize);
    }
    const partialHeaders = new Headers(responseHeaders);
    partialHeaders.set("Content-Length", String(range.end - range.start + 1));
    partialHeaders.set("Content-Range", `bytes ${range.start}-${range.end}/${fileSize}`);
    return new Response(Runtime.Bun.file(path).slice(range.start, range.end + 1), {
      status: 206,
      headers: partialHeaders,
    });
  }

  if (fileSize === 0) {
    return null;
  }

  responseHeaders.set("Content-Length", String(fileSize));
  return new Response(Runtime.Bun.file(path), {
    headers: responseHeaders,
  });
}

function publicAssetPath(pathname: string) {
  const decodedPath = decodeURIComponent(pathname);
  const candidate = resolve(publicDir, decodedPath.slice(1));
  const relativePath = relative(publicDir, candidate);
  if (relativePath.startsWith("..") || relativePath === "" || relativePath.startsWith("/")) {
    return null;
  }
  return candidate;
}

async function htmlResponse(path: string) {
  const html = await readFile(path, "utf8");
  return new Response(rewriteHtmlAssets(html, "/assets/app.js", "/assets/app.css"), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

async function devResponse(request: Request) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (pathname.endsWith(sourceMapExtension)) {
    return notFound("Source maps are not available.");
  }

  if (pathname === "/assets/app.js") {
    return new Response(await browserBundle(false), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/javascript; charset=utf-8",
      },
    });
  }

  if (pathname === "/") {
    return htmlResponse(resolve(webRoot, "index.html"));
  }

  const chapterRoute = chapterRoutePattern.exec(pathname);
  if (chapterRoute) {
    const htmlPath = chapterRouteIndexPath(chapterRoute[1]);
    if (!(await pathExists(htmlPath))) {
      return notFound(`Chapter ${chapterRoute[1]} has not been generated.`);
    }
    return htmlResponse(htmlPath);
  }

  const audioAssetRoute = audioAssetRoutePattern.exec(pathname);
  if (audioAssetRoute) {
    const [, chapterId, extension] = audioAssetRoute;
    const sourcePath = resolve(sourceChaptersDir, chapterId, `chapter-${chapterId}.${extension}`);
    const response = await fileResponse(request, sourcePath);
    if (response) {
      return response;
    }
  }

  const assetPath = publicAssetPath(pathname);
  if (assetPath && extname(assetPath) !== sourceMapExtension) {
    const response = await fileResponse(request, assetPath);
    if (response) {
      return response;
    }
  }

  return notFound("Not found.");
}

async function startDevServer(host: string, port: number) {
  await writeServiceWorker(publicDir, resolve(publicDir, "sw.js"), ["assets/app.css", "robots.txt"]);
  const server = Runtime.Bun.serve({
    hostname: host,
    port,
    fetch: devResponse,
  });

  console.log(`Bun dev server listening at ${server.url.href}`);
}

const options = parseCli(process.argv);
if (options.command === "build") {
  await buildSite();
} else {
  await startDevServer(options.host, options.port);
}
