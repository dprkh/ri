import scrollIntoView from "scroll-into-view-if-needed";
import { z } from "zod/v4-mini";

// Runtime contracts for embedded, fetched, and persisted reader data.
const chapterIdPattern = /^[1-9]\d*$/;
const audioUrlPattern = /^\/([1-9]\d*)-([a-f0-9]{16})\.(webm|m4a)$/;
const sha256HashPattern = /^sha256-([a-f0-9]{64})$/;

const ChapterIdSchema = z.string();
const AudioUrlSchema = z.string();
const Sha256HashSchema = z.string();

const ChapterDataSchema = z.object({
  schema: z.literal("ri.static-chapter.v1"),
  chapter: ChapterIdSchema,
  title: z.string(),
  orderIndex: z.number(),
  totalChapters: z.number(),
  previousChapter: z.optional(ChapterIdSchema),
  nextChapter: z.optional(ChapterIdSchema),
  duration: z.number(),
  blocks: z.array(z.array(z.number())),
  cues: z.array(z.array(z.number())),
});

const AudioAssetSchema = z.object({
  url: AudioUrlSchema,
  mimeType: z.string(),
  bytes: z.number(),
  hash: Sha256HashSchema,
});

const CatalogChapterSchema = z.object({
  id: ChapterIdSchema,
  title: z.string(),
  href: z.string(),
  duration: z.number(),
  audio: z.object({
    version: Sha256HashSchema,
    sources: z.array(AudioAssetSchema),
  }),
});

const CatalogSchema = z.object({
  schema: z.literal("ri.chapter-catalog.v2"),
  chapters: z.array(CatalogChapterSchema),
});

const StoredProgressSchema = z.number();
const CompletionSchema = z.string();
const DownloadSettingsSchema = z.object({
  schema: z.literal("ri.download-settings.v2"),
  chaptersAhead: z.number(),
});
const CachedAudioRecordSchema = z.object({
  schema: z.literal("ri.cached-audio.v1"),
  chapterId: ChapterIdSchema,
  url: AudioUrlSchema,
  mimeType: z.string(),
  bytes: z.number(),
  hash: Sha256HashSchema,
  status: z.union([z.literal("cached"), z.literal("downloading"), z.literal("error")]),
  cachedAt: z.optional(z.number()),
  error: z.optional(z.string()),
});

const DownloadJobSchema = z.object({
  kind: z.enum(["core", "page", "audio"]),
  chapterId: ChapterIdSchema,
  url: z.string(),
  asset: z.optional(AudioAssetSchema),
});

const pickerRowBlockSize = 68;
const pickerOverscanRows = 6;
const defaultChaptersAhead = 4;
const downloadDbName = "ri-reader-downloads-v4";
const downloadCacheName = "ri-reader-offline-v12";
const scrollNavigationKeys = new Set(["ArrowDown", "ArrowUp", "End", "Home", "PageDown", "PageUp", " "]);

// General DOM and data helpers.
function requireElement<T extends Element>(selector: string, root: ParentNode = document) {
  const element = root.querySelector(selector);
  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }
  return element as T;
}

function assertFiniteNumber(value: number, label: string) {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be finite`);
  }
  return value;
}

function assertPositiveNumber(value: number, label: string) {
  assertFiniteNumber(value, label);
  if (value <= 0) {
    throw new Error(`${label} must be positive`);
  }
  return value;
}

function assertNonnegativeInteger(value: number, label: string) {
  assertFiniteNumber(value, label);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative integer`);
  }
  return value;
}

function assertChapterId(chapterId: string, label = "Chapter id") {
  if (!chapterIdPattern.test(chapterId)) {
    throw new Error(`${label} must be a positive numeric string`);
  }
  return chapterId;
}

function assertAudioAssetForChapter(source: z.infer<typeof AudioAssetSchema>, chapterId: string) {
  assertChapterId(chapterId);
  const urlMatch = audioUrlPattern.exec(source.url);
  const hashMatch = sha256HashPattern.exec(source.hash);
  if (!urlMatch || !hashMatch || urlMatch[1] !== chapterId || urlMatch[2] !== hashMatch[1].slice(0, 16)) {
    throw new Error(`Audio URL ${source.url} does not match chapter ${chapterId} and its SHA-256 hash`);
  }
  assertPositiveNumber(source.bytes, `Audio byte size for ${source.url}`);
  if (source.mimeType.length === 0) {
    throw new Error(`Audio MIME type is missing for ${source.url}`);
  }
  return source;
}

function assertChapterBlockTimings(blocks: Array<Array<number>>) {
  let previousBlockStart = -1;
  blocks.forEach((block, index) => {
    if (
      block.length !== 2 ||
      !Number.isFinite(block[0]) ||
      !Number.isFinite(block[1]) ||
      block[0] < 0 ||
      block[1] < block[0] ||
      block[0] < previousBlockStart
    ) {
      throw new Error(`Invalid block timing at index ${index}`);
    }
    previousBlockStart = block[0];
  });
}

function assertChapterCueTimings(cues: Array<Array<number>>, blockCount: number) {
  let previousCueStart = -1;
  cues.forEach((cue, index) => {
    if (
      cue.length !== 3 ||
      !Number.isInteger(cue[0]) ||
      cue[0] < 0 ||
      cue[0] >= blockCount ||
      !Number.isFinite(cue[1]) ||
      !Number.isFinite(cue[2]) ||
      cue[1] < 0 ||
      cue[2] < cue[1] ||
      cue[1] < previousCueStart
    ) {
      throw new Error(`Invalid cue timing at index ${index}`);
    }
    previousCueStart = cue[1];
  });
}

function parseCatalog(rawCatalog: unknown) {
  const parsedCatalog = CatalogSchema.parse(rawCatalog);
  parsedCatalog.chapters.forEach((chapter, index) => {
    assertChapterId(chapter.id);
    assertPositiveNumber(chapter.duration, `Catalog duration for chapter ${chapter.id}`);
    if (chapter.href !== `/${chapter.id}`) {
      throw new Error(`Invalid catalog href for chapter ${chapter.id}`);
    }
    if (chapter.title.length === 0) {
      throw new Error(`Catalog title is missing for chapter ${chapter.id}`);
    }
    if (chapter.audio.sources.length === 0) {
      throw new Error(`Missing audio sources for chapter ${chapter.id}`);
    }
    if (!sha256HashPattern.test(chapter.audio.version)) {
      throw new Error(`Invalid audio version for chapter ${chapter.id}`);
    }
    chapter.audio.sources.forEach((source) => {
      assertAudioAssetForChapter(source, chapter.id);
    });
    if (index > 0) {
      const previousId = Number(parsedCatalog.chapters[index - 1].id);
      const currentId = Number(chapter.id);
      if (currentId <= previousId) {
        throw new Error(`Chapter catalog must be sorted by numeric chapter id at chapter ${chapter.id}`);
      }
    }
  });
  return parsedCatalog.chapters;
}

