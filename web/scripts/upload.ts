import { createHash, createHmac } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const audioUrlPattern = /^\/([1-9]\d*)-([a-f0-9]{16})\.(webm|m4a)$/;
const emptyPayloadHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const immutableCacheControl = "public, max-age=31536000, immutable";

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
            audio: z
              .object({
                sources: z.array(AudioAssetSchema).min(1),
              })
              .passthrough(),
          })
          .passthrough(),
      )
      .nonempty(),
  })
  .strict();

const EnvSchema = z
  .object({
    CLOUDFLARE_ACCOUNT_ID: z.string().min(1),
    R2_ACCESS_KEY_ID: z.string().min(1),
    R2_SECRET_ACCESS_KEY: z.string().min(1),
    R2_BUCKET: z.string().min(3).default("ri-pub-audio"),
    R2_UPLOAD_CONCURRENCY: z.coerce.number().int().min(1).max(12).default(4),
  })
  .passthrough();

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(webRoot, "..");
const catalogPath = resolve(webRoot, "dist/chapters/index.json");
const sourceChaptersDir = resolve(workspaceRoot, "tts/out/chapters");

function hmac(key: string | Buffer, value: string) {
  return createHmac("sha256", key).update(value).digest();
}

function hmacHex(key: string | Buffer, value: string) {
  return createHmac("sha256", key).update(value).digest("hex");
}

function encodePathSegment(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalUri(bucket: string, key: string) {
  const encodedKey = key.split("/").map(encodePathSegment).join("/");
  return `/${encodePathSegment(bucket)}/${encodedKey}`;
}

function signingKey(secretAccessKey: string, date: string) {
  const dateKey = hmac(`AWS4${secretAccessKey}`, date);
  const regionKey = hmac(dateKey, "auto");
  const serviceKey = hmac(regionKey, "s3");
  return hmac(serviceKey, "aws4_request");
}

function amzTimestamp(date = new Date()) {
  const timestamp = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return {
    date: timestamp.slice(0, 8),
    timestamp,
  };
}

function normalizedHeaders(headers: Record<string, string>) {
  const normalized = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    normalized.set(name.toLowerCase(), value.trim().replace(/\s+/g, " "));
  }
  return normalized;
}

function signedRequest(
  method: "HEAD" | "PUT",
  key: string,
  payloadHash: string,
  headers: Record<string, string>,
  env: z.infer<typeof EnvSchema>,
) {
  const host = `${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const { date, timestamp } = amzTimestamp();
  const requestHeaders = normalizedHeaders(headers);
  requestHeaders.set("host", host);
  requestHeaders.set("x-amz-content-sha256", payloadHash);
  requestHeaders.set("x-amz-date", timestamp);

  const signedHeaderNames = Array.from(requestHeaders.keys()).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${requestHeaders.get(name)}`).join("\n");
  const credentialScope = `${date}/auto/s3/aws4_request`;
  const canonicalRequest = [
    method,
    canonicalUri(env.R2_BUCKET, key),
    "",
    `${canonicalHeaders}\n`,
    signedHeaderNames.join(";"),
    payloadHash,
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    timestamp,
    credentialScope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");
  const signature = hmacHex(signingKey(env.R2_SECRET_ACCESS_KEY, date), stringToSign);
  requestHeaders.set(
    "authorization",
    `AWS4-HMAC-SHA256 Credential=${env.R2_ACCESS_KEY_ID}/${credentialScope}, SignedHeaders=${signedHeaderNames.join(
      ";",
    )}, Signature=${signature}`,
  );

  return {
    headers: Object.fromEntries(requestHeaders),
    url: `https://${host}${canonicalUri(env.R2_BUCKET, key)}`,
  };
}

async function r2Request(
  method: "HEAD" | "PUT",
  key: string,
  payloadHash: string,
  headers: Record<string, string>,
  env: z.infer<typeof EnvSchema>,
  body?: BodyInit,
) {
  const request = signedRequest(method, key, payloadHash, headers, env);
  return fetch(request.url, {
    method,
    headers: request.headers,
    body,
  });
}

function localAudioPath(url: string) {
  const match = audioUrlPattern.exec(url);
  if (!match) {
    throw new Error(`Invalid audio URL: ${url}`);
  }

  const [, chapterId, , extension] = match;
  return resolve(sourceChaptersDir, chapterId, `chapter-${chapterId}.${extension}`);
}

