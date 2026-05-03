import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const audioUrlPattern = /^\/([1-9]\d*)-([a-f0-9]{16})\.(webm|m4a)$/;
const hashedAppScriptPattern = /^app-[a-f0-9]{16}\.js$/;
const hashedAppStylesheetPattern = /^app-[a-f0-9]{16}\.css$/;
const immutableCacheControl = "Cache-Control: public, max-age=31536000, immutable";
const maxStaticAssetBytes = 25 * 1024 * 1024;
const maxStaticAssetFiles = 20_000;

const AudioAssetSchema = z
  .object({
    url: z.string().regex(audioUrlPattern),
    mimeType: z.string().min(1),
    bytes: z.number().int().positive(),
    hash: z.string().regex(/^sha256-[a-f0-9]{64}$/),
  })
  .strict();

const CatalogSchema = z
  .object({
    schema: z.literal("ri.chapter-catalog.v2"),
    chapters: z
      .array(
        z
          .object({
            id: z.string().regex(/^[1-9]\d*$/),
            href: z.string().min(1),
            audio: z
              .object({
                version: z.string().regex(/^sha256-[a-f0-9]+$/),
                sources: z.array(AudioAssetSchema).min(1),
              })
              .passthrough(),
          })
          .passthrough(),
      )
      .nonempty(),
  })
  .strict();

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(webRoot, "..");
const distDir = resolve(webRoot, "dist");
const distAssetsDir = resolve(distDir, "assets");
const sourceChaptersDir = resolve(workspaceRoot, "tts/out/chapters");

function isMissingFileError(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function relativeDistPath(path: string) {
  return relative(distDir, path);
}

function commaList(values: Array<string>) {
  return values.join(", ");
}

function isWithinDirectory(root: string, path: string) {
  const relativePath = relative(root, path);
  return relativePath !== "" && !relativePath.startsWith("..") && !relativePath.startsWith("/");
}

async function readJsonFile(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function listFiles(root: string) {
  const files: Array<string> = [];

  async function visit(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  }

  await visit(root);
  return files;
}

async function hashFile(path: string) {
  return new Promise<string>((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => {
      hash.update(chunk);
    });
    stream.on("error", rejectHash);
    stream.on("end", () => {
      resolveHash(`sha256-${hash.digest("hex")}`);
    });
  });
}

function sourcePathFor(url: string) {
  const match = audioUrlPattern.exec(url);
  if (!match) {
    throw new Error(`Invalid audio URL: ${url}`);
  }

  const [, chapterId, , extension] = match;
  return resolve(sourceChaptersDir, chapterId, `chapter-${chapterId}.${extension}`);
}

async function assertAudioMetadata(asset: z.infer<typeof AudioAssetSchema>, chapterId: string) {
  const hashPrefix = asset.hash.slice("sha256-".length, "sha256-".length + 16);
  if (!new RegExp(`^/${chapterId}-${hashPrefix}\\.(webm|m4a)$`).test(asset.url)) {
    throw new Error(`Audio URL ${asset.url} does not match its SHA-256 hash`);
  }

  const sourcePath = sourcePathFor(asset.url);
  const sourceStats = await stat(sourcePath);
  if (!sourceStats.isFile() || sourceStats.size !== asset.bytes) {
    throw new Error(`Audio bytes mismatch for ${asset.url}`);
  }

  const actualHash = await hashFile(sourcePath);
  if (actualHash !== asset.hash) {
    throw new Error(`Audio hash mismatch for ${asset.url}`);
  }
}

async function assertStaticAssetLimits(files: Array<string>) {
  if (files.length > maxStaticAssetFiles) {
    throw new Error(`Static asset file count ${files.length} exceeds ${maxStaticAssetFiles}`);
  }

  for (const file of files) {
    const fileStats = await stat(file);
    if (fileStats.size > maxStaticAssetBytes) {
      throw new Error(`${relativeDistPath(file)} exceeds the 25 MiB Cloudflare static asset limit`);
    }
  }
}

function assertNoFiles(files: Array<string>, message: string) {
  if (files.length > 0) {
    throw new Error(`${message}: ${commaList(files.map(relativeDistPath))}`);
  }
}

function assertSingleHashedAppAsset(files: Array<string>) {
  const assetNames = files
    .filter((file) => isWithinDirectory(distAssetsDir, file))
    .map((file) => relative(distAssetsDir, file));
  const scripts = assetNames.filter((file) => hashedAppScriptPattern.test(file));
  const stylesheets = assetNames.filter((file) => hashedAppStylesheetPattern.test(file));

  if (scripts.length !== 1 || stylesheets.length !== 1) {
    throw new Error(
      `Expected one hashed app script and stylesheet, found ${scripts.length} scripts and ${stylesheets.length} stylesheets`,
    );
  }
}

async function assertGeneratedReferences(files: Array<string>) {
  const oldReferences = ["/chapters/app.css", "/assets/main"];
  const generatedDataFiles = files.filter((path) => extname(path) === ".html" || extname(path) === ".json");

  for (const file of generatedDataFiles) {
    const contents = await readFile(file, "utf8");
    for (const reference of oldReferences) {
      if (contents.includes(reference)) {
        throw new Error(`${relativeDistPath(file)} contains stale reference ${reference}`);
      }
    }
    if (/src="\/[1-9]\d*\.(webm|m4a)"/.test(contents)) {
      throw new Error(`${relativeDistPath(file)} contains unhashed audio source URLs`);
    }
  }
}

async function assertHeadersFile() {
  const headers = await readFile(resolve(distDir, "_headers"), "utf8");
  if (!headers.includes("/assets/*") || !headers.includes(immutableCacheControl)) {
    throw new Error("Missing immutable asset cache headers");
  }
}

async function assertCatalog() {
  const catalog = CatalogSchema.parse(await readJsonFile(resolve(distDir, "chapters/index.json")));
  for (const chapter of catalog.chapters) {
    if (chapter.href !== `/${chapter.id}`) {
      throw new Error(`Invalid chapter href for ${chapter.id}`);
    }
    for (const source of chapter.audio.sources) {
      await assertAudioMetadata(source, chapter.id);
    }
  }
  return catalog;
}

async function assertRequiredDeploymentFiles() {
  for (const path of [resolve(webRoot, "wrangler.jsonc"), resolve(webRoot, "src/worker.ts")]) {
    try {
      await stat(path);
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new Error(`Missing required deployment file: ${path}`);
      }
      throw error;
    }
  }
}

async function main() {
  const files = await listFiles(distDir);
  await assertStaticAssetLimits(files);

  assertNoFiles(
    files.filter((file) => extname(file) === ".webm" || extname(file) === ".m4a"),
    "Deploy output must not contain audio files",
  );
  assertNoFiles(
    files.filter((file) => extname(file) === ".map"),
    "Deploy output must not contain source maps",
  );
  assertSingleHashedAppAsset(files);

  await assertHeadersFile();
  const catalog = await assertCatalog();
  await assertGeneratedReferences(files);
  await assertRequiredDeploymentFiles();

  console.log(
    `Deploy check passed: ${files.length} static files, ${catalog.chapters.length} chapters, ${catalog.chapters.length * 2} catalog audio sources verified.`,
  );
}

await main();
