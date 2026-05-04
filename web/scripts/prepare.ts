import { createHash } from "node:crypto";
import { createReadStream, type BigIntStats } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ListMusic,
  Pause,
  Play,
  RefreshCcw,
  RotateCcw,
  RotateCw,
  Trash2,
  X,
} from "lucide";
import { z } from "zod";

const ChapterIdSchema = z.string().regex(/^[1-9]\d*$/);
const audioUrlPattern = /^\/([1-9]\d*)-([a-f0-9]{16})\.(webm|m4a)$/;
const hexHashPattern = /^[a-f0-9]{64}$/;
const sha256HashPattern = /^sha256-([a-f0-9]{64})$/;
const integerStringPattern = /^(0|[1-9]\d*)$/;
const preparedChapterCacheSchema = "ri.prepared-chapter-cache.v2";
const sourceManifestSchema = "ri.reader-audio-manifest.v1";
const staticChapterSchema = "ri.static-chapter.v1";
const catalogSchema = "ri.chapter-catalog.v2";
const chapterHtmlGeneratorVersion = "ri.chapter-html-generator.v1";
const chapterCssGeneratorVersion = "ri.chapter-css-generator.v1";
const chapterCatalogGeneratorVersion = "ri.chapter-catalog-generator.v1";
const browserChromeColor = "#111111";

const SourceAudioSchema = z
  .object({
    src: z.string().min(1),
    type: z.string().min(1),
    codec: z.string().min(1),
    bitrate: z.string().min(1).optional(),
  })
  .strict();

const SourceBlockSchema = z
  .object({
    id: z.string().min(1),
    kind: z.string().min(1),
    text: z.string(),
    start: z.number().nonnegative(),
    end: z.number().nonnegative(),
    tokenStart: z.number().int().nonnegative(),
    tokenEnd: z.number().int().nonnegative(),
    chunks: z.array(z.string().min(1)),
    sourceStart: z.number().int().nonnegative().optional(),
    sourceEnd: z.number().int().nonnegative().optional(),
  })
  .strict();

const SourceChunkSchema = z
  .object({
    id: z.string().min(1),
    blockId: z.string().min(1),
    blockIndex: z.number().int().nonnegative(),
    text: z.string(),
    start: z.number().nonnegative(),
    end: z.number().nonnegative(),
    charStart: z.number().int().nonnegative(),
    charEnd: z.number().int().nonnegative(),
  })
  .strict();

const SourceCueSchema = z
  .object({
    id: z.string().min(1),
    blockId: z.string().min(1),
    blockIndex: z.number().int().nonnegative(),
    chunkId: z.string().min(1),
    text: z.string(),
    start: z.number().nonnegative(),
    end: z.number().nonnegative(),
    charStart: z.number().int().nonnegative(),
    charEnd: z.number().int().nonnegative(),
    isWord: z.boolean(),
  })
  .strict();

const SourceSeekSchema = z
  .object({
    time: z.number().nonnegative(),
    cueIndex: z.number().int().nonnegative(),
    blockId: z.string().min(1),
    blockIndex: z.number().int().nonnegative(),
    charStart: z.number().int().nonnegative(),
  })
  .strict();

const SourceManifestSchema = z
  .object({
    schema: z.literal(sourceManifestSchema),
    chapter: ChapterIdSchema,
    title: z.string().min(1),
    source: z.unknown().optional(),
    tts: z.unknown().optional(),
    audio: z
      .object({
        duration: z.number().positive(),
        primary: SourceAudioSchema,
        fallback: SourceAudioSchema,
      })
      .strict(),
    playback: z.unknown().optional(),
    blocks: z.array(SourceBlockSchema).nonempty(),
    chunks: z.array(SourceChunkSchema).nonempty(),
    cues: z.array(SourceCueSchema).nonempty(),
    seekIndex: z.array(SourceSeekSchema).nonempty(),
  })
  .strict();

const StaticChapterDataSchema = z
  .object({
    schema: z.literal(staticChapterSchema),
    chapter: ChapterIdSchema,
    title: z.string().min(1),
    orderIndex: z.number().int().nonnegative(),
    totalChapters: z.number().int().positive(),
    previousChapter: ChapterIdSchema.optional(),
    nextChapter: ChapterIdSchema.optional(),
    duration: z.number().positive(),
    blocks: z.array(z.tuple([z.number().nonnegative(), z.number().nonnegative()])).nonempty(),
    cues: z
      .array(
        z.tuple([
          z.number().int().nonnegative(),
          z.number().nonnegative(),
          z.number().nonnegative(),
        ]),
      )
      .nonempty(),
  })
  .strict();

const FileSignatureSchema = z
  .object({
    bytes: z.number().int().positive(),
    mtimeNs: z.string().regex(integerStringPattern),
  })
  .strict();

const CatalogAudioAssetSchema = z
  .object({
    url: z.string().regex(audioUrlPattern),
    mimeType: z.string().min(1),
    bytes: z.number().int().positive(),
    hash: z.string().regex(sha256HashPattern),
  })
  .strict();

const CatalogChapterSchema = z
  .object({
    id: ChapterIdSchema,
    title: z.string().min(1),
    href: z.string().min(1),
    duration: z.number().positive(),
    audio: z
      .object({
        version: z.string().regex(sha256HashPattern),
        sources: z.array(CatalogAudioAssetSchema).min(1),
      })
      .strict(),
  })
  .strict();

const CatalogSchema = z
  .object({
    schema: z.literal(catalogSchema),
    chapters: z.array(CatalogChapterSchema).nonempty(),
  })
  .strict();

const PreparedChapterCacheSchema = z
  .object({
    schema: z.literal(preparedChapterCacheSchema),
    cacheKey: z.string().regex(hexHashPattern),
    chapter: ChapterIdSchema,
    summary: z
      .object({
        blocks: z.number().int().positive(),
        cues: z.number().int().positive(),
        duration: z.number().positive(),
      })
      .strict(),
    catalogChapter: CatalogChapterSchema,
  })
  .strict();

const PrepareChapterWorkerDataSchema = z
  .object({
    role: z.literal("prepare-chapter-worker"),
    chapterIds: z.array(ChapterIdSchema).nonempty(),
  })
  .strict();

const PrepareChapterWorkerInitSchema = z
  .object({
    type: z.literal("init"),
    data: PrepareChapterWorkerDataSchema,
  })
  .strict();

const PrepareChapterWorkerTaskSchema = z
  .object({
    type: z.literal("prepare-chapter"),
    taskId: z.number().int().nonnegative(),
    orderIndex: z.number().int().nonnegative(),
    chapterId: ChapterIdSchema,
  })
  .strict();

const PrepareChapterWorkerMessageSchema = z.discriminatedUnion("type", [
  PrepareChapterWorkerInitSchema,
  PrepareChapterWorkerTaskSchema,
]);

const PrepareChapterWorkerResultSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("prepared-chapter"),
      taskId: z.number().int().nonnegative(),
      orderIndex: z.number().int().nonnegative(),
      chapterId: ChapterIdSchema,
      catalogChapter: CatalogChapterSchema,
      statusLine: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("prepare-chapter-error"),
      taskId: z.number().int().nonnegative(),
      orderIndex: z.number().int().nonnegative(),
      chapterId: ChapterIdSchema,
      message: z.string().min(1),
      stack: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("prepare-chapter-bootstrap-error"),
      message: z.string().min(1),
      stack: z.string().min(1).optional(),
    })
    .strict(),
]);

const prepareScriptFileUrl = new URL(import.meta.url);
prepareScriptFileUrl.search = "";
prepareScriptFileUrl.hash = "";
const prepareScriptPath = fileURLToPath(prepareScriptFileUrl);
const webRoot = resolve(dirname(prepareScriptPath), "..");
const workspaceRoot = resolve(webRoot, "..");
const publicDir = resolve(webRoot, "public");
const generatedPublicDir = resolve(publicDir, "chapters");
const generatedAssetsDir = resolve(publicDir, "assets");
const preparedChapterRoutesDir = resolve(webRoot, ".tmp", "prepared-routes-v1");
const preparedChapterCacheDir = resolve(webRoot, ".tmp", "prepared-chapters-v1");
const sourceChaptersDir = resolve(workspaceRoot, "tts/out/chapters");