function parseChapterData() {
  const dataElement = document.querySelector("#ri-chapter-data");
  if (!dataElement?.textContent) {
    return null;
  }
  const parsedData = ChapterDataSchema.parse(JSON.parse(dataElement.textContent));
  assertChapterId(parsedData.chapter);
  if (parsedData.previousChapter) {
    assertChapterId(parsedData.previousChapter, "Previous chapter id");
  }
  if (parsedData.nextChapter) {
    assertChapterId(parsedData.nextChapter, "Next chapter id");
  }
  assertNonnegativeInteger(parsedData.orderIndex, "Chapter order index");
  assertNonnegativeInteger(parsedData.totalChapters, "Chapter count");
  if (parsedData.totalChapters < 1 || parsedData.orderIndex >= parsedData.totalChapters) {
    throw new Error("Chapter order metadata is out of range");
  }
  assertPositiveNumber(parsedData.duration, "Chapter duration");
  if (parsedData.blocks.length === 0 || parsedData.cues.length === 0) {
    throw new Error("Chapter timing data must include blocks and cues");
  }
  assertChapterBlockTimings(parsedData.blocks);
  assertChapterCueTimings(parsedData.cues, parsedData.blocks.length);
  return parsedData;
}

function renderRootRedirect() {
  const root = document.querySelector("#app");
  const target = root?.getAttribute("data-root-chapter") || "1";
  window.location.replace(`/${target}`);
}

function renderError(error: unknown) {
  const root = document.querySelector("#app") ?? document.body;
  const message = error instanceof Error ? error.message : "Unknown chapter loading error";
  const errorElement = document.createElement("div");
  errorElement.className = "error";
  errorElement.textContent = `Unable to load chapter audio: ${message}`;
  root.replaceChildren(errorElement);
}

function formatTime(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = String(safeSeconds % 60).padStart(2, "0");
  return `${minutes}:${remainingSeconds}`;
}

