import { z } from "zod";

const audioPathPattern = /^\/[1-9]\d*-[a-f0-9]{16}\.(webm|m4a)$/;
const AudioPathSchema = z.string().regex(audioPathPattern);

function hasFunctionProperty(value: unknown, property: string) {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, property) === "function";
}

const EnvSchema = z.object({
  ASSETS: z.custom<{ fetch(request: Request): Promise<Response> }>(
    (value) => hasFunctionProperty(value, "fetch"),
  ),
  AUDIO: z.custom<{
    head(key: string): Promise<{
      size: number;
      httpEtag: string;
      writeHttpMetadata(headers: Headers): void;
    } | null>;
    get(
      key: string,
      options?: { range: { offset: number; length: number } },
    ): Promise<{
      size: number;
      httpEtag: string;
      body?: ReadableStream;
      writeHttpMetadata(headers: Headers): void;
    } | null>;
  }>((value) => hasFunctionProperty(value, "get") && hasFunctionProperty(value, "head")),
});

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

function methodNotAllowed() {
  return textResponse("Method not allowed.", 405, { Allow: "GET, HEAD" });
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

function headersForAudio(
  object: {
    httpEtag: string;
    writeHttpMetadata(headers: Headers): void;
  },
  contentLength: number,
) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("Content-Length", String(contentLength));
  headers.set("ETag", object.httpEtag);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/octet-stream");
  }
  return headers;
}

async function fullAudioResponse(
  bucket: z.infer<typeof EnvSchema>["AUDIO"],
  key: string,
) {
  const object = await bucket.get(key);
  if (!object?.body) {
    return textResponse("Audio asset not found.", 404);
  }

  return new Response(object.body, {
    headers: headersForAudio(object, object.size),
  });
}

async function partialAudioResponse(
  bucket: z.infer<typeof EnvSchema>["AUDIO"],
  key: string,
  rangeHeader: string,
  size: number,
) {
  const range = parseByteRange(rangeHeader, size);
  if (!range) {
    return textResponse("Requested range is not satisfiable.", 416, {
      "Content-Range": `bytes */${size}`,
    });
  }

  const contentLength = range.end - range.start + 1;
  const object = await bucket.get(key, { range: { offset: range.start, length: contentLength } });
  if (!object?.body) {
    return textResponse("Audio asset not found.", 404);
  }

  const headers = headersForAudio(object, contentLength);
  headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
  return new Response(object.body, {
    status: 206,
    statusText: "Partial Content",
    headers,
  });
}

async function serveAudio(request: Request, bucket: z.infer<typeof EnvSchema>["AUDIO"], pathname: string) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed();
  }

  const key = pathname.slice(1);
  const head = await bucket.head(key);
  if (!head) {
    return textResponse("Audio asset not found.", 404);
  }

  if (request.method === "HEAD") {
    return new Response(null, {
      headers: headersForAudio(head, head.size),
    });
  }

  const rangeHeader = request.headers.get("range");
  if (!rangeHeader) {
    return fullAudioResponse(bucket, key);
  }

  return partialAudioResponse(bucket, key, rangeHeader, head.size);
}

export default {
  async fetch(request: Request, rawEnv: unknown) {
    const env = EnvSchema.parse(rawEnv);
    const url = new URL(request.url);
    const audioPath = AudioPathSchema.safeParse(url.pathname);
    if (audioPath.success) {
      return serveAudio(request, env.AUDIO, audioPath.data);
    }
    return env.ASSETS.fetch(request);
  },
};