const css = `
:root {
  color-scheme: dark;
  --bg: ${browserChromeColor};
  --surface: rgba(28, 28, 30, 0.72);
  --surface-strong: rgba(44, 44, 46, 0.92);
  --text: #f5f5f7;
  --muted: #a1a1a6;
  --hairline: rgba(255, 255, 255, 0.14);
  --accent: #0a84ff;
  --accent-soft: rgba(10, 132, 255, 0.19);
  --complete: #30d158;
  --danger: #ff453a;
  --warning: #ffd60a;
  --radius: 8px;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --dock-reserve: 258px;
  --reader-max-width: 820px;
  --reader-inline-padding: 20px;
  --article-max-width: calc(var(--reader-max-width) - var(--reader-inline-padding) - var(--reader-inline-padding));
  --article-viewport-width: calc(100% - var(--reader-inline-padding) - var(--reader-inline-padding));
  --transport-width-extra: 15px;
  --transport-max-width: calc(var(--article-max-width) + var(--transport-width-extra));
  --transport-viewport-width: calc(var(--article-viewport-width) + var(--transport-width-extra));
  --transport-gutter: 10px;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Helvetica Neue", Arial, sans-serif;
}

* {
  box-sizing: border-box;
}

html {
  min-height: 100%;
  background: var(--bg);
  color: var(--text);
  -webkit-text-size-adjust: 100%;
}

body {
  min-width: 320px;
  min-height: 100vh;
  min-height: 100dvh;
  margin: 0;
  background: var(--bg);
}

button,
input {
  font: inherit;
}

button {
  min-height: 44px;
  border: 1px solid var(--hairline);
  border-radius: 999px;
  background: var(--surface-strong);
  color: var(--text);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

@media (hover: hover) {
  button:hover {
    background: rgba(72, 72, 74, 0.96);
  }
}

button:active {
  transform: scale(0.97);
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.52;
}

button:focus-visible,
input:focus-visible {
  outline: 3px solid rgba(10, 132, 255, 0.42);
  outline-offset: 3px;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}

.app {
  width: min(100%, var(--reader-max-width));
  min-height: 100vh;
  min-height: 100dvh;
  margin: 0 auto;
  padding:
    max(22px, env(safe-area-inset-top))
    var(--reader-inline-padding)
    calc(var(--dock-reserve) + max(var(--transport-gutter), env(safe-area-inset-bottom)));
}

.chapter-header {
  display: grid;
  gap: var(--space-3);
  padding: 22px 0 var(--space-6);
  scroll-margin-top: 0;
}

.chapter-kicker {
  display: block;
  min-width: 0;
  color: var(--muted);
  font-size: 0.8rem;
  font-weight: 640;
  letter-spacing: 0;
  text-transform: uppercase;
}

.chapter-title {
  margin: 0;
  overflow-wrap: anywhere;
  max-width: 12ch;
  font-size: clamp(2.35rem, 13vw, 5.15rem);
  font-weight: 760;
  letter-spacing: 0;
  line-height: 0.94;
}

.transcript {
  display: grid;
  gap: 0;
}

.transcript-block {
  border-radius: var(--radius);
  margin: 0 -12px;
  padding: 6px 12px;
  color: rgba(245, 245, 247, 0.52);
  font-size: clamp(1.02rem, 4vw, 1.22rem);
  letter-spacing: 0;
  line-height: 1.72;
  overflow-wrap: anywhere;
  scroll-margin-top: 18px;
  transition:
    background-color 180ms ease,
    color 180ms ease;
}

.transcript-block[data-kind="heading"] {
  color: rgba(245, 245, 247, 0.82);
  font-size: clamp(1.08rem, 4.4vw, 1.34rem);
  font-weight: 730;
  line-height: 1.42;
}

.transcript-block.is-active {
  background: rgba(255, 255, 255, 0.075);
  color: var(--text);
}

.cue {
  border-radius: 6px;
  padding: 1px 1px;
}

.cue.is-active {
  background: rgba(10, 132, 255, 0.36);
  color: #fff;
  box-shadow: 0 0 0 2px rgba(10, 132, 255, 0.16);
}

.transport {
  position: fixed;
  width: min(var(--transport-viewport-width), var(--transport-max-width));
  bottom: max(var(--transport-gutter), env(safe-area-inset-bottom));
  left: 50%;
  transform: translateX(-50%);
  z-index: 5;
  overflow: hidden;
  border: 1px solid var(--hairline);
  border-radius: 20px;
  padding:
    var(--space-3)
    var(--space-4)
    var(--space-3);
  background: rgba(18, 18, 19, 0.94);
  backdrop-filter: blur(34px) saturate(1.35);
  box-shadow: 0 -28px 74px rgba(0, 0, 0, 0.72);
}

.transport-inner {
  display: grid;
  width: min(100%, 740px);
  margin: 0 auto;
  gap: var(--space-2);
}

.chapter-nav {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr) 48px 48px;
  align-items: center;
  gap: var(--space-2);
}

.chapter-nav-button,
.chapter-current-button,
.chapter-option,
.chapter-picker-close,
.download-settings-button,
.download-sheet-close {
  display: grid;
  min-height: 44px;
  border-color: rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.08);
}

.chapter-nav-button,
.download-settings-button {
  width: 48px;
  height: 48px;
  place-items: center;
  padding: 0;
}

.chapter-current-button {
  grid-template-columns: minmax(0, 1fr) 24px;
  align-items: center;
  gap: var(--space-2);
  height: 48px;
  min-width: 0;
  padding: 0 var(--space-3);
  text-align: left;
}

.chapter-current-copy {
  display: grid;
  gap: 1px;
  min-width: 0;
}

.chapter-current-kicker {
  overflow: hidden;
  color: rgba(245, 245, 247, 0.62);
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0;
  line-height: 1.1;
  text-overflow: clip;
  text-transform: uppercase;
  white-space: nowrap;
}

.chapter-current-title {
  overflow: hidden;
  color: var(--text);
  font-size: 0.88rem;
  font-weight: 670;
  letter-spacing: 0;
  line-height: 1.18;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chapter-current-icon {
  color: rgba(245, 245, 247, 0.72);
}

.time-row {
  display: grid;
  grid-template-columns: 52px minmax(0, 1fr) 58px;
  align-items: center;
  gap: var(--space-3);
  min-height: 44px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  font-size: 0.78rem;
  font-weight: 600;
}

.time-row span:last-child {
  text-align: right;
}

.seek {
  appearance: none;
  width: 100%;
  min-width: 0;
  height: 44px;
  accent-color: var(--accent);
  background: transparent;
  cursor: pointer;
  -webkit-appearance: none;
  --seek-progress: 0%;
}

.seek::-webkit-slider-runnable-track {
  height: 5px;
  border-radius: 999px;
  background:
    linear-gradient(
      90deg,
      #f5f5f7 0 var(--seek-progress),
      rgba(255, 255, 255, 0.2) var(--seek-progress) 100%
    );
}

.seek::-webkit-slider-thumb {
  width: 20px;
  height: 20px;
  margin-top: -7.5px;
  border: 0;
  border-radius: 50%;
  background: #f5f5f7;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
  appearance: none;
}

.seek::-moz-range-track {
  height: 5px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.2);
}

.seek::-moz-range-progress {
  height: 5px;
  border-radius: 999px;
  background: #f5f5f7;
}

.seek::-moz-range-thumb {
  width: 20px;
  height: 20px;
  border: 0;
  border-radius: 50%;
  background: #f5f5f7;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
}

.button-row {
  display: grid;
  grid-template-columns: 56px 74px 56px;
  justify-content: center;
  align-items: center;
  gap: clamp(var(--space-5), 8vw, 42px);
}

.skip-button {
  display: grid;
  place-items: center;
  width: 56px;
  height: 56px;
  min-height: 56px;
  padding: 0;
  color: rgba(245, 245, 247, 0.92);
  background: rgba(255, 255, 255, 0.09);
}

.play-button {
  display: grid;
  place-items: center;
  width: 74px;
  height: 74px;
  min-height: 74px;
  padding: 0;
  border-color: rgba(255, 255, 255, 0.22);
  background: #f5f5f7;
  color: #000;
  box-shadow:
    0 18px 48px rgba(0, 0, 0, 0.52),
    inset 0 1px 0 rgba(255, 255, 255, 0.7);
}

.button-icon {
  display: block;
  width: 23px;
  height: 23px;
  pointer-events: none;
  stroke-width: 2.25;
}

.play-button .button-icon {
  width: 30px;
  height: 30px;
  stroke-width: 2.4;
}

.play-button:hover {
  background: #fff;
}

.state-icon {
  display: none;
}

.play-button[data-play-state="play"] [data-state-icon="play"],
.play-button[data-play-state="pause"] [data-state-icon="pause"],
.play-button[data-play-state="replay"] [data-state-icon="replay"] {
  display: block;
}

.play-button[data-play-state="replay"] {
  background: var(--complete);
  border-color: rgba(48, 209, 88, 0.35);
  color: #001407;
}

.chapter-picker {
  position: fixed;
  inset: 0;
  z-index: 8;
  display: grid;
  align-items: end;
  padding:
    0
    max(var(--space-4), env(safe-area-inset-right))
    max(var(--space-4), env(safe-area-inset-bottom))
    max(var(--space-4), env(safe-area-inset-left));
  background: rgba(0, 0, 0, 0.48);
}

.chapter-picker[hidden] {
  display: none;
}

.chapter-picker-panel {
  display: grid;
  grid-template-rows: auto auto auto minmax(0, 1fr);
  gap: var(--space-3);
  width: min(100%, 460px);
  height: min(74vh, 680px);
  height: min(74dvh, 680px);
  max-height: min(74vh, 680px);
  max-height: min(74dvh, 680px);
  margin: 0 auto;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: var(--radius);
  padding: var(--space-4);
  background: #1b1b1d;
  box-shadow: 0 28px 80px rgba(0, 0, 0, 0.74);
}

.chapter-picker-heading {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 44px;
  align-items: center;
  gap: var(--space-3);
}

.chapter-picker-title {
  margin: 0;
  color: var(--text);
  font-size: 1rem;
  font-weight: 720;
  letter-spacing: 0;
}

.chapter-picker-close {
  width: 44px;
  height: 44px;
  place-items: center;
  padding: 0;
}

.chapter-search {
  width: 100%;
  min-height: 46px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: var(--radius);
  padding: 0 var(--space-4);
  background: rgba(255, 255, 255, 0.08);
  color: var(--text);
}

.chapter-search::placeholder {
  color: rgba(245, 245, 247, 0.45);
}

.chapter-search:focus-visible {
  outline: none;
  border-color: rgba(245, 245, 247, 0.38);
  background: rgba(255, 255, 255, 0.11);
  box-shadow: 0 0 0 3px rgba(245, 245, 247, 0.08);
}

.chapter-results-count {
  color: rgba(245, 245, 247, 0.58);
  font-size: 0.78rem;
  font-weight: 680;
  letter-spacing: 0;
  line-height: 1.1;
}

.chapter-switcher {
  position: relative;
  display: block;
  grid-row: 4;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  padding-right: 2px;
  scrollbar-gutter: stable;
}

.chapter-results-spacer {
  position: relative;
  width: 100%;
  min-height: 100%;
}

.chapter-option {
  position: absolute;
  top: 0;
  right: 2px;
  left: 0;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-3);
  width: auto;
  height: 60px;
  min-height: 60px;
  padding: var(--space-2) var(--space-4);
  color: rgba(245, 245, 247, 0.86);
  letter-spacing: 0;
  text-align: left;
}

.chapter-option-copy {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.chapter-option-kicker {
  color: currentColor;
  font-size: 0.72rem;
  font-weight: 740;
  letter-spacing: 0;
  line-height: 1.1;
  opacity: 0.68;
  text-transform: uppercase;
}

.chapter-option-title {
  overflow: hidden;
  color: currentColor;
  font-size: 0.94rem;
  font-weight: 680;
  letter-spacing: 0;
  line-height: 1.22;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chapter-option[aria-current="page"] {
  border-color: rgba(255, 255, 255, 0.36);
  background: #f5f5f7;
  color: #000;
}

.chapter-option-status {
  display: inline-grid;
  place-items: center;
  color: currentColor;
  font-size: 0.72rem;
  font-weight: 720;
  letter-spacing: 0;
  opacity: 0.62;
  text-transform: uppercase;
}

.chapter-picker-empty {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: grid;
  place-items: center;
  color: var(--muted);
  font-size: 0.9rem;
}

.chapter-picker-empty[hidden] {
  display: none;
}

.download-sheet {
  position: fixed;
  inset: 0;
  z-index: 9;
  display: grid;
  align-items: end;
  padding:
    0
    max(var(--space-4), env(safe-area-inset-right))
    max(var(--space-4), env(safe-area-inset-bottom))
    max(var(--space-4), env(safe-area-inset-left));
  background: rgba(0, 0, 0, 0.5);
}

.download-sheet[hidden] {
  display: none;
}

.download-sheet-panel {
  display: grid;
  gap: var(--space-5);
  width: min(100%, 460px);
  max-height: min(78vh, 680px);
  max-height: min(78dvh, 680px);
  overflow: auto;
  margin: 0 auto;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: var(--radius);
  padding: var(--space-5);
  background: #1a1a1c;
  box-shadow: 0 28px 80px rgba(0, 0, 0, 0.74);
}

.download-sheet-heading {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 44px;
  align-items: center;
  gap: var(--space-3);
}

.download-sheet-titleblock {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.download-sheet-title {
  margin: 0;
  color: var(--text);
  font-size: 1rem;
  font-weight: 580;
  letter-spacing: 0;
  line-height: 1.2;
}

.download-sheet-close {
  width: 44px;
  height: 44px;
  place-items: center;
  padding: 0;
}

.download-state-chip {
  display: inline-grid;
  grid-template-columns: 7px minmax(0, auto);
  align-items: center;
  gap: 7px;
  flex: none;
  max-width: 100%;
  overflow-wrap: anywhere;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 999px;
  padding: 4px 9px;
  background: rgba(255, 255, 255, 0.055);
  color: rgba(245, 245, 247, 0.7);
  font-size: 0.74rem;
  font-weight: 450;
  letter-spacing: 0;
  line-height: 1.15;
}

.download-state-chip::before {
  content: "";
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: currentColor;
  opacity: 0.58;
}

[data-download-state="downloading"] .download-state-chip {
  border-color: rgba(10, 132, 255, 0.28);
  background: rgba(10, 132, 255, 0.12);
  color: #cfe8ff;
}

[data-download-state="downloading"] .download-state-chip::before {
  opacity: 1;
  animation: downloadPulse 1.4s ease-in-out infinite;
  box-shadow: 0 0 0 5px rgba(10, 132, 255, 0.1);
}

[data-download-state="complete"] .download-state-chip {
  border-color: rgba(48, 209, 88, 0.26);
  background: rgba(48, 209, 88, 0.1);
  color: #d9ffe3;
}

[data-download-state="error"] .download-state-chip {
  border-color: rgba(255, 69, 58, 0.34);
  background: rgba(255, 69, 58, 0.12);
  color: #ffd7d4;
}

.download-settings-list {
  display: grid;
  gap: var(--space-3);
}

.download-control-label {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.download-label-main {
  color: var(--text);
  font-size: 0.91rem;
  font-weight: 400;
  letter-spacing: 0;
  line-height: 1.22;
}

.download-label-sub {
  color: rgba(245, 245, 247, 0.58);
  font-size: 0.76rem;
  font-weight: 400;
  letter-spacing: 0;
  line-height: 1.25;
}

.download-slider-row {
  display: grid;
  gap: var(--space-3);
  padding-top: 2px;
}

.download-slider-heading {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: var(--space-3);
}

.download-slider-value {
  min-width: 46px;
  color: var(--text);
  font-size: 0.95rem;
  font-weight: 500;
  line-height: 1.18;
  text-align: right;
}

.chapters-ahead {
  appearance: none;
  width: 100%;
  min-height: 44px;
  margin: 0;
  background: transparent;
  color: var(--accent);
  cursor: pointer;
}

.chapters-ahead::-webkit-slider-runnable-track {
  height: 6px;
  border-radius: 999px;
  background:
    linear-gradient(
      90deg,
      var(--accent) 0%,
      var(--accent) var(--chapters-ahead-progress, 0%),
      rgba(255, 255, 255, 0.16) var(--chapters-ahead-progress, 0%),
      rgba(255, 255, 255, 0.16) 100%
    );
}

.chapters-ahead::-webkit-slider-thumb {
  appearance: none;
  width: 24px;
  height: 24px;
  border: 3px solid #fff;
  border-radius: 999px;
  margin-top: -9px;
  background: var(--accent);
  box-shadow: 0 3px 12px rgba(0, 0, 0, 0.42);
}

.chapters-ahead::-moz-range-track {
  height: 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.16);
}

.chapters-ahead::-moz-range-progress {
  height: 6px;
  border-radius: 999px;
  background: var(--accent);
}

.chapters-ahead::-moz-range-thumb {
  width: 20px;
  height: 20px;
  border: 3px solid #fff;
  border-radius: 999px;
  background: var(--accent);
  box-shadow: 0 3px 12px rgba(0, 0, 0, 0.42);
}

.chapters-ahead:focus-visible {
  outline: 2px solid rgba(10, 132, 255, 0.95);
  outline-offset: 5px;
}

.download-metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-3);
}

.download-metric {
  display: grid;
  align-content: start;
  gap: 4px;
  min-width: 0;
  color: rgba(245, 245, 247, 0.56);
  font-size: 0.7rem;
  font-weight: 400;
  letter-spacing: 0;
  line-height: 1.2;
}

.download-metric span {
  min-width: 0;
}

.download-metric strong {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--text);
  font-size: 0.88rem;
  font-weight: 500;
  line-height: 1.16;
}

.download-state-line {
  display: grid;
  gap: 0;
}

.download-error {
  border: 1px solid rgba(255, 69, 58, 0.32);
  border-radius: var(--radius);
  padding: var(--space-3);
  background: rgba(255, 69, 58, 0.12);
  color: #ffd7d4;
  font-size: 0.82rem;
  font-weight: 450;
  line-height: 1.35;
}

.download-error[hidden] {
  display: none;
}

.clear-downloads-button {
  display: inline-grid;
  grid-template-columns: 20px auto;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  justify-self: stretch;
  width: 100%;
  min-height: 46px;
  border-color: rgba(255, 69, 58, 0.28);
  border-radius: var(--radius);
  background: rgba(255, 69, 58, 0.18);
  color: #ffd7d4;
  padding: 0 var(--space-3);
  font-size: 0.88rem;
  font-weight: 500;
}

.clear-downloads-button:hover {
  border-color: rgba(255, 69, 58, 0.42);
  background: rgba(255, 69, 58, 0.24);
}

@keyframes downloadPulse {
  0%,
  100% {
    transform: scale(0.72);
  }
  50% {
    transform: scale(1);
  }
}

.loading,
.error {
  display: grid;
  min-height: 100vh;
  min-height: 100dvh;
  place-items: center;
  padding: 24px;
  color: var(--muted);
  font-size: 1rem;
  text-align: center;
}

.error {
  color: #ff6961;
}

@media (max-width: 430px) {
  .transport {
    padding-right: var(--space-3);
    padding-left: var(--space-3);
  }

  .chapter-nav {
    gap: 6px;
  }

  .chapter-current-button {
    grid-template-columns: minmax(0, 1fr);
  }

  .chapter-current-icon {
    display: none;
  }
}

@media (max-width: 360px) {
  :root {
    --reader-inline-padding: 16px;
    --transport-gutter: 8px;
  }

  .chapter-title {
    font-size: clamp(2.16rem, 12vw, 2.58rem);
  }

  .transport {
    bottom: max(8px, env(safe-area-inset-bottom));
    padding-right: var(--space-1);
    padding-left: var(--space-1);
  }

  .chapter-nav {
    grid-template-columns: 44px minmax(0, 1fr) 44px 44px;
    gap: 2px;
  }

  .chapter-nav-button,
  .download-settings-button {
    width: 44px;
    height: 44px;
  }

  .chapter-current-button {
    height: 44px;
  }

  .chapter-current-kicker {
    font-size: 0.64rem;
  }

  .time-row {
    grid-template-columns: 48px minmax(0, 1fr) 56px;
    gap: var(--space-2);
  }

  .button-row {
    gap: var(--space-5);
  }
}

@media (min-width: 760px) {
  .app {
    padding-top: 54px;
    padding-bottom: calc(var(--dock-reserve) + 20px + max(var(--transport-gutter), env(safe-area-inset-bottom)));
  }

  .chapter-header {
    padding-bottom: 34px;
  }

  .transcript-block {
    margin-right: -14px;
    margin-left: -14px;
    padding: 7px 14px;
  }
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
    transition-duration: 0.001ms !important;
  }
}
`;