async function validateSourceFile(asset: z.infer<typeof AudioAssetSchema>) {
  const path = localAudioPath(asset.url);
  const fileStats = await stat(path);
  if (!fileStats.isFile() || fileStats.size !== asset.bytes) {
    throw new Error(`Local audio metadata mismatch for ${asset.url}`);
  }
  return path;
}

function assertExistingObject(asset: z.infer<typeof AudioAssetSchema>, response: Response) {
  const contentLength = Number(response.headers.get("content-length"));
  const contentType = response.headers.get("content-type");
  const cacheControl = response.headers.get("cache-control");
  const storedHash = response.headers.get("x-amz-meta-sha256");

  if (
    contentLength !== asset.bytes ||
    contentType !== asset.mimeType ||
    cacheControl !== immutableCacheControl ||
    storedHash !== asset.hash
  ) {
    throw new Error(
      `Existing R2 object ${asset.url.slice(1)} does not match generated metadata. Delete it before redeploying.`,
    );
  }
}

function bufferBody(body: Buffer) {
  return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
}

async function assertUploadedObject(key: string, asset: z.infer<typeof AudioAssetSchema>, env: z.infer<typeof EnvSchema>) {
  const response = await r2Request("HEAD", key, emptyPayloadHash, {}, env);
  if (response.status !== 200) {
    throw new Error(`R2 HEAD ${key} after upload failed with ${response.status}: ${await response.text()}`);
  }
  assertExistingObject(asset, response);
}

async function uploadAsset(asset: z.infer<typeof AudioAssetSchema>, env: z.infer<typeof EnvSchema>) {
  const key = asset.url.slice(1);
  const sourcePath = await validateSourceFile(asset);
  const headResponse = await r2Request("HEAD", key, emptyPayloadHash, {}, env);

  if (headResponse.status === 200) {
    assertExistingObject(asset, headResponse);
    console.log(`Exists ${key}`);
    return;
  }
  if (headResponse.status !== 404) {
    throw new Error(`R2 HEAD ${key} failed with ${headResponse.status}: ${await headResponse.text()}`);
  }

  const putResponse = await r2Request(
    "PUT",
    key,
    asset.hash.slice("sha256-".length),
    {
      "cache-control": immutableCacheControl,
      "content-length": String(asset.bytes),
      "content-type": asset.mimeType,
      "x-amz-meta-sha256": asset.hash,
    },
    env,
    bufferBody(await readFile(sourcePath)),
  );
  if (!putResponse.ok) {
    throw new Error(`R2 PUT ${key} failed with ${putResponse.status}: ${await putResponse.text()}`);
  }

  await assertUploadedObject(key, asset, env);
  console.log(`Uploaded ${key}`);
}

function assertCatalogAudioUrl(asset: z.infer<typeof AudioAssetSchema>, chapterId: string) {
  const hashPrefix = asset.hash.slice("sha256-".length, "sha256-".length + 16);
  if (!asset.url.startsWith(`/${chapterId}-${hashPrefix}.`)) {
    throw new Error(`Audio URL ${asset.url} does not match its catalog hash`);
  }
}

function catalogAudioAssets(catalog: z.infer<typeof CatalogSchema>) {
  const audioByUrl = new Map<string, z.infer<typeof AudioAssetSchema>>();
  for (const chapter of catalog.chapters) {
    for (const source of chapter.audio.sources) {
      assertCatalogAudioUrl(source, chapter.id);
      audioByUrl.set(source.url, source);
    }
  }
  return Array.from(audioByUrl.values()).sort((first, second) => first.url.localeCompare(second.url));
}

async function uploadAllAssets(audioAssets: Array<z.infer<typeof AudioAssetSchema>>, env: z.infer<typeof EnvSchema>) {
  let nextIndex = 0;
  const workerCount = Math.min(env.R2_UPLOAD_CONCURRENCY, audioAssets.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < audioAssets.length) {
        const asset = audioAssets[nextIndex];
        nextIndex += 1;
        await uploadAsset(asset, env);
      }
    }),
  );
}

const env = EnvSchema.parse(process.env);
const catalog = CatalogSchema.parse(JSON.parse(await readFile(catalogPath, "utf8")));
const audioAssets = catalogAudioAssets(catalog);

await uploadAllAssets(audioAssets, env);

console.log(`R2 audio upload complete: ${audioAssets.length} object${audioAssets.length === 1 ? "" : "s"} checked.`);