function formatBytes(bytes: number | null) {
  if (bytes === null) {
    return "Not calculated";
  }
  if (bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function makeDownloadSettings(chaptersAhead: number) {
  return DownloadSettingsSchema.parse({
    schema: "ri.download-settings.v2",
    chaptersAhead,
  });
}

function collectIndexedElements(selector: string, datasetKey: "blockIndex" | "cueIndex") {
  const indexedElements: Array<HTMLElement | undefined> = [];
  document.querySelectorAll<HTMLElement>(selector).forEach((element) => {
    const parsedIndex = Number(element.dataset[datasetKey]);
    if (Number.isInteger(parsedIndex) && parsedIndex >= 0) {
      indexedElements[parsedIndex] = element;
    }
  });
  return indexedElements;
}

function collectChapterControls(app: HTMLElement) {
  return {
    header: requireElement<HTMLElement>('[data-testid="chapter-header"]', app),
    audio: requireElement<HTMLAudioElement>('[data-testid="chapter-audio"]', app),
    previousChapterButton: requireElement<HTMLButtonElement>('[data-testid="previous-chapter"]', app),
    nextChapterButton: requireElement<HTMLButtonElement>('[data-testid="next-chapter"]', app),
    chapterCurrentButton: requireElement<HTMLButtonElement>('[data-testid="chapter-picker-toggle"]', app),
    seek: requireElement<HTMLInputElement>('[data-testid="seek"]', app),
    elapsed: requireElement<HTMLElement>('[data-testid="elapsed-time"]', app),
    remaining: requireElement<HTMLElement>('[data-testid="remaining-time"]', app),
    backButton: requireElement<HTMLButtonElement>('[data-testid="back-15"]', app),
    playButton: requireElement<HTMLButtonElement>('[data-testid="play-toggle"]', app),
    forwardButton: requireElement<HTMLButtonElement>('[data-testid="forward-30"]', app),
    chapterPicker: requireElement<HTMLElement>('[data-testid="chapter-picker"]', app),
    chapterPickerClose: requireElement<HTMLButtonElement>('[data-testid="chapter-picker-close"]', app),
    chapterSearch: requireElement<HTMLInputElement>('[data-testid="chapter-search"]', app),
    chapterResultsCount: requireElement<HTMLElement>('[data-testid="chapter-results-count"]', app),
    chapterResults: requireElement<HTMLElement>('[data-testid="chapter-results"]', app),
    chapterResultsSpacer: requireElement<HTMLElement>('[data-testid="chapter-results-spacer"]', app),
    chapterPickerEmpty: requireElement<HTMLElement>('[data-testid="chapter-picker-empty"]', app),
    downloadSettingsButton: requireElement<HTMLButtonElement>('[data-testid="download-settings-toggle"]', app),
    downloadSheet: requireElement<HTMLElement>('[data-testid="download-sheet"]', app),
    downloadSheetClose: requireElement<HTMLButtonElement>('[data-testid="download-sheet-close"]', app),
    chaptersAheadInput: requireElement<HTMLInputElement>('[data-testid="chapters-ahead"]', app),
    chaptersAheadValue: requireElement<HTMLOutputElement>('[data-testid="chapters-ahead-value"]', app),
    chaptersAheadLimit: requireElement<HTMLElement>('[data-testid="chapters-ahead-limit"]', app),
    cachedSize: requireElement<HTMLElement>('[data-testid="cached-size"]', app),
    selectedWindowSize: requireElement<HTMLElement>('[data-testid="selected-window-size"]', app),
    availableStorage: requireElement<HTMLElement>('[data-testid="available-storage"]', app),
    downloadState: requireElement<HTMLElement>('[data-testid="download-state"]', app),
    downloadError: requireElement<HTMLElement>('[data-testid="download-error"]', app),
    clearDownloadsButton: requireElement<HTMLButtonElement>('[data-testid="clear-downloads"]', app),
  };
}

function focusOnNextFrame(element: HTMLElement) {
  window.requestAnimationFrame(() => {
    element.focus();
  });
}

function openDialog(dialog: HTMLElement, trigger: HTMLButtonElement, focusTarget: HTMLElement) {
  dialog.hidden = false;
  trigger.setAttribute("aria-expanded", "true");
  focusOnNextFrame(focusTarget);
}

function closeDialog(dialog: HTMLElement, trigger: HTMLButtonElement, shouldRestoreFocus = true) {
  if (dialog.hidden) {
    return false;
  }
  dialog.hidden = true;
  trigger.setAttribute("aria-expanded", "false");
  if (shouldRestoreFocus) {
    trigger.focus();
  }
  return true;
}

function isBackdropClick(event: MouseEvent, backdrop: HTMLElement) {
  return event.target === backdrop;
}

function trapFocusInDialog(event: KeyboardEvent, dialog: HTMLElement) {
  const focusableControls = Array.from(dialog.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)"));
  const firstControl = focusableControls[0];
  const lastControl = focusableControls[focusableControls.length - 1];
  if (!firstControl || !lastControl) {
    return;
  }
  if (event.shiftKey && document.activeElement === firstControl) {
    event.preventDefault();
    lastControl.focus();
  } else if (!event.shiftKey && document.activeElement === lastControl) {
    event.preventDefault();
    firstControl.focus();
  }
}

function hydrateChapterApp(chapterData: z.infer<typeof ChapterDataSchema>) {
  if (window.location.pathname !== `/${chapterData.chapter}`) {
    window.history.replaceState({ chapter: chapterData.chapter }, "", `/${chapterData.chapter}`);
  }
  const app = requireElement<HTMLElement>('[data-testid="chapter-app"]');
  const {
    header,
    audio,
    previousChapterButton,
    nextChapterButton,
    chapterCurrentButton,
    seek,
    elapsed,
    remaining,
    backButton,
    playButton,
    forwardButton,
    chapterPicker,
    chapterPickerClose,
    chapterSearch,
    chapterResultsCount,
    chapterResults,
    chapterResultsSpacer,
    chapterPickerEmpty,
    downloadSettingsButton,
    downloadSheet,
    downloadSheetClose,
    chaptersAheadInput,
    chaptersAheadValue,
    chaptersAheadLimit,
    cachedSize,
    selectedWindowSize,
    availableStorage,
    downloadState,
    downloadError,
    clearDownloadsButton,
  } = collectChapterControls(app);
  const blockElements = collectIndexedElements("[data-block-index]", "blockIndex");
  const cueElements = collectIndexedElements("[data-cue-index]", "cueIndex");
  let activeBlockIndex = -1;
  let activeCueIndex = -1;
  let isPlaying = false;
  let isCompleted = false;
  let ticker = 0;
  let isProgrammaticSeek = false;
  let hasManualScrollOverride = false;
  let catalog: Array<z.infer<typeof CatalogChapterSchema>> | null = null;
  let catalogPromise: Promise<Array<z.infer<typeof CatalogChapterSchema>>> | null = null;
  let filteredChapterRows: Array<z.infer<typeof CatalogChapterSchema>> = [];
  let chapterPickerRenderFrame = 0;
  let downloadSettings = makeDownloadSettings(defaultChaptersAhead);
  let downloadDbPromise: Promise<IDBDatabase> | null = null;
  let downloadInitialized = false;
  let downloadInitPromise: Promise<void> | null = null;
  let downloadRecords = new Map<string, z.infer<typeof CachedAudioRecordSchema>>();
  let downloadQueue: Array<z.infer<typeof DownloadJobSchema>> = [];
  let activeDownloads = new Map<
    string,
    {
      controller: AbortController;
      job: z.infer<typeof DownloadJobSchema>;
    }
  >();
  let downloadErrorMessage = "";
  let selectedWindowBytes: number | null = null;
  let estimatedAvailableBytes: number | null = null;
  let syncDownloadsPromise: Promise<void> | null = null;
  let shouldResyncDownloads = false;
  let chaptersAheadDraft: number | null = null;

  function clampTime(seconds: number) {
    return Math.min(chapterData.duration, Math.max(0, seconds));
  }

  function progressKeyFor(chapterId: string) {
    return `ri:chapter:${chapterId}:currentTime`;
  }

  function completionKeyFor(chapterId: string) {
    return `ri:chapter:${chapterId}:completed`;
  }

  function requestToPromise<T>(request: IDBRequest<T>) {
    return new Promise<T>((resolveRequest, rejectRequest) => {
      request.addEventListener("success", () => {
        resolveRequest(request.result);
      });
      request.addEventListener("error", () => {
        rejectRequest(request.error ?? new Error("IndexedDB request failed"));
      });
    });
  }

  function transactionDone(transaction: IDBTransaction) {
    return new Promise<void>((resolveTransaction, rejectTransaction) => {
      transaction.addEventListener("complete", () => {
        resolveTransaction();
      });
      transaction.addEventListener("abort", () => {
        rejectTransaction(transaction.error ?? new Error("IndexedDB transaction aborted"));
      });
      transaction.addEventListener("error", () => {
        rejectTransaction(transaction.error ?? new Error("IndexedDB transaction failed"));
      });
    });
  }

  function openDownloadDb() {
    if (!downloadDbPromise) {
      downloadDbPromise = new Promise<IDBDatabase>((resolveDb, rejectDb) => {
        const request = indexedDB.open(downloadDbName, 1);
        request.addEventListener("upgradeneeded", () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("kv")) {
            db.createObjectStore("kv");
          }
          if (!db.objectStoreNames.contains("assets")) {
            db.createObjectStore("assets", { keyPath: "url" });
          }
        });
        request.addEventListener("success", () => {
          resolveDb(request.result);
        });
        request.addEventListener("error", () => {
          rejectDb(request.error ?? new Error("Unable to open download database"));
        });
      });
    }
    return downloadDbPromise;
  }

  function assertDownloadSettings(settings: z.infer<typeof DownloadSettingsSchema>) {
    if (!Number.isInteger(settings.chaptersAhead) || settings.chaptersAhead < 0) {
      throw new Error("Chapters ahead must be a nonnegative whole number.");
    }
    return settings;
  }

  async function readDownloadSettings() {
    const db = await openDownloadDb();
    const transaction = db.transaction("kv", "readonly");
    const done = transactionDone(transaction);
    const rawSettings = await requestToPromise(transaction.objectStore("kv").get("settings"));
    await done;
    if (rawSettings === undefined) {
      return downloadSettings;
    }
    return assertDownloadSettings(DownloadSettingsSchema.parse(rawSettings));
  }

  async function writeDownloadSettings(settings: z.infer<typeof DownloadSettingsSchema>) {
    const parsedSettings = assertDownloadSettings(DownloadSettingsSchema.parse(settings));
    const db = await openDownloadDb();
    const transaction = db.transaction("kv", "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore("kv").put(parsedSettings, "settings");
    await done;
    downloadSettings = parsedSettings;
  }

  async function readDownloadRecords() {
    const db = await openDownloadDb();
    const transaction = db.transaction("assets", "readonly");
    const done = transactionDone(transaction);
    const rawRecords = await requestToPromise(transaction.objectStore("assets").getAll());
    await done;
    const parsedRecords = new Map<string, z.infer<typeof CachedAudioRecordSchema>>();
    for (const rawRecord of rawRecords) {
      const record = CachedAudioRecordSchema.parse(rawRecord);
      assertAudioAssetForChapter(record, record.chapterId);
      if (record.cachedAt !== undefined) {
        assertPositiveNumber(record.cachedAt, `Cached timestamp for ${record.url}`);
      }
      parsedRecords.set(record.url, record);
    }
    return parsedRecords;
  }

  async function putDownloadRecord(record: z.infer<typeof CachedAudioRecordSchema>) {
    const parsedRecord = CachedAudioRecordSchema.parse(record);
    const db = await openDownloadDb();
    const transaction = db.transaction("assets", "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore("assets").put(parsedRecord);
    await done;
    downloadRecords.set(parsedRecord.url, parsedRecord);
    renderDownloadState();
    rerenderChapterOptionsIfOpen();
  }

  async function deleteDownloadRecords(urls: Array<string>) {
    if (urls.length === 0) {
      return;
    }
    const db = await openDownloadDb();
    const transaction = db.transaction("assets", "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore("assets");
    for (const url of urls) {
      store.delete(url);
      downloadRecords.delete(url);
    }
    await done;
    renderDownloadState();
    rerenderChapterOptionsIfOpen();
  }

  async function clearDownloadRecords() {
    const db = await openDownloadDb();
    const transaction = db.transaction("assets", "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore("assets").clear();
    await done;
    downloadRecords = new Map();
    renderDownloadState();
    rerenderChapterOptionsIfOpen();
  }

  function cachedAudioBytes() {
    let total = 0;
    for (const record of downloadRecords.values()) {
      if (record.status === "cached") {
        total += record.bytes;
      }
    }
    return total;
  }

  function preferredAudioAsset(chapter: z.infer<typeof CatalogChapterSchema>) {
    const supportedSources = chapter.audio.sources
      .map((source, index) => {
        assertAudioAssetForChapter(source, chapter.id);
        const support = audio.canPlayType(source.mimeType);
        return {
          source,
          index,
          score: support === "probably" ? 2 : support === "maybe" ? 1 : 0,
        };
      })
      .filter((source) => source.score > 0)
      .sort((first, second) => second.score - first.score || first.index - second.index);
    const selectedSource = supportedSources[0]?.source;
    if (!selectedSource) {
      throw new Error(`No supported audio format is available for chapter ${chapter.id}`);
    }
    return selectedSource;
  }

  function currentDownloadWindow() {
    const loadedCatalog = catalog ?? [];
    const currentIndex = loadedCatalog.findIndex((chapter) => chapter.id === chapterData.chapter);
    if (currentIndex < 0) {
      throw new Error(`Chapter ${chapterData.chapter} is missing from the chapter catalog`);
    }
    const startIndex = currentIndex + 1;
    const endIndex = Math.min(loadedCatalog.length - 1, currentIndex + downloadSettings.chaptersAhead);
    return loadedCatalog.slice(startIndex, endIndex + 1);
  }

  function rerenderChapterOptionsIfOpen() {
    if (!chapterPicker.hidden && catalog) {
      renderChapterOptions();
    }
  }

  function chaptersAheadSliderMax() {
    return Math.max(0, chapterData.totalChapters - chapterData.orderIndex - 1);
  }

  function chaptersAheadSliderValue(value: number) {
    return Math.max(0, Math.min(chaptersAheadSliderMax(), Math.trunc(value)));
  }

  function renderChaptersAheadSlider(value: number) {
    const max = chaptersAheadSliderMax();
    const sliderValue = chaptersAheadSliderValue(value);
    const progress = max === 0 ? 0 : (sliderValue / max) * 100;
    chaptersAheadInput.max = String(max);
    chaptersAheadInput.value = String(sliderValue);
    chaptersAheadInput.style.setProperty("--chapters-ahead-progress", `${progress}%`);
    chaptersAheadInput.setAttribute(
      "aria-valuetext",
      `${sliderValue} chapter${sliderValue === 1 ? "" : "s"} ahead`,
    );
    chaptersAheadValue.textContent = String(sliderValue);
    chaptersAheadLimit.textContent = "Keeps selected upcoming chapters offline";
  }

  function downloadsEnabled() {
    return downloadSettings.chaptersAhead > 0;
  }

  function visibleDownloadState() {
    if (downloadErrorMessage) {
      return "error";
    }
    if (!downloadsEnabled()) {
      return "paused";
    }
    if (!downloadInitialized) {
      return "downloading";
    }
    if (syncDownloadsPromise || shouldResyncDownloads || activeDownloads.size > 0 || downloadQueue.length > 0) {
      return "downloading";
    }
    return "complete";
  }

  function renderDownloadState() {
    renderChaptersAheadSlider(chaptersAheadDraft ?? downloadSettings.chaptersAhead);
    cachedSize.textContent = formatBytes(cachedAudioBytes());
    selectedWindowSize.textContent = formatBytes(selectedWindowBytes);
    availableStorage.textContent = formatBytes(estimatedAvailableBytes);
    const state = visibleDownloadState();
    const activeCount = activeDownloads.size;
    const queuedCount = downloadQueue.length;
    switch (state) {
      case "downloading":
        downloadState.textContent = "Downloading";
        downloadState.title = `${activeCount} active, ${queuedCount} queued`;
        downloadState.setAttribute("aria-label", `Downloading, ${activeCount} active, ${queuedCount} queued`);
        break;
      case "complete":
        downloadState.textContent = "Complete";
        downloadState.title = "";
        downloadState.setAttribute("aria-label", "Complete");
        break;
      case "error":
        downloadState.textContent = "Error";
        downloadState.title = "";
        downloadState.setAttribute("aria-label", "Error");
        break;
      case "paused":
        downloadState.textContent = "Off";
        downloadState.title = "";
        downloadState.setAttribute("aria-label", "Off");
        break;
    }
    downloadError.hidden = !downloadErrorMessage;
    downloadError.textContent = downloadErrorMessage;
    downloadSettingsButton.dataset.downloadState = state;
    app.dataset.downloadState = state;
  }

  async function refreshStorageEstimate() {
    if (!navigator.storage?.estimate) {
      throw new Error("Storage estimates are not available in this browser.");
    }
    const estimate = await navigator.storage.estimate();
    if (!Number.isFinite(estimate.quota) || !Number.isFinite(estimate.usage)) {
      throw new Error("Storage estimates did not include quota and usage.");
    }
    estimatedAvailableBytes = Math.max(0, Number(estimate.quota) - Number(estimate.usage));
    renderDownloadState();
    return estimatedAvailableBytes;
  }

  async function waitForServiceWorkerControl() {
    if (navigator.serviceWorker.controller) {
      return;
    }
    await new Promise<void>((resolveControl, rejectControl) => {
      const timeout = window.setTimeout(() => {
        navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
        rejectControl(new Error("Download service worker did not take control of the page."));
      }, 3000);
      function onControllerChange() {
        window.clearTimeout(timeout);
        navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
        resolveControl();
      }
      navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    });
  }

  async function ensureDownloadRuntime() {
    if (!("indexedDB" in window)) {
      throw new Error("IndexedDB is required for download metadata.");
    }
    if (!("caches" in window)) {
      throw new Error("Cache storage is required for offline downloads.");
    }
    if (!("serviceWorker" in navigator)) {
      throw new Error("Service workers are required for offline playback.");
    }
    const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
    await navigator.serviceWorker.ready;
    try {
      await waitForServiceWorkerControl();
    } catch (error) {
      if (!registration.active) {
        throw error;
      }
    }
  }

  function managedCoreUrls() {
    const urls = new Set<string>(["/chapters/index.json"]);
    document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]').forEach((script) => {
      const url = new URL(script.src, window.location.href);
      if (url.origin === window.location.origin) {
        urls.add(`${url.pathname}${url.search}`);
      }
    });
    document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]').forEach((link) => {
      const url = new URL(link.href, window.location.href);
      if (url.origin === window.location.origin) {
        urls.add(`${url.pathname}${url.search}`);
      }
    });
    return Array.from(urls);
  }

  async function buildDownloadQueue() {
    await loadCatalog();
    const cache = await caches.open(downloadCacheName);
    const windowChapters = currentDownloadWindow();
    const keepAudioUrls = new Set<string>();
    const nextQueue: Array<z.infer<typeof DownloadJobSchema>> = [];
    let windowBytes = 0;
    let pendingAudioBytes = 0;

    for (const coreUrl of managedCoreUrls()) {
      if (!(await cache.match(coreUrl))) {
        nextQueue.push({ kind: "core", chapterId: chapterData.chapter, url: coreUrl });
      }
    }

    for (const chapter of windowChapters) {
      if (!(await cache.match(chapter.href))) {
        nextQueue.push({ kind: "page", chapterId: chapter.id, url: chapter.href });
      }

      const asset = preferredAudioAsset(chapter);
      windowBytes += asset.bytes;
      keepAudioUrls.add(asset.url);
      const record = downloadRecords.get(asset.url);
      const hasCachedAudio = Boolean(record?.status === "cached" && record.hash === asset.hash && (await cache.match(asset.url)));
      const hasActiveAudio = activeDownloads.has(asset.url);
      if (!hasCachedAudio && !hasActiveAudio) {
        if (record && record.hash !== asset.hash) {
          downloadRecords.delete(asset.url);
        }
        pendingAudioBytes += asset.bytes;
        nextQueue.push({ kind: "audio", chapterId: chapter.id, url: asset.url, asset });
      }
    }

    const prunedUrls = Array.from(downloadRecords.values())
      .filter((record) => !keepAudioUrls.has(record.url))
      .map((record) => record.url);
    for (const url of prunedUrls) {
      await cache.delete(url);
    }
    await deleteDownloadRecords(prunedUrls);

    selectedWindowBytes = windowBytes;
    downloadQueue = nextQueue;
    return pendingAudioBytes;
  }

  async function verifyQuotaForQueue(pendingAudioBytes: number) {
    const availableBytes = await refreshStorageEstimate();
    if (pendingAudioBytes > availableBytes) {
      throw new Error(
        `Insufficient storage for selected chapters. Need ${formatBytes(pendingAudioBytes)}, ${formatBytes(
          availableBytes,
        )} available.`,
      );
    }
  }

  function desiredDownloadConcurrency() {
    if (!downloadsEnabled() || downloadErrorMessage) {
      return 0;
    }
    return isPlaying ? 1 : 2;
  }

  function trimActiveDownloads() {
    const desiredConcurrency = desiredDownloadConcurrency();
    const activeEntries = Array.from(activeDownloads.values());
    for (const activeEntry of activeEntries.slice(desiredConcurrency)) {
      activeEntry.controller.abort();
    }
  }

  function scheduleDownloadSync() {
    if (!downloadInitialized) {
      renderDownloadState();
      return;
    }
    if (syncDownloadsPromise) {
      shouldResyncDownloads = true;
      renderDownloadState();
      return;
    }
    syncDownloadsPromise = syncDownloads()
      .catch((error) => {
        downloadErrorMessage = error instanceof Error ? error.message : "Download queue failed.";
        renderDownloadState();
      })
      .finally(() => {
        syncDownloadsPromise = null;
        if (shouldResyncDownloads) {
          shouldResyncDownloads = false;
          scheduleDownloadSync();
        } else {
          renderDownloadState();
        }
      });
  }

  async function syncDownloads() {
    trimActiveDownloads();
    if (downloadErrorMessage) {
      renderDownloadState();
      return;
    }
    const pendingAudioBytes = await buildDownloadQueue();
    if (!downloadsEnabled()) {
      renderDownloadState();
      return;
    }
    await verifyQuotaForQueue(pendingAudioBytes);
    trimActiveDownloads();
    const desiredConcurrency = desiredDownloadConcurrency();
    while (activeDownloads.size < desiredConcurrency && downloadQueue.length > 0) {
      const job = downloadQueue.shift();
      if (job) {
        void startDownloadJob(job);
      }
    }
    renderDownloadState();
  }

  async function startDownloadJob(job: z.infer<typeof DownloadJobSchema>) {
    const controller = new AbortController();
    activeDownloads.set(job.url, { controller, job });
    if (job.kind === "audio" && job.asset) {
      await putDownloadRecord({
        schema: "ri.cached-audio.v1",
        chapterId: job.chapterId,
        url: job.asset.url,
        mimeType: job.asset.mimeType,
        bytes: job.asset.bytes,
        hash: job.asset.hash,
        status: "downloading",
      });
    } else {
      renderDownloadState();
    }

    try {
      const response = await fetch(job.url, { cache: "reload", signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Download request for ${job.url} failed with ${response.status}`);
      }
      const cache = await caches.open(downloadCacheName);
      await cache.put(job.url, response.clone());
      if (job.kind === "audio" && job.asset) {
        await putDownloadRecord({
          schema: "ri.cached-audio.v1",
          chapterId: job.chapterId,
          url: job.asset.url,
          mimeType: job.asset.mimeType,
          bytes: job.asset.bytes,
          hash: job.asset.hash,
          status: "cached",
          cachedAt: Date.now(),
        });
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        if (job.kind === "audio") {
          await deleteDownloadRecords([job.url]);
        }
        return;
      }
      const message = error instanceof Error ? error.message : `Unable to cache ${job.url}`;
      if (job.kind === "audio" && job.asset) {
        await putDownloadRecord({
          schema: "ri.cached-audio.v1",
          chapterId: job.chapterId,
          url: job.asset.url,
          mimeType: job.asset.mimeType,
          bytes: job.asset.bytes,
          hash: job.asset.hash,
          status: "error",
          error: message,
        });
      }
      downloadErrorMessage = message;
    } finally {
      activeDownloads.delete(job.url);
      if (!downloadErrorMessage) {
        scheduleDownloadSync();
      }
      renderDownloadState();
    }
  }

  async function initializeDownloadManager() {
    if (!downloadInitPromise) {
      downloadInitPromise = (async () => {
        await ensureDownloadRuntime();
        downloadSettings = await readDownloadSettings();
        downloadRecords = await readDownloadRecords();
        downloadInitialized = true;
        await refreshStorageEstimate();
        renderDownloadState();
        if (downloadsEnabled() && navigator.storage.persist) {
          await navigator.storage.persist();
        }
        if (downloadsEnabled()) {
          scheduleDownloadSync();
        }
      })();
    }
    return downloadInitPromise;
  }

  function setDownloadError(error: unknown) {
    downloadErrorMessage = error instanceof Error ? error.message : "Offline downloads failed.";
    renderDownloadState();
  }

  async function setChaptersAhead(value: number) {
    await initializeDownloadManager();
    downloadErrorMessage = "";
    if (!Number.isFinite(value)) {
      throw new Error("Chapters ahead must be a number.");
    }
    const chaptersAhead = Math.max(0, Math.trunc(value));
    chaptersAheadDraft = chaptersAhead;
    if (chaptersAhead > 0 && navigator.storage.persist) {
      await navigator.storage.persist();
    }
    await writeDownloadSettings(makeDownloadSettings(chaptersAhead));
    if (chaptersAhead === 0) {
      for (const activeDownload of activeDownloads.values()) {
        activeDownload.controller.abort();
      }
      downloadQueue = [];
    }
    chaptersAheadDraft = null;
    scheduleDownloadSync();
    renderDownloadState();
  }

  async function clearDownloads() {
    await initializeDownloadManager();
    for (const activeDownload of activeDownloads.values()) {
      activeDownload.controller.abort();
    }
    activeDownloads = new Map();
    downloadQueue = [];
    downloadErrorMessage = "";
    await caches.delete(downloadCacheName);
    await clearDownloadRecords();
    await writeDownloadSettings(makeDownloadSettings(0));
    selectedWindowBytes = catalog
      ? currentDownloadWindow().reduce((total, chapter) => total + preferredAudioAsset(chapter).bytes, 0)
      : null;
    await refreshStorageEstimate();
    renderDownloadState();
  }

  async function openDownloadSheet() {
    openDialog(downloadSheet, downloadSettingsButton, chaptersAheadInput);
    try {
      await initializeDownloadManager();
      await loadCatalog();
      selectedWindowBytes = currentDownloadWindow().reduce(
        (total, chapter) => total + preferredAudioAsset(chapter).bytes,
        0,
      );
      await refreshStorageEstimate();
      renderDownloadState();
    } catch (error) {
      setDownloadError(error);
    }
  }

  function closeDownloadSheet(shouldRestoreFocus = true) {
    closeDialog(downloadSheet, downloadSettingsButton, shouldRestoreFocus);
  }

  function scrollToListeningTarget(target: HTMLElement, scrollReason: "seek" | "playback") {
    scrollIntoView(target, {
      behavior: scrollReason === "playback" && !prefersReducedMotion() ? "smooth" : "auto",
      block: "start",
      inline: "nearest",
      scrollMode: "always",
      skipOverflowHiddenElements: true,
    });
  }

  function scrollToTimedPosition(blockIndex: number, scrollReason: "seek" | "playback") {
    if (blockIndex < 0) {
      return;
    }
    scrollToListeningTarget(blockElements[blockIndex] ?? header, scrollReason);
  }

  function pauseAutoScrollForManualNavigation(event?: Event) {
    const target = event?.target;
    if (
      target instanceof Element &&
      target.closest('[data-testid="transport"], [data-testid="chapter-picker"], [data-testid="download-sheet"]')
    ) {
      return;
    }
    hasManualScrollOverride = true;
  }

  function readStoredProgress() {
    const rawProgress = localStorage.getItem(progressKeyFor(chapterData.chapter));
    if (rawProgress === null) {
      return 0;
    }
    const parsedProgress = StoredProgressSchema.safeParse(Number(rawProgress));
    if (
      !parsedProgress.success ||
      parsedProgress.data < 0 ||
      parsedProgress.data >= chapterData.duration - 0.5
    ) {
      localStorage.removeItem(progressKeyFor(chapterData.chapter));
      return 0;
    }
    return parsedProgress.data;
  }

  function readStoredCompletion() {
    const rawCompletion = localStorage.getItem(completionKeyFor(chapterData.chapter));
    if (rawCompletion === null) {
      return false;
    }
    const parsedCompletion = CompletionSchema.safeParse(rawCompletion);
    if (!parsedCompletion.success || Number.isNaN(Date.parse(parsedCompletion.data))) {
      localStorage.removeItem(completionKeyFor(chapterData.chapter));
      return false;
    }
    return true;
  }

  function saveProgress(seconds: number) {
    if (isCompleted || seconds <= 0 || seconds >= chapterData.duration - 0.35) {
      localStorage.removeItem(progressKeyFor(chapterData.chapter));
      return;
    }
    localStorage.setItem(progressKeyFor(chapterData.chapter), seconds.toFixed(3));
  }

  function findBlockIndex(seconds: number) {
    let low = 0;
    let high = chapterData.blocks.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const block = chapterData.blocks[middle];
      if (seconds < block[0]) {
        high = middle - 1;
      } else if (seconds >= block[1]) {
        low = middle + 1;
      } else {
        return middle;
      }
    }
    return Math.min(Math.max(high, 0), chapterData.blocks.length - 1);
  }

  function findCueIndex(seconds: number) {
    let low = 0;
    let high = chapterData.cues.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const cue = chapterData.cues[middle];
      if (seconds < cue[1]) {
        high = middle - 1;
      } else if (seconds >= cue[2]) {
        low = middle + 1;
      } else {
        return middle;
      }
    }
    return -1;
  }

  function updateTransportState(seconds: number) {
    elapsed.textContent = formatTime(seconds);
    remaining.textContent = `-${formatTime(chapterData.duration - seconds)}`;
    seek.max = String(chapterData.duration);
    seek.value = String(seconds);
    seek.style.setProperty(
      "--seek-progress",
      `${chapterData.duration > 0 ? (seconds / chapterData.duration) * 100 : 0}%`,
    );
    seek.setAttribute("aria-valuenow", String(Math.round(seconds)));
    seek.setAttribute("aria-valuetext", `${formatTime(seconds)} elapsed of ${formatTime(chapterData.duration)}`);
    app.dataset.audioState = isCompleted ? "ended" : isPlaying ? "playing" : "paused";
    if (isCompleted) {
      playButton.setAttribute("aria-label", "Replay chapter");
      playButton.dataset.playState = "replay";
    } else if (isPlaying) {
      playButton.setAttribute("aria-label", "Pause chapter");
      playButton.dataset.playState = "pause";
    } else {
      playButton.setAttribute("aria-label", "Play chapter");
      playButton.dataset.playState = "play";
    }
  }

  function updateTranscriptState(seconds: number, scrollReason: "none" | "seek" | "playback") {
    const nextBlockIndex = findBlockIndex(seconds);
    const nextCueIndex = findCueIndex(seconds);
    const blockChanged = nextBlockIndex !== activeBlockIndex;
    if (blockChanged) {
      if (activeBlockIndex >= 0) {
        blockElements[activeBlockIndex]?.classList.remove("is-active");
      }
      activeBlockIndex = nextBlockIndex;
      blockElements[activeBlockIndex]?.classList.add("is-active");
    }
    if (scrollReason === "seek") {
      scrollToTimedPosition(nextBlockIndex, "seek");
    } else if (scrollReason === "playback" && blockChanged && !hasManualScrollOverride) {
      scrollToTimedPosition(nextBlockIndex, "playback");
    }
    if (nextCueIndex !== activeCueIndex) {
      if (activeCueIndex >= 0) {
        cueElements[activeCueIndex]?.classList.remove("is-active");
      }
      activeCueIndex = nextCueIndex;
      if (activeCueIndex >= 0) {
        cueElements[activeCueIndex]?.classList.add("is-active");
      }
    }
  }

  function updateFromTime(seconds: number, scrollReason: "none" | "seek" | "playback" = "none") {
    const clampedSeconds = clampTime(seconds);
    updateTransportState(clampedSeconds);
    updateTranscriptState(clampedSeconds, scrollReason);
  }

  function updateFromAudio() {
    const seconds = clampTime(audio.currentTime || 0);
    updateFromTime(seconds, isPlaying ? "playback" : "none");
    saveProgress(seconds);
  }

  function tick() {
    updateFromAudio();
    if (isPlaying) {
      ticker = window.requestAnimationFrame(tick);
    }
  }

  function startTicker() {
    window.cancelAnimationFrame(ticker);
    ticker = window.requestAnimationFrame(tick);
  }

  function stopTicker() {
    window.cancelAnimationFrame(ticker);
    ticker = 0;
  }

  function seekTo(seconds: number, shouldPersist: boolean) {
    const clampedSeconds = clampTime(seconds);
    isCompleted = false;
    hasManualScrollOverride = false;
    localStorage.removeItem(completionKeyFor(chapterData.chapter));
    isProgrammaticSeek = true;
    audio.currentTime = clampedSeconds;
    isProgrammaticSeek = false;
    updateFromTime(clampedSeconds, "seek");
    if (shouldPersist) {
      saveProgress(clampedSeconds);
    }
  }

  async function togglePlayback() {
    if (isPlaying) {
      audio.pause();
      return;
    }
    if (isCompleted || audio.currentTime >= chapterData.duration - 0.2) {
      seekTo(0, false);
    }
    try {
      await audio.play();
    } catch (error) {
      app.dataset.audioState = "error";
      playButton.setAttribute("aria-label", "Audio unavailable");
      throw error;
    }
  }

  function completePlayback() {
    stopTicker();
    isPlaying = false;
    isCompleted = true;
    localStorage.removeItem(progressKeyFor(chapterData.chapter));
    localStorage.setItem(completionKeyFor(chapterData.chapter), new Date().toISOString());
    updateFromTime(chapterData.duration, "seek");
  }

  function enableControls() {
    seek.disabled = false;
    backButton.disabled = false;
    playButton.disabled = false;
    forwardButton.disabled = false;
    chapterCurrentButton.disabled = false;
    previousChapterButton.disabled = !chapterData.previousChapter;
    nextChapterButton.disabled = !chapterData.nextChapter;
    app.dataset.ready = "true";
  }

  function navigateToChapter(chapterId: string) {
    if (chapterId === chapterData.chapter) {
      closeChapterPicker(false);
      return;
    }
    saveProgress(clampTime(audio.currentTime || 0));
    window.location.assign(`/${chapterId}`);
  }

  async function loadCatalog() {
    if (catalog) {
      return catalog;
    }
    if (!catalogPromise) {
      catalogPromise = fetch("/chapters/index.json")
        .then((response) => {
          if (!response.ok) {
            throw new Error(`chapter catalog request failed with ${response.status}`);
          }
          return response.json();
        })
        .then((rawCatalog) => {
          catalog = parseCatalog(rawCatalog);
          return catalog;
        });
    }
    return catalogPromise;
  }

  function makeChapterOption(chapter: z.infer<typeof CatalogChapterSchema>, rowIndex: number) {
    const button = document.createElement("button");
    button.className = "chapter-option";
    button.dataset.testid = `chapter-${chapter.id}`;
    button.type = "button";
    button.style.transform = `translateY(${rowIndex * pickerRowBlockSize}px)`;
    button.setAttribute("aria-label", `Open chapter ${chapter.id}: ${chapter.title}`);

    const copy = document.createElement("span");
    copy.className = "chapter-option-copy";
    const kicker = document.createElement("span");
    kicker.className = "chapter-option-kicker";
    kicker.textContent = `Chapter ${chapter.id}`;
    const optionTitle = document.createElement("span");
    optionTitle.className = "chapter-option-title";
    optionTitle.textContent = chapter.title;
    copy.append(kicker, optionTitle);

    if (chapter.id === chapterData.chapter) {
      button.setAttribute("aria-current", "page");
      const status = document.createElement("span");
      status.className = "chapter-option-status";
      status.textContent = "Current";
      button.append(copy, status);
    } else {
      button.append(copy);
    }
    button.addEventListener("click", () => {
      navigateToChapter(chapter.id);
    });
    return button;
  }

  function renderChapterResultsCount(query: string) {
    if (!catalog) {
      chapterResultsCount.textContent = "Loading chapters";
      return;
    }
    const total = catalog.length;
    const normalizedQuery = query.trim();
    if (normalizedQuery) {
      const matchLabel = filteredChapterRows.length === 1 ? "match" : "matches";
      const chapterLabel = total === 1 ? "chapter" : "chapters";
      chapterResultsCount.textContent = `${filteredChapterRows.length} ${matchLabel} in ${total} ${chapterLabel}`;
      return;
    }
    chapterResultsCount.textContent = `${total} ${total === 1 ? "chapter" : "chapters"}`;
  }

  function setChapterResultsHeight() {
    chapterResultsSpacer.style.height = `${filteredChapterRows.length * pickerRowBlockSize}px`;
  }

  function virtualChapterRange() {
    if (filteredChapterRows.length === 0) {
      return { start: 0, end: 0 };
    }
    const visibleRows = Math.max(1, Math.ceil(chapterResults.clientHeight / pickerRowBlockSize));
    const firstVisibleRow = Math.max(0, Math.floor(chapterResults.scrollTop / pickerRowBlockSize));
    const start = Math.max(0, firstVisibleRow - pickerOverscanRows);
    const end = Math.min(filteredChapterRows.length, firstVisibleRow + visibleRows + pickerOverscanRows + 1);
    return { start, end };
  }

  function renderChapterOptions() {
    setChapterResultsHeight();
    const { start, end } = virtualChapterRange();
    const rows: Array<HTMLButtonElement> = [];
    for (let rowIndex = start; rowIndex < end; rowIndex += 1) {
      const chapter = filteredChapterRows[rowIndex];
      if (chapter) {
        rows.push(makeChapterOption(chapter, rowIndex));
      }
    }
    chapterResultsSpacer.replaceChildren(...rows);
    chapterPickerEmpty.hidden = filteredChapterRows.length > 0;
    if (filteredChapterRows.length === 0) {
      chapterPickerEmpty.textContent = "No chapters found.";
    }
  }

  function scheduleChapterOptionsRender() {
    if (chapterPicker.hidden || chapterPickerRenderFrame !== 0) {
      return;
    }
    chapterPickerRenderFrame = window.requestAnimationFrame(() => {
      chapterPickerRenderFrame = 0;
      renderChapterOptions();
    });
  }

  function centerCurrentChapterInPicker() {
    const currentIndex = filteredChapterRows.findIndex((chapter) => chapter.id === chapterData.chapter);
    if (currentIndex < 0) {
      chapterResults.scrollTop = 0;
      renderChapterOptions();
      return;
    }
    const fullHeight = filteredChapterRows.length * pickerRowBlockSize;
    const visibleHeight = chapterResults.clientHeight;
    const centeredTop = currentIndex * pickerRowBlockSize - Math.max(0, (visibleHeight - pickerRowBlockSize) / 2);
    const maxScrollTop = Math.max(0, fullHeight - visibleHeight);
    chapterResults.scrollTop = Math.min(maxScrollTop, Math.max(0, centeredTop));
    renderChapterOptions();
  }

  function updateChapterFilter(query: string, shouldCenterCurrentChapter: boolean) {
    const loadedCatalog = catalog ?? [];
    const normalizedQuery = query.trim().toLowerCase();
    if (normalizedQuery) {
      filteredChapterRows = loadedCatalog.filter(
        (chapter) => chapter.id.includes(normalizedQuery) || chapter.title.toLowerCase().includes(normalizedQuery),
      );
    } else {
      filteredChapterRows = loadedCatalog;
    }
    setChapterResultsHeight();
    renderChapterResultsCount(query);
    if (shouldCenterCurrentChapter) {
      centerCurrentChapterInPicker();
    } else {
      chapterResults.scrollTop = 0;
      renderChapterOptions();
    }
  }

  async function openChapterPicker() {
    if (app.dataset.ready !== "true") {
      return;
    }
    openDialog(chapterPicker, chapterCurrentButton, chapterSearch);
    chapterSearch.value = "";
    filteredChapterRows = [];
    chapterResults.scrollTop = 0;
    chapterResults.setAttribute("aria-busy", "true");
    chapterResultsCount.textContent = "Loading chapters";
    chapterResultsSpacer.style.height = "0px";
    chapterResultsSpacer.replaceChildren();
    chapterPickerEmpty.hidden = false;
    chapterPickerEmpty.textContent = "Loading chapters.";
    try {
      await loadCatalog();
      chapterResults.setAttribute("aria-busy", "false");
      updateChapterFilter("", true);
    } catch (error) {
      chapterPickerEmpty.hidden = false;
      chapterPickerEmpty.textContent = error instanceof Error ? error.message : "Unable to load chapters.";
      throw error;
    }
  }

  function closeChapterPicker(shouldRestoreFocus = true) {
    if (!closeDialog(chapterPicker, chapterCurrentButton, shouldRestoreFocus)) {
      return;
    }
    if (chapterPickerRenderFrame !== 0) {
      window.cancelAnimationFrame(chapterPickerRenderFrame);
      chapterPickerRenderFrame = 0;
    }
  }

  function currentOpenDialog() {
    if (!chapterPicker.hidden) {
      return chapterPicker;
    }
    if (!downloadSheet.hidden) {
      return downloadSheet;
    }
    return null;
  }

  function handleGlobalKeydown(event: KeyboardEvent) {
    if (event.key === "Escape" && !chapterPicker.hidden) {
      event.preventDefault();
      closeChapterPicker();
      return;
    }
    if (event.key === "Escape" && !downloadSheet.hidden) {
      event.preventDefault();
      closeDownloadSheet();
      return;
    }
    const dialog = currentOpenDialog();
    if (event.key === "Tab" && dialog) {
      trapFocusInDialog(event, dialog);
      return;
    }
    if (scrollNavigationKeys.has(event.key)) {
      pauseAutoScrollForManualNavigation(event);
    }
  }

  seek.addEventListener("input", () => {
    const parsedSeconds = StoredProgressSchema.parse(Number(seek.value));
    seekTo(parsedSeconds, true);
  });

  backButton.addEventListener("click", () => {
    seekTo((audio.currentTime || 0) - 15, true);
  });

  forwardButton.addEventListener("click", () => {
    seekTo((audio.currentTime || 0) + 30, true);
  });

  playButton.addEventListener("click", () => {
    void togglePlayback();
  });

  previousChapterButton.addEventListener("click", () => {
    if (chapterData.previousChapter) {
      navigateToChapter(chapterData.previousChapter);
    }
  });

  nextChapterButton.addEventListener("click", () => {
    if (chapterData.nextChapter) {
      navigateToChapter(chapterData.nextChapter);
    }
  });

  chapterCurrentButton.addEventListener("click", () => {
    void openChapterPicker();
  });

  chapterSearch.addEventListener("input", () => {
    updateChapterFilter(chapterSearch.value, chapterSearch.value.trim().length === 0);
  });

  chapterResults.addEventListener("scroll", scheduleChapterOptionsRender, { passive: true });

  window.addEventListener("resize", () => {
    scheduleChapterOptionsRender();
  });

  chapterPickerClose.addEventListener("click", () => {
    closeChapterPicker();
  });

  chapterPicker.addEventListener("click", (event) => {
    if (isBackdropClick(event, chapterPicker)) {
      closeChapterPicker();
    }
  });

  downloadSettingsButton.addEventListener("click", () => {
    void openDownloadSheet();
  });

  downloadSheetClose.addEventListener("click", () => {
    closeDownloadSheet();
  });

  downloadSheet.addEventListener("click", (event) => {
    if (isBackdropClick(event, downloadSheet)) {
      closeDownloadSheet();
    }
  });

  chaptersAheadInput.addEventListener("input", () => {
    chaptersAheadDraft = chaptersAheadSliderValue(Number(chaptersAheadInput.value));
    renderChaptersAheadSlider(chaptersAheadDraft);
  });

  chaptersAheadInput.addEventListener("change", () => {
    chaptersAheadDraft = chaptersAheadSliderValue(Number(chaptersAheadInput.value));
    setChaptersAhead(chaptersAheadDraft).catch((error) => {
      chaptersAheadDraft = null;
      setDownloadError(error);
    });
  });

  clearDownloadsButton.addEventListener("click", () => {
    clearDownloads().catch((error) => {
      setDownloadError(error);
    });
  });

  window.addEventListener("wheel", pauseAutoScrollForManualNavigation, { passive: true });
  window.addEventListener("touchmove", pauseAutoScrollForManualNavigation, { passive: true });
  window.addEventListener("keydown", handleGlobalKeydown);

  window.addEventListener("beforeunload", () => {
    saveProgress(clampTime(audio.currentTime || 0));
  });

  audio.addEventListener("play", () => {
    isPlaying = true;
    isCompleted = false;
    localStorage.removeItem(completionKeyFor(chapterData.chapter));
    updateFromAudio();
    startTicker();
    scheduleDownloadSync();
  });

  audio.addEventListener("pause", () => {
    if (isCompleted) {
      return;
    }
    isPlaying = false;
    stopTicker();
    updateFromAudio();
    scheduleDownloadSync();
  });

  audio.addEventListener("timeupdate", () => {
    if (!isProgrammaticSeek) {
      updateFromAudio();
    }
  });

  audio.addEventListener("seeked", updateFromAudio);
  audio.addEventListener("ended", completePlayback);
  audio.addEventListener("error", () => {
    app.dataset.audioState = "error";
    playButton.setAttribute("aria-label", "Audio unavailable");
    playButton.disabled = true;
  });

  const resumeTime = readStoredProgress();
  isCompleted = resumeTime === 0 && readStoredCompletion();
  seek.max = String(chapterData.duration);
  updateFromTime(resumeTime);
  if (resumeTime > 0) {
    audio.addEventListener(
      "loadedmetadata",
      () => {
        seekTo(resumeTime, false);
      },
      { once: true },
    );
  }
  renderDownloadState();
  initializeDownloadManager().catch((error) => {
    setDownloadError(error);
  });
  audio.load();
  enableControls();
}

function bootstrapReader() {
  const chapterData = parseChapterData();
  if (!chapterData) {
    renderRootRedirect();
    return;
  }
  hydrateChapterApp(chapterData);
}

try {
  bootstrapReader();
} catch (error) {
  renderError(error);
}