function asNumberId(chapterId: z.infer<typeof ChapterIdSchema>) {
  return Number(chapterId);
}

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return count === 1 ? singular : pluralForm;
}

function isMissingFileError(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function errorStack(error: unknown) {
  return error instanceof Error ? error.stack : undefined;
}

async function readJsonFile(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJsonFile(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value), "utf8");
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value: string | number | boolean) {
  return escapeHtml(String(value));
}

function jsonForHtml(value: unknown) {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("&", "\\u0026");
}

function renderIcon(
  iconNode: typeof Play,
  className = "button-icon",
  extraAttributes: Record<string, string> = {},
) {
  const attributes = {
    xmlns: "http://www.w3.org/2000/svg",
    width: "24",
    height: "24",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    class: className,
    "aria-hidden": "true",
    focusable: "false",
    ...extraAttributes,
  };
  const attributeHtml = Object.entries(attributes)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `${name}="${escapeAttribute(String(value))}"`)
    .join(" ");
  const children = iconNode
    .map(([tagName, childAttributes]) => {
      const childAttributeHtml = Object.entries(childAttributes)
        .filter(([, value]) => value !== undefined)
        .map(([name, value]) => `${name}="${escapeAttribute(String(value))}"`)
        .join(" ");
      return `<${tagName} ${childAttributeHtml}></${tagName}>`;
    })
    .join("");
  return `<svg ${attributeHtml}>${children}</svg>`;
}

function assertSortedTiming(
  items: Array<{ start: number; end: number; id?: string }>,
  name: string,
) {
  let previousStart = -1;
  for (const item of items) {
    if (item.end < item.start) {
      throw new Error(`${name} ${item.id ?? ""} ends before it starts`);
    }
    if (item.start < previousStart) {
      throw new Error(`${name} timings must be sorted by start time`);
    }
    previousStart = item.start;
  }
}

function assertStaticChapterData(data: z.infer<typeof StaticChapterDataSchema>) {
  if (data.orderIndex >= data.totalChapters) {
    throw new Error(`Chapter ${data.chapter} order index is outside the chapter count`);
  }
  data.blocks.forEach((block, index) => {
    if (block[1] < block[0]) {
      throw new Error(`Chapter ${data.chapter} block ${index} ends before it starts`);
    }
    if (index > 0 && block[0] < data.blocks[index - 1][0]) {
      throw new Error(`Chapter ${data.chapter} block timings must be sorted`);
    }
  });
  data.cues.forEach((cue, index) => {
    const blockIndex = cue[0];
    if (blockIndex >= data.blocks.length) {
      throw new Error(`Chapter ${data.chapter} cue ${index} references missing block ${blockIndex}`);
    }
    if (cue[2] < cue[1]) {
      throw new Error(`Chapter ${data.chapter} cue ${index} ends before it starts`);
    }
    if (index > 0 && cue[1] < data.cues[index - 1][1]) {
      throw new Error(`Chapter ${data.chapter} cue timings must be sorted`);
    }
  });
  return data;
}

function assertCatalogAudioAsset(asset: z.infer<typeof CatalogAudioAssetSchema>, chapterId: string) {
  const urlMatch = audioUrlPattern.exec(asset.url);
  const hashMatch = sha256HashPattern.exec(asset.hash);
  if (!urlMatch || !hashMatch || urlMatch[1] !== chapterId || urlMatch[2] !== hashMatch[1].slice(0, 16)) {
    throw new Error(`Audio URL ${asset.url} does not match chapter ${chapterId} and its SHA-256 hash`);
  }
  return asset;
}

function assertCatalog(catalog: z.infer<typeof CatalogSchema>) {
  catalog.chapters.forEach((chapter, index) => {
    if (chapter.href !== `/${chapter.id}`) {
      throw new Error(`Invalid chapter href for ${chapter.id}`);
    }
    if (index > 0 && Number(chapter.id) <= Number(catalog.chapters[index - 1].id)) {
      throw new Error(`Chapter catalog must be sorted by numeric id at chapter ${chapter.id}`);
    }
    chapter.audio.sources.forEach((source) => {
      assertCatalogAudioAsset(source, chapter.id);
    });
  });
  return catalog;
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

async function requiredFileSignature(path: string, label: string) {
  let fileStats: BigIntStats;
  try {
    fileStats = await stat(path, { bigint: true });
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new Error(`Missing ${label}: ${path}`);
    }
    throw error;
  }
  if (!fileStats.isFile() || fileStats.size <= 0n) {
    throw new Error(`${label} is empty or not a file: ${path}`);
  }
  if (fileStats.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} is too large to represent safely: ${path}`);
  }
  return FileSignatureSchema.parse({
    bytes: Number(fileStats.size),
    mtimeNs: fileStats.mtimeNs.toString(),
  });
}

function chapterAssetPaths(chapterId: z.infer<typeof ChapterIdSchema>) {
  const sourceDir = resolve(sourceChaptersDir, chapterId);
  return {
    sourceDir,
    sourceManifestPath: resolve(sourceDir, `chapter-${chapterId}.alignment.json`),
    webmPath: resolve(sourceDir, `chapter-${chapterId}.webm`),
    m4aPath: resolve(sourceDir, `chapter-${chapterId}.m4a`),
  };
}

function chapterRouteDir(chapterId: z.infer<typeof ChapterIdSchema>) {
  return resolve(preparedChapterRoutesDir, chapterId);
}

function chapterRouteIndexPath(chapterId: z.infer<typeof ChapterIdSchema>) {
  return resolve(chapterRouteDir(chapterId), "index.html");
}

function legacyRootChapterRouteDir(chapterId: z.infer<typeof ChapterIdSchema>) {
  return resolve(webRoot, chapterId);
}

function preparedChapterCachePaths(chapterId: z.infer<typeof ChapterIdSchema>) {
  return {
    metadataPath: resolve(preparedChapterCacheDir, `${chapterId}.json`),
    htmlPath: resolve(preparedChapterCacheDir, `${chapterId}.html`),
  };
}

async function fileHasContent(path: string) {
  try {
    const fileStats = await stat(path);
    return fileStats.isFile() && fileStats.size > 0;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

async function chapterAssetsAreComplete(chapterId: z.infer<typeof ChapterIdSchema>) {
  const { sourceManifestPath, webmPath, m4aPath } = chapterAssetPaths(chapterId);
  const complete = await Promise.all([sourceManifestPath, webmPath, m4aPath].map(fileHasContent));
  return complete.every(Boolean);
}

async function hashFile(path: string) {
  return new Promise<string>((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => {
      hash.update(chunk);
    });
    stream.on("error", (error) => {
      if (isMissingFileError(error)) {
        rejectHash(new Error(`Missing file to hash: ${path}`));
        return;
      }
      rejectHash(error);
    });
    stream.on("end", () => {
      resolveHash(`sha256-${hash.digest("hex")}`);
    });
  });
}

function hashPrefix(hash: string) {
  const match = sha256HashPattern.exec(hash);
  if (!match) {
    throw new Error(`Invalid SHA-256 hash: ${hash}`);
  }
  return match[1].slice(0, 16);
}

async function audioAssetFileMetadata(
  path: string,
  extension: "webm" | "m4a",
) {
  const [fileStats, hash] = await Promise.all([stat(path), hashFile(path)]);
  if (!fileStats.isFile() || fileStats.size <= 0) {
    throw new Error(`Audio asset is empty or missing: ${path}`);
  }
  return { extension, bytes: fileStats.size, hash };
}

function catalogAudioAsset(
  chapterId: z.infer<typeof ChapterIdSchema>,
  asset: Awaited<ReturnType<typeof audioAssetFileMetadata>>,
  mimeType: string,
) {
  return assertCatalogAudioAsset(
    CatalogAudioAssetSchema.parse({
      url: `/${chapterId}-${hashPrefix(asset.hash)}.${asset.extension}`,
      mimeType,
      bytes: asset.bytes,
      hash: asset.hash,
    }),
    chapterId,
  );
}

function createPreparedChapterCacheKey(input: {
  chapterId: z.infer<typeof ChapterIdSchema>;
  orderIndex: number;
  totalChapters: number;
  previousChapter: z.infer<typeof ChapterIdSchema> | null;
  nextChapter: z.infer<typeof ChapterIdSchema> | null;
  sourceManifestHash: string;
  webmSignature: z.infer<typeof FileSignatureSchema>;
  m4aSignature: z.infer<typeof FileSignatureSchema>;
}) {
  if (!sha256HashPattern.test(input.sourceManifestHash)) {
    throw new Error(`Invalid source manifest hash: ${input.sourceManifestHash}`);
  }
  return createHash("sha256")
    .update(
      JSON.stringify({
        schema: preparedChapterCacheSchema,
        htmlGenerator: chapterHtmlGeneratorVersion,
        staticChapterSchema,
        catalogGenerator: chapterCatalogGeneratorVersion,
        catalogSchema,
        chapter: input.chapterId,
        orderIndex: input.orderIndex,
        totalChapters: input.totalChapters,
        previousChapter: input.previousChapter,
        nextChapter: input.nextChapter,
        sourceManifestHash: input.sourceManifestHash,
        webmSignature: input.webmSignature,
        m4aSignature: input.m4aSignature,
      }),
    )
    .digest("hex");
}

async function readPreparedChapterCache(
  chapterId: z.infer<typeof ChapterIdSchema>,
  cacheKey: string,
) {
  const { metadataPath, htmlPath } = preparedChapterCachePaths(chapterId);
  if (!(await pathExists(metadataPath))) {
    return null;
  }
  const parsedCached = PreparedChapterCacheSchema.safeParse(await readJsonFile(metadataPath));
  if (!parsedCached.success) {
    return null;
  }
  const cached = parsedCached.data;
  if (cached.chapter !== chapterId) {
    throw new Error(`Prepared chapter cache ${metadataPath} belongs to chapter ${cached.chapter}`);
  }
  if (cached.catalogChapter.id !== chapterId || cached.catalogChapter.href !== `/${chapterId}`) {
    throw new Error(`Prepared chapter cache ${metadataPath} has invalid catalog metadata for chapter ${chapterId}`);
  }
  cached.catalogChapter.audio.sources.forEach((source) => {
    assertCatalogAudioAsset(source, chapterId);
  });
  if (cached.cacheKey !== cacheKey) {
    return null;
  }
  await requiredFileSignature(htmlPath, `prepared chapter ${chapterId} cache HTML`);
  return { metadata: cached, htmlPath };
}

async function writeChapterRoute(chapterId: z.infer<typeof ChapterIdSchema>, html: string) {
  await mkdir(chapterRouteDir(chapterId), { recursive: true });
  await writeFile(chapterRouteIndexPath(chapterId), html, "utf8");
}

async function copyCachedChapterRoute(chapterId: z.infer<typeof ChapterIdSchema>, htmlPath: string) {
  await mkdir(chapterRouteDir(chapterId), { recursive: true });
  await copyFile(htmlPath, chapterRouteIndexPath(chapterId));
}

async function writePreparedChapterCache(
  chapterId: z.infer<typeof ChapterIdSchema>,
  cacheKey: string,
  html: string,
  catalogChapter: z.infer<typeof CatalogChapterSchema>,
  summary: z.infer<typeof PreparedChapterCacheSchema>["summary"],
) {
  const { metadataPath, htmlPath } = preparedChapterCachePaths(chapterId);
  await mkdir(preparedChapterCacheDir, { recursive: true });
  await writeFile(htmlPath, html, "utf8");
  await writeJsonFile(
    metadataPath,
    PreparedChapterCacheSchema.parse({
      schema: preparedChapterCacheSchema,
      cacheKey,
      chapter: chapterId,
      summary,
      catalogChapter,
    }),
  );
}

async function discoverChapterIds(options: { logSkipped: boolean } = { logSkipped: true }) {
  const entries = await readdir(sourceChaptersDir, { withFileTypes: true });
  const candidateChapterIds = entries
    .filter((entry) => entry.isDirectory() && ChapterIdSchema.safeParse(entry.name).success)
    .map((entry) => ChapterIdSchema.parse(entry.name))
    .sort((first, second) => asNumberId(first) - asNumberId(second));
  const chapterIds: Array<z.infer<typeof ChapterIdSchema>> = [];
  const skippedChapterIds: Array<z.infer<typeof ChapterIdSchema>> = [];

  const chapterStates = await Promise.all(
    candidateChapterIds.map(async (chapterId) => ({
      chapterId,
      complete: await chapterAssetsAreComplete(chapterId),
    })),
  );

  for (const { chapterId, complete } of chapterStates) {
    if (complete) {
      chapterIds.push(chapterId);
      continue;
    }
    skippedChapterIds.push(chapterId);
  }

  if (options.logSkipped && skippedChapterIds.length > 0) {
    const previewIds = skippedChapterIds.slice(0, 12).join(", ");
    const suffix = skippedChapterIds.length > 12 ? ", ..." : "";
    console.log(`Skipped incomplete chapter ${plural(skippedChapterIds.length, "directory", "directories")}: ${previewIds}${suffix}.`);
  }

  if (chapterIds.length === 0) {
    throw new Error(`No complete generated audio chapters found in ${sourceChaptersDir}`);
  }

  return chapterIds;
}

async function removeGeneratedRoutes(chapterIds: Array<z.infer<typeof ChapterIdSchema>>) {
  const entries = await readdir(webRoot, { withFileTypes: true });
  await Promise.all([
    rm(preparedChapterRoutesDir, { recursive: true, force: true }).then(() =>
      mkdir(preparedChapterRoutesDir, { recursive: true }),
    ),
    ...entries
      .filter((entry) => entry.isDirectory() && ChapterIdSchema.safeParse(entry.name).success)
      .map((entry) => rm(legacyRootChapterRouteDir(ChapterIdSchema.parse(entry.name)), { recursive: true, force: true })),
    ...chapterIds.map((chapterId) => rm(resolve(publicDir, `${chapterId}.json`), { force: true })),
    ...chapterIds.flatMap((chapterId) => [
      rm(resolve(publicDir, `${chapterId}.webm`), { force: true }),
      rm(resolve(publicDir, `${chapterId}.m4a`), { force: true }),
    ]),
    rm(resolve(generatedPublicDir, "app.css"), { force: true }),
  ]);
}

function renderTranscript(
  chapter: z.infer<typeof SourceManifestSchema>,
  cues: Array<z.infer<typeof SourceCueSchema> & { blockCharStart: number; blockCharEnd: number; cueIndex: number }>,
) {
  const cuesByBlock = new Map<string, Array<(typeof cues)[number]>>();
  for (const cue of cues) {
    const blockCues = cuesByBlock.get(cue.blockId) ?? [];
    blockCues.push(cue);
    cuesByBlock.set(cue.blockId, blockCues);
  }

  return chapter.blocks
    .map((block, blockIndex) => {
      if (block.kind === "heading" && block.text === `Chapter ${chapter.chapter}: ${chapter.title}`) {
        return "";
      }

      const blockCues = (cuesByBlock.get(block.id) ?? []).sort(
        (first, second) => first.blockCharStart - second.blockCharStart,
      );
      let cursor = 0;
      let blockHtml = "";
      for (const cue of blockCues) {
        if (cue.blockCharStart > cursor) {
          blockHtml += escapeHtml(block.text.slice(cursor, cue.blockCharStart));
        }
        blockHtml += `<span class="cue" data-cue-index="${cue.cueIndex}" data-cue-id="${escapeAttribute(
          cue.id,
        )}">${escapeHtml(block.text.slice(cue.blockCharStart, cue.blockCharEnd))}</span>`;
        cursor = cue.blockCharEnd;
      }
      if (cursor < block.text.length) {
        blockHtml += escapeHtml(block.text.slice(cursor));
      }

      const tagName = block.kind === "heading" ? "h2" : "p";
      return `<${tagName} class="transcript-block" data-testid="transcript-block" data-block-index="${blockIndex}" data-block-id="${escapeAttribute(
        block.id,
      )}" data-kind="${escapeAttribute(block.kind)}" tabindex="-1">${blockHtml}</${tagName}>`;
    })
    .join("");
}

function renderChapterPage(
  chapter: z.infer<typeof SourceManifestSchema>,
  chapterData: z.infer<typeof StaticChapterDataSchema>,
  transcriptHtml: string,
  audioSources: Array<z.infer<typeof CatalogAudioAssetSchema>>,
) {
  const previousDisabled = chapterData.previousChapter ? "" : " disabled";
  const nextDisabled = chapterData.nextChapter ? "" : " disabled";
  const previousTarget = chapterData.previousChapter
    ? ` data-target-chapter="${chapterData.previousChapter}"`
    : "";
  const nextTarget = chapterData.nextChapter ? ` data-target-chapter="${chapterData.nextChapter}"` : "";
  const sourceElements = audioSources
    .map(
      (source) =>
        `<source src="${escapeAttribute(source.url)}" type="${escapeAttribute(source.mimeType)}" />`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="robots" content="noindex, nofollow" />
    <meta name="color-scheme" content="dark" />
    <meta name="theme-color" content="${browserChromeColor}" />
    <title>Chapter ${escapeHtml(chapter.chapter)}: ${escapeHtml(chapter.title)}</title>
    <link rel="stylesheet" href="/assets/app.css" />
  </head>
  <body>
    <main id="app" class="app" data-testid="chapter-app" data-ready="false" data-audio-state="loading">
      <header class="chapter-header" data-testid="chapter-header">
        <div class="chapter-kicker"><span data-testid="chapter-label">Chapter ${escapeHtml(
          chapter.chapter,
        )}</span></div>
        <h1 class="chapter-title" data-testid="chapter-title">${escapeHtml(chapter.title)}</h1>
      </header>

      <article class="transcript" data-testid="transcript" aria-label="Chapter transcript">${transcriptHtml}</article>

      <audio data-testid="chapter-audio" preload="metadata" crossorigin="anonymous">${sourceElements}</audio>

      <footer class="transport" data-testid="transport">
        <div class="transport-inner">
          <nav class="chapter-nav" data-testid="chapter-navigation" aria-label="Chapter navigation">
            <button class="chapter-nav-button" data-testid="previous-chapter" type="button" aria-label="Previous chapter"${previousTarget}${previousDisabled}>${renderIcon(
              ChevronLeft,
            )}</button>
            <button class="chapter-current-button" data-testid="chapter-picker-toggle" type="button" aria-label="Choose chapter" aria-haspopup="dialog" aria-expanded="false" disabled>
              <span class="chapter-current-copy">
                <span class="chapter-current-kicker">Chapter ${escapeHtml(chapter.chapter)} of ${chapterData.totalChapters}</span>
                <span class="chapter-current-title">${escapeHtml(chapter.title)}</span>
              </span>
              ${renderIcon(ListMusic, "button-icon chapter-current-icon")}
            </button>
            <button class="chapter-nav-button" data-testid="next-chapter" type="button" aria-label="Next chapter"${nextTarget}${nextDisabled}>${renderIcon(
              ChevronRight,
            )}</button>
            <button class="download-settings-button" data-testid="download-settings-toggle" data-download-state="downloading" type="button" aria-label="Download settings" aria-haspopup="dialog" aria-expanded="false">${renderIcon(
              Download,
            )}</button>
          </nav>

          <div class="time-row">
            <span data-testid="elapsed-time">0:00</span>
            <input class="seek" data-testid="seek" type="range" min="0" max="0" step="0.1" value="0" aria-label="Seek chapter audio" disabled />
            <span data-testid="remaining-time">-0:00</span>
          </div>

          <div class="button-row">
            <button class="skip-button" data-testid="back-15" type="button" aria-label="Skip back 15 seconds" disabled>${renderIcon(
              RotateCcw,
            )}</button>
            <button class="play-button" data-testid="play-toggle" data-play-state="play" type="button" aria-label="Play chapter" disabled>
              ${renderIcon(Play, "button-icon state-icon", { "data-state-icon": "play" })}
              ${renderIcon(Pause, "button-icon state-icon", { "data-state-icon": "pause" })}
              ${renderIcon(RefreshCcw, "button-icon state-icon", { "data-state-icon": "replay" })}
            </button>
            <button class="skip-button" data-testid="forward-30" type="button" aria-label="Skip forward 30 seconds" disabled>${renderIcon(
              RotateCw,
            )}</button>
          </div>
        </div>
      </footer>

      <div class="chapter-picker" data-testid="chapter-picker" role="dialog" aria-modal="true" aria-label="Choose chapter" hidden>
        <section class="chapter-picker-panel">
          <div class="chapter-picker-heading">
            <h2 class="chapter-picker-title">Chapters</h2>
            <button class="chapter-picker-close" data-testid="chapter-picker-close" type="button" aria-label="Close chapter picker">${renderIcon(
              X,
            )}</button>
          </div>
          <label>
            <span class="sr-only">Search chapters</span>
            <input class="chapter-search" data-testid="chapter-search" type="search" placeholder="Search chapters" autocomplete="off" />
          </label>
          <div class="chapter-results-count" data-testid="chapter-results-count" aria-live="polite">Loading chapters</div>
          <div class="chapter-switcher" data-testid="chapter-results" aria-busy="true">
            <div class="chapter-results-spacer" data-testid="chapter-results-spacer"></div>
            <div class="chapter-picker-empty" data-testid="chapter-picker-empty" hidden>No chapters found.</div>
          </div>
        </section>
      </div>

      <div class="download-sheet" data-testid="download-sheet" role="dialog" aria-modal="true" aria-label="Download settings" hidden>
        <section class="download-sheet-panel">
          <div class="download-sheet-heading">
            <div class="download-sheet-titleblock">
              <h2 class="download-sheet-title">Offline</h2>
              <span class="download-state-chip" data-testid="download-state">Downloading</span>
            </div>
            <button class="download-sheet-close" data-testid="download-sheet-close" type="button" aria-label="Close download settings">${renderIcon(
              X,
            )}</button>
          </div>

          <div class="download-settings-list">
            <label class="download-slider-row">
              <span class="download-slider-heading">
                <span class="download-control-label">
                  <span class="download-label-main">Chapters ahead</span>
                  <span class="download-label-sub" data-testid="chapters-ahead-limit">Keeps selected upcoming chapters offline</span>
                </span>
                <output class="download-slider-value" data-testid="chapters-ahead-value" for="chapters-ahead">4</output>
              </span>
              <input class="chapters-ahead" data-testid="chapters-ahead" id="chapters-ahead" type="range" min="0" max="4" step="1" value="4" aria-label="Chapters ahead" />
            </label>
          </div>

          <div class="download-metrics" aria-label="Download storage">
            <div class="download-metric"><span>Cached now</span><strong data-testid="cached-size">0 B</strong></div>
            <div class="download-metric"><span>Offline window</span><strong data-testid="selected-window-size">Not calculated</strong></div>
            <div class="download-metric"><span>Available storage</span><strong data-testid="available-storage">Not calculated</strong></div>
          </div>

          <div class="download-state-line">
            <span class="download-error" data-testid="download-error" role="alert" hidden></span>
          </div>

          <button class="clear-downloads-button" data-testid="clear-downloads" type="button">${renderIcon(
            Trash2,
          )}<span>Clear downloads</span></button>
        </section>
      </div>
    </main>
    <script id="ri-chapter-data" type="application/json">${jsonForHtml(chapterData)}</script>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`;
}

function validatedCues(sourceManifest: z.infer<typeof SourceManifestSchema>) {
  const blockById = new Map(sourceManifest.blocks.map((block) => [block.id, block]));
  const chunkById = new Map(sourceManifest.chunks.map((chunk) => [chunk.id, chunk]));

  assertSortedTiming(sourceManifest.blocks, "block");
  assertSortedTiming(sourceManifest.chunks, "chunk");
  assertSortedTiming(sourceManifest.cues, "cue");

  const cues = sourceManifest.cues.map((cue, cueIndex) => {
    const block = blockById.get(cue.blockId);
    const chunk = chunkById.get(cue.chunkId);
    if (!block) {
      throw new Error(`cue ${cue.id} references missing block ${cue.blockId}`);
    }
    if (!chunk) {
      throw new Error(`cue ${cue.id} references missing chunk ${cue.chunkId}`);
    }
    if (chunk.blockId !== block.id) {
      throw new Error(`cue ${cue.id} chunk ${chunk.id} belongs to ${chunk.blockId}`);
    }

    const blockCharStart = chunk.charStart + cue.charStart;
    const blockCharEnd = chunk.charStart + cue.charEnd;
    if (blockCharEnd > block.text.length || blockCharEnd < blockCharStart) {
      throw new Error(`cue ${cue.id} has invalid character bounds`);
    }
    return { ...cue, blockCharStart, blockCharEnd, cueIndex };
  });

  for (const seek of sourceManifest.seekIndex) {
    if (!blockById.has(seek.blockId)) {
      throw new Error(`seek index references missing block ${seek.blockId}`);
    }
    if (seek.cueIndex >= cues.length) {
      throw new Error(`seek index cue ${seek.cueIndex} is out of range`);
    }
  }

  return cues;
}

function staticChapterData(
  sourceManifest: z.infer<typeof SourceManifestSchema>,
  cues: ReturnType<typeof validatedCues>,
  orderIndex: number,
  chapterIds: Array<z.infer<typeof ChapterIdSchema>>,
) {
  return assertStaticChapterData(
    StaticChapterDataSchema.parse({
      schema: staticChapterSchema,
      chapter: sourceManifest.chapter,
      title: sourceManifest.title,
      orderIndex,
      totalChapters: chapterIds.length,
      previousChapter: chapterIds[orderIndex - 1],
      nextChapter: chapterIds[orderIndex + 1],
      duration: sourceManifest.audio.duration,
      blocks: sourceManifest.blocks.map((block) => [block.start, block.end]),
      cues: cues.map((cue) => [cue.blockIndex, cue.start, cue.end]),
    }),
  );
}

function catalogAudioSources(
  chapterId: z.infer<typeof ChapterIdSchema>,
  sourceManifest: z.infer<typeof SourceManifestSchema>,
  webmMetadata: Awaited<ReturnType<typeof audioAssetFileMetadata>>,
  m4aMetadata: Awaited<ReturnType<typeof audioAssetFileMetadata>>,
) {
  return [
    catalogAudioAsset(chapterId, webmMetadata, sourceManifest.audio.primary.type),
    catalogAudioAsset(chapterId, m4aMetadata, sourceManifest.audio.fallback.type),
  ];
}

function catalogChapter(
  chapterId: z.infer<typeof ChapterIdSchema>,
  sourceManifest: z.infer<typeof SourceManifestSchema>,
  audioSources: Array<z.infer<typeof CatalogAudioAssetSchema>>,
) {
  const audioVersion = createHash("sha256")
    .update(audioSources.map((source) => `${source.url}:${source.hash}:${source.bytes}`).join("|"))
    .digest("hex");

  return CatalogChapterSchema.parse({
    id: chapterId,
    title: sourceManifest.title,
    href: `/${chapterId}`,
    duration: sourceManifest.audio.duration,
    audio: {
      version: `sha256-${audioVersion}`,
      sources: audioSources,
    },
  });
}

async function preparedChapterCacheInput(
  chapterId: z.infer<typeof ChapterIdSchema>,
  orderIndex: number,
  chapterIds: Array<z.infer<typeof ChapterIdSchema>>,
) {
  const { sourceManifestPath, webmPath, m4aPath } = chapterAssetPaths(chapterId);

  const [, webmSignature, m4aSignature, sourceManifestHash] = await Promise.all([
    requiredFileSignature(sourceManifestPath, "generated chapter asset"),
    requiredFileSignature(webmPath, "generated chapter asset"),
    requiredFileSignature(m4aPath, "generated chapter asset"),
    hashFile(sourceManifestPath),
  ]);
  const previousChapter = chapterIds[orderIndex - 1] ?? null;
  const nextChapter = chapterIds[orderIndex + 1] ?? null;
  const cacheKey = createPreparedChapterCacheKey({
    chapterId,
    orderIndex,
    totalChapters: chapterIds.length,
    previousChapter,
    nextChapter,
    sourceManifestHash,
    webmSignature,
    m4aSignature,
  });

  return {
    sourceManifestPath,
    webmPath,
    m4aPath,
    cacheKey,
  };
}

async function readCatalogChapter(
  chapterId: z.infer<typeof ChapterIdSchema>,
  orderIndex: number,
  chapterIds: Array<z.infer<typeof ChapterIdSchema>>,
) {
  const { sourceManifestPath, webmPath, m4aPath, cacheKey } = await preparedChapterCacheInput(
    chapterId,
    orderIndex,
    chapterIds,
  );
  const cached = await readPreparedChapterCache(chapterId, cacheKey);
  if (cached) {
    return cached.metadata.catalogChapter;
  }

  const [sourceManifest, webmMetadata, m4aMetadata] = await Promise.all([
    readJsonFile(sourceManifestPath).then((value) => SourceManifestSchema.parse(value)),
    audioAssetFileMetadata(webmPath, "webm"),
    audioAssetFileMetadata(m4aPath, "m4a"),
  ]);
  if (sourceManifest.chapter !== chapterId) {
    throw new Error(`manifest chapter ${sourceManifest.chapter} does not match expected chapter ${chapterId}`);
  }

  return catalogChapter(
    chapterId,
    sourceManifest,
    catalogAudioSources(chapterId, sourceManifest, webmMetadata, m4aMetadata),
  );
}

async function prepareChapter(
  chapterId: z.infer<typeof ChapterIdSchema>,
  orderIndex: number,
  chapterIds: Array<z.infer<typeof ChapterIdSchema>>,
) {
  const { sourceManifestPath, webmPath, m4aPath, cacheKey } = await preparedChapterCacheInput(
    chapterId,
    orderIndex,
    chapterIds,
  );
  const cached = await readPreparedChapterCache(chapterId, cacheKey);
  if (cached) {
    await copyCachedChapterRoute(chapterId, cached.htmlPath);
    return {
      catalogChapter: cached.metadata.catalogChapter,
      statusLine: `Reused cached chapter ${chapterId}: ${cached.metadata.summary.blocks} blocks, ${
        cached.metadata.summary.cues
      } cues, ${cached.metadata.summary.duration.toFixed(2)} seconds.`,
    };
  }

  const [sourceManifest, webmMetadata, m4aMetadata] = await Promise.all([
    readJsonFile(sourceManifestPath).then((value) => SourceManifestSchema.parse(value)),
    audioAssetFileMetadata(webmPath, "webm"),
    audioAssetFileMetadata(m4aPath, "m4a"),
  ]);
  if (sourceManifest.chapter !== chapterId) {
    throw new Error(`manifest chapter ${sourceManifest.chapter} does not match expected chapter ${chapterId}`);
  }

  const cues = validatedCues(sourceManifest);
  const chapterData = staticChapterData(sourceManifest, cues, orderIndex, chapterIds);
  const audioSources = catalogAudioSources(chapterId, sourceManifest, webmMetadata, m4aMetadata);
  const html = renderChapterPage(sourceManifest, chapterData, renderTranscript(sourceManifest, cues), audioSources);

  const chapterCatalog = catalogChapter(chapterId, sourceManifest, audioSources);
  const summary = {
    blocks: sourceManifest.blocks.length,
    cues: sourceManifest.cues.length,
    duration: sourceManifest.audio.duration,
  };
  await Promise.all([
    writeChapterRoute(chapterId, html),
    writePreparedChapterCache(chapterId, cacheKey, html, chapterCatalog, summary),
  ]);

  return {
    catalogChapter: chapterCatalog,
    statusLine: `Prepared chapter ${chapterId}: ${sourceManifest.blocks.length} blocks, ${sourceManifest.cues.length} cues, ${sourceManifest.audio.duration.toFixed(
      2,
    )} seconds.`,
  };
}

function prepareWorkerCount(chapterCount: number) {
  return Math.max(1, Math.min(chapterCount, Math.max(1, availableParallelism() - 1)));
}

async function handlePrepareWorkerMessage(
  message: unknown,
  data: z.infer<typeof PrepareChapterWorkerDataSchema>,
) {
  const task = PrepareChapterWorkerTaskSchema.parse(message);
  try {
    const result = await prepareChapter(task.chapterId, task.orderIndex, data.chapterIds);
    postMessage(
      PrepareChapterWorkerResultSchema.parse({
        type: "prepared-chapter",
        taskId: task.taskId,
        orderIndex: task.orderIndex,
        chapterId: task.chapterId,
        catalogChapter: result.catalogChapter,
        statusLine: result.statusLine,
      }),
    );
  } catch (error) {
    postMessage(
      PrepareChapterWorkerResultSchema.parse({
        type: "prepare-chapter-error",
        taskId: task.taskId,
        orderIndex: task.orderIndex,
        chapterId: task.chapterId,
        message: errorMessage(error),
        stack: errorStack(error),
      }),
    );
  }
}

export async function runPrepareChapterWorker() {
  await new Promise<void>((_resolveWorker, rejectWorker) => {
    let data: z.infer<typeof PrepareChapterWorkerDataSchema> | null = null;

    self.onmessage = (event: MessageEvent<unknown>) => {
      let workerMessage: z.infer<typeof PrepareChapterWorkerMessageSchema>;
      try {
        workerMessage = PrepareChapterWorkerMessageSchema.parse(event.data);
      } catch (error) {
        rejectWorker(error);
        return;
      }

      if (workerMessage.type === "init") {
        data = workerMessage.data;
        return;
      }

      if (!data) {
        rejectWorker(new Error("Prepare chapter worker received a task before initialization"));
        return;
      }

      handlePrepareWorkerMessage(workerMessage, data).catch(rejectWorker);
    };
  });
}

async function prepareChapters(
  chapterIds: Array<z.infer<typeof ChapterIdSchema>>,
) {
  const workerCount = prepareWorkerCount(chapterIds.length);
  console.log(`Preparing ${chapterIds.length} chapter ${plural(chapterIds.length, "route")} with ${workerCount} ${plural(workerCount, "worker thread")}.`);

  if (workerCount === 1) {
    const chapters: Array<z.infer<typeof CatalogChapterSchema>> = [];
    for (const [orderIndex, chapterId] of chapterIds.entries()) {
      const result = await prepareChapter(chapterId, orderIndex, chapterIds);
      console.log(result.statusLine);
      chapters.push(result.catalogChapter);
    }
    return chapters;
  }

  return new Promise<Array<z.infer<typeof CatalogChapterSchema>>>((resolveChapters, rejectChapters) => {
    const chapters: Array<z.infer<typeof CatalogChapterSchema> | undefined> = new Array(chapterIds.length);
    const workers: Array<Worker> = [];
    let nextOrderIndex = 0;
    let completed = 0;
    let settled = false;

    const finishWithError = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      for (const worker of workers) {
        void worker.terminate();
      }
      rejectChapters(error);
    };

    const assignNextChapter = (worker: Worker) => {
      if (settled) {
        return;
      }
      if (nextOrderIndex >= chapterIds.length) {
        return;
      }

      const orderIndex = nextOrderIndex;
      nextOrderIndex += 1;
      worker.postMessage(
        PrepareChapterWorkerMessageSchema.parse({
          type: "prepare-chapter",
          taskId: orderIndex,
          orderIndex,
          chapterId: chapterIds[orderIndex],
        }),
      );
    };

    for (let index = 0; index < workerCount; index += 1) {
      const worker = new Worker(new URL("./prepare-worker.ts", import.meta.url), { type: "module" });
      workers.push(worker);

      worker.postMessage(
        PrepareChapterWorkerMessageSchema.parse({
          type: "init",
          data: {
            role: "prepare-chapter-worker",
            chapterIds,
          },
        }),
      );

      worker.onmessage = (event: MessageEvent<unknown>) => {
        let result: z.infer<typeof PrepareChapterWorkerResultSchema>;
        try {
          result = PrepareChapterWorkerResultSchema.parse(event.data);
        } catch (error) {
          finishWithError(error);
          return;
        }

        if (result.type !== "prepared-chapter") {
          finishWithError(
            new Error(
              `${result.type === "prepare-chapter-error" ? `Failed to prepare chapter ${result.chapterId}` : "Prepare chapter worker failed"}: ${result.message}${
                result.stack ? `\n${result.stack}` : ""
              }`,
            ),
          );
          return;
        }

        chapters[result.orderIndex] = result.catalogChapter;
        console.log(result.statusLine);
        completed += 1;

        if (completed === chapterIds.length) {
          settled = true;
          for (const activeWorker of workers) {
            activeWorker.terminate();
          }
          resolveChapters(chapters.map((chapter) => CatalogChapterSchema.parse(chapter)));
          return;
        }

        assignNextChapter(worker);
      };

      worker.onerror = (event) => {
        finishWithError(new Error(`Prepare chapter worker failed: ${event.message}`));
      };

      assignNextChapter(worker);
    }
  });
}

async function readCatalogChapters(chapterIds: Array<z.infer<typeof ChapterIdSchema>>) {
  const workerCount = prepareWorkerCount(chapterIds.length);
  const chapters: Array<z.infer<typeof CatalogChapterSchema> | undefined> = new Array(chapterIds.length);
  let nextOrderIndex = 0;

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextOrderIndex < chapterIds.length) {
        const orderIndex = nextOrderIndex;
        nextOrderIndex += 1;
        chapters[orderIndex] = await readCatalogChapter(chapterIds[orderIndex], orderIndex, chapterIds);
      }
    }),
  );

  return chapters.map((chapter) => CatalogChapterSchema.parse(chapter));
}

async function ensurePreparedDirectories() {
  await Promise.all([
    mkdir(publicDir, { recursive: true }),
    mkdir(generatedPublicDir, { recursive: true }),
    mkdir(generatedAssetsDir, { recursive: true }),
    mkdir(preparedChapterRoutesDir, { recursive: true }),
    mkdir(preparedChapterCacheDir, { recursive: true }),
  ]);
}

function stylesheetOutput() {
  return `/* ${chapterCssGeneratorVersion} */\n${css.trim()}\n`;
}

async function writeReaderStylesheet() {
  await writeFile(resolve(generatedAssetsDir, "app.css"), stylesheetOutput(), "utf8");
}

async function writeChapterCatalog(chapters: Array<z.infer<typeof CatalogChapterSchema>>) {
  await writeJsonFile(
    resolve(generatedPublicDir, "index.json"),
    assertCatalog(CatalogSchema.parse({ schema: catalogSchema, chapters })),
  );
}

function orderIndexForChapter(
  chapterId: z.infer<typeof ChapterIdSchema>,
  chapterIds: Array<z.infer<typeof ChapterIdSchema>>,
) {
  const orderIndex = chapterIds.indexOf(chapterId);
  if (orderIndex < 0) {
    throw new Error(`Chapter ${chapterId} is not a complete generated audio chapter in ${sourceChaptersDir}`);
  }
  return orderIndex;
}

export async function prepareDevStaticAssets() {
  await ensurePreparedDirectories();
  await writeReaderStylesheet();
}

export async function prepareChapterRoute(chapterId: string) {
  await ensurePreparedDirectories();
  const parsedChapterId = ChapterIdSchema.parse(chapterId);
  const chapterIds = await discoverChapterIds({ logSkipped: false });
  const orderIndex = orderIndexForChapter(parsedChapterId, chapterIds);
  const result = await prepareChapter(parsedChapterId, orderIndex, chapterIds);
  console.log(result.statusLine);
  return {
    catalogChapter: result.catalogChapter,
    htmlPath: chapterRouteIndexPath(parsedChapterId),
    statusLine: result.statusLine,
  };
}

export async function prepareChapterCatalog() {
  await ensurePreparedDirectories();
  const chapterIds = await discoverChapterIds({ logSkipped: false });
  const chapters = await readCatalogChapters(chapterIds);
  await writeChapterCatalog(chapters);
  console.log(`Prepared chapter catalog with ${chapters.length} ${plural(chapters.length, "chapter")}.`);
  return {
    catalogPath: resolve(generatedPublicDir, "index.json"),
    chapters,
  };
}

export async function prepareAllChapters() {
  await ensurePreparedDirectories();
  const chapterIds = await discoverChapterIds();

  await Promise.all([
    removeGeneratedRoutes(chapterIds),
    writeReaderStylesheet(),
  ]);

  const chapters = await prepareChapters(chapterIds);

  await writeChapterCatalog(chapters);

  console.log(`Prepared ${chapters.length} chapter ${plural(chapters.length, "route")}.`);
}

if (import.meta.main) {
  await prepareAllChapters();
}
