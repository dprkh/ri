import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  After,
  AfterAll,
  Before,
  BeforeAll,
  Given,
  Then,
  When,
  setDefaultTimeout,
} from "@cucumber/cucumber";
import { chromium, firefox, webkit } from "playwright";

setDefaultTimeout(90_000);

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const baseUrl = "http://127.0.0.1:4173";
const catalogPath = "/chapters/index.json";
const downloadCacheName = "ri-reader-offline-v12";
const downloadDbName = "ri-reader-downloads-v4";
const dataTestId = (id) => `[data-testid="${id}"]`;
const chapterOptionTestId = (chapter) => `chapter-${chapter}`;
const chapterOptionSelector = (chapter) => dataTestId(chapterOptionTestId(chapter));
const mobileViewport = Object.freeze({ width: 390, height: 844 });
const layoutViewports = Object.freeze([
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 1280, height: 900 },
]);
const chromiumLaunchOptions = Object.freeze({
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const selectors = Object.freeze({
  back15: dataTestId("back-15"),
  cachedSize: dataTestId("cached-size"),
  chapterAppReady: `${dataTestId("chapter-app")}[data-ready="true"]`,
  chapterAudio: dataTestId("chapter-audio"),
  chapterAudioSources: `${dataTestId("chapter-audio")} source`,
  chapterHeader: dataTestId("chapter-header"),
  chapterLabel: dataTestId("chapter-label"),
  chapterNavigation: dataTestId("chapter-navigation"),
  chapterPicker: dataTestId("chapter-picker"),
  chapterPickerToggle: dataTestId("chapter-picker-toggle"),
  chapterResults: dataTestId("chapter-results"),
  chapterResultsCount: dataTestId("chapter-results-count"),
  chapterSearch: dataTestId("chapter-search"),
  chapterTitle: dataTestId("chapter-title"),
  chaptersAhead: dataTestId("chapters-ahead"),
  clearDownloads: dataTestId("clear-downloads"),
  downloadError: dataTestId("download-error"),
  downloadSettingsToggle: dataTestId("download-settings-toggle"),
  downloadSheet: dataTestId("download-sheet"),
  downloadSheetClose: dataTestId("download-sheet-close"),
  downloadState: dataTestId("download-state"),
  elapsedTime: dataTestId("elapsed-time"),
  forward30: dataTestId("forward-30"),
  nextChapter: dataTestId("next-chapter"),
  playToggle: dataTestId("play-toggle"),
  previousChapter: dataTestId("previous-chapter"),
  seek: dataTestId("seek"),
  selectedWindowSize: dataTestId("selected-window-size"),
  transcript: dataTestId("transcript"),
  transcriptBlock: dataTestId("transcript-block"),
  transport: dataTestId("transport"),
});
let server;
let browser;
let context;
let page;
let serverOutput = "";
let manualScrollY = 0;
let expectedLastAvailableChapter = null;

async function runCommand(command, args) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd: webRoot,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let commandOutput = "";
    child.stdout.on("data", (chunk) => {
      commandOutput += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      commandOutput += chunk.toString();
    });
    child.on("error", rejectCommand);
    child.on("close", (code) => {
      if (code === 0) {
        resolveCommand(commandOutput);
      } else {
        rejectCommand(new Error(`${command} ${args.join(" ")} failed with ${code}:\n${commandOutput}`));
      }
    });
  });
}

async function delay(ms) {
  await new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

async function waitForServer() {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    const ready = await new Promise((resolveReady) => {
      const request = http.get(baseUrl, (response) => {
        response.resume();
        resolveReady(response.statusCode && response.statusCode < 500);
      });
      request.on("error", () => resolveReady(false));
      request.setTimeout(500, () => {
        request.destroy();
        resolveReady(false);
      });
    });
    if (ready) {
      return;
    }
    await delay(150);
  }
  throw new Error(`Bun dev server did not start:\n${serverOutput}`);
}

async function waitForReaderReady(targetPage = page) {
  await targetPage.waitForSelector(selectors.chapterAppReady);
}

async function openReader() {
  await page.goto(baseUrl);
  await waitForReaderReady();
}

async function openChapter(chapter) {
  await page.goto(`${baseUrl}/${chapter}`);
  await waitForReaderReady();
}

async function openDownloadSheet(targetPage = page) {
  const sheet = targetPage.locator(selectors.downloadSheet);
  if (await sheet.isVisible()) {
    return;
  }
  await targetPage.locator(selectors.downloadSettingsToggle).click();
  await sheet.waitFor({ state: "visible" });
}

async function closeDownloadSheetIfOpen(targetPage = page) {
  if (await targetPage.locator(selectors.downloadSheet).isVisible()) {
    await targetPage.locator(selectors.downloadSheetClose).click();
  }
}

async function setChaptersAhead(value, targetPage = page) {
  await targetPage.locator(selectors.chaptersAhead).evaluate((input, nextValue) => {
    input.value = String(nextValue);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

async function enableDownloads(chaptersAhead = null, targetPage = page) {
  await openDownloadSheet(targetPage);
  if (chaptersAhead !== null) {
    await setChaptersAhead(chaptersAhead, targetPage);
  }
}

async function chapterCatalog(targetPage = page) {
  return targetPage.evaluate(async (path) => {
    const catalogResponse = await fetch(path);
    if (!catalogResponse.ok) {
      throw new Error(`catalog request failed with ${catalogResponse.status}`);
    }
    const catalog = await catalogResponse.json();
    if (!Array.isArray(catalog.chapters) || catalog.chapters.length === 0) {
      throw new Error("chapter catalog is empty");
    }
    return catalog;
  }, catalogPath);
}

async function lastAvailableChapter(targetPage = page) {
  const catalog = await chapterCatalog(targetPage);
  return {
    chapter: catalog.chapters[catalog.chapters.length - 1],
    total: catalog.chapters.length,
  };
}

async function openChapterPicker(targetPage = page) {
  const picker = targetPage.locator(selectors.chapterPicker);
  if (await picker.isHidden()) {
    await targetPage.locator(selectors.chapterPickerToggle).click();
    await picker.waitFor({ state: "visible" });
  }
  await targetPage.locator(`${selectors.chapterResults} button`).first().waitFor();
}

async function chooseChapterFromPicker(chapter, targetPage = page) {
  await openChapterPicker(targetPage);
  await targetPage.locator(chapterOptionSelector(chapter)).click();
  await waitForReaderReady(targetPage);
}

async function preferredChapterSource(chapter, targetPage = page) {
  return targetPage.evaluate(async ({ chapterId, path }) => {
    const catalogResponse = await fetch(path);
    if (!catalogResponse.ok) {
      throw new Error(`catalog request failed with ${catalogResponse.status}`);
    }
    const catalog = await catalogResponse.json();
    const selectedChapter = catalog.chapters.find((entry) => entry.id === String(chapterId));
    if (!selectedChapter) {
      throw new Error(`chapter ${chapterId} not found in catalog`);
    }
    const probe = document.createElement("audio");
    const supportedSources = selectedChapter.audio.sources
      .map((candidate, index) => {
        const support = probe.canPlayType(candidate.mimeType);
        const score = support === "probably" ? 2 : support === "maybe" ? 1 : 0;
        return { candidate, index, score };
      })
      .filter(({ score }) => score > 0)
      .sort((first, second) => second.score - first.score || first.index - second.index)[0]?.candidate;
    if (!supportedSources) {
      throw new Error(`no supported source for chapter ${chapterId}`);
    }
    return { chapter: selectedChapter, source: supportedSources };
  }, { chapterId: chapter, path: catalogPath });
}

async function preferredAudioUrlFor(chapter, targetPage = page) {
  return (await preferredChapterSource(chapter, targetPage)).source.url;
}

async function managedCoreUrls(targetPage = page) {
  return targetPage.evaluate((path) => {
    const urls = new Set([path]);
    document.querySelectorAll('script[type="module"][src]').forEach((script) => {
      const url = new URL(script.src, window.location.href);
      if (url.origin === window.location.origin) {
        urls.add(`${url.pathname}${url.search}`);
      }
    });
    document.querySelectorAll('link[rel="stylesheet"][href]').forEach((link) => {
      const url = new URL(link.href, window.location.href);
      if (url.origin === window.location.origin) {
        urls.add(`${url.pathname}${url.search}`);
      }
    });
    return Array.from(urls);
  }, catalogPath);
}

async function waitForChapterOffline(chapter) {
  const { chapter: selectedChapter, source } = await preferredChapterSource(chapter);
  const coreUrls = await managedCoreUrls();
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await page.waitForFunction(
    async ({ chapterId, chapterHref, cacheName, dbName, coreUrls: urls, source: audioSource }) => {
      window.__riReadyOfflineUrls = window.__riReadyOfflineUrls || {};
      window.__riReadyOfflineUrls[chapterId] = audioSource.url;
      const cache = await caches.open(cacheName);
      const dbRequest = indexedDB.open(dbName, 1);
      const db = await new Promise((resolveDb, rejectDb) => {
        dbRequest.addEventListener("success", () => resolveDb(dbRequest.result));
        dbRequest.addEventListener("error", () => rejectDb(dbRequest.error));
      });
      const transaction = db.transaction("assets", "readonly");
      const recordsRequest = transaction.objectStore("assets").getAll();
      const records = await new Promise((resolveRecords, rejectRecords) => {
        recordsRequest.addEventListener("success", () => resolveRecords(recordsRequest.result));
        recordsRequest.addEventListener("error", () => rejectRecords(recordsRequest.error));
      });
      db.close();
      for (const coreUrl of urls) {
        if (!(await cache.match(coreUrl))) {
          return false;
        }
      }
      return Boolean(
        (await cache.match(chapterHref)) &&
          (await cache.match(audioSource.url)) &&
          records.some(
            (record) =>
              record.chapterId === chapterId &&
              record.url === audioSource.url &&
              record.hash === audioSource.hash &&
              record.status === "cached",
          ),
      );
    },
    {
      chapterId: String(chapter),
      chapterHref: selectedChapter.href,
      cacheName: downloadCacheName,
      dbName: downloadDbName,
      coreUrls,
      source,
    },
    { timeout: 30_000 },
  );
}

async function ensureChapterOffline(chapter) {
  const { chapter: selectedChapter, source } = await preferredChapterSource(chapter);
  const coreUrls = await managedCoreUrls();
  await page.evaluate(async ({ chapterId, chapterHref, cacheName, dbName, coreUrls: urls, source: audioSource }) => {
    const cache = await caches.open(cacheName);
    for (const url of new Set([...urls, chapterHref, audioSource.url])) {
      if (!(await cache.match(url))) {
        const response = await fetch(url, { cache: "reload" });
        if (!response.ok) {
          throw new Error(`offline asset request for ${url} failed with ${response.status}`);
        }
        await cache.put(url, response.clone());
      }
    }
    const dbRequest = indexedDB.open(dbName, 1);
    const db = await new Promise((resolveDb, rejectDb) => {
      dbRequest.addEventListener("upgradeneeded", () => {
        const database = dbRequest.result;
        if (!database.objectStoreNames.contains("kv")) {
          database.createObjectStore("kv");
        }
        if (!database.objectStoreNames.contains("assets")) {
          database.createObjectStore("assets", { keyPath: "url" });
        }
      });
      dbRequest.addEventListener("success", () => resolveDb(dbRequest.result));
      dbRequest.addEventListener("error", () => rejectDb(dbRequest.error));
    });
    const transaction = db.transaction("assets", "readwrite");
    const done = new Promise((resolveDone, rejectDone) => {
      transaction.addEventListener("complete", resolveDone);
      transaction.addEventListener("error", () => rejectDone(transaction.error));
      transaction.addEventListener("abort", () => rejectDone(transaction.error));
    });
    transaction.objectStore("assets").put({
      schema: "ri.cached-audio.v1",
      chapterId: String(chapterId),
      url: audioSource.url,
      mimeType: audioSource.mimeType,
      bytes: audioSource.bytes,
      hash: audioSource.hash,
      status: "cached",
      cachedAt: Date.now(),
    });
    await done;
    db.close();
    window.__riReadyOfflineUrls = window.__riReadyOfflineUrls || {};
    window.__riReadyOfflineUrls[String(chapterId)] = audioSource.url;
  }, {
    chapterId: String(chapter),
    chapterHref: selectedChapter.href,
    cacheName: downloadCacheName,
    dbName: downloadDbName,
    coreUrls,
    source,
  });
}

async function waitForPlayState(expectedState) {
  await page.waitForFunction(
    ({ selector, state }) => document.querySelector(selector)?.getAttribute("data-play-state") === state,
    { selector: selectors.playToggle, state: expectedState },
  );
}

async function setAudioTime(seconds, events) {
  await page.locator(selectors.chapterAudio).evaluate((audio, { value, eventNames }) => {
    audio.currentTime = value;
    eventNames.forEach((eventName) => {
      audio.dispatchEvent(new Event(eventName));
    });
  }, { value: seconds, eventNames: events });
}

async function setListeningTime(seconds) {
  await setAudioTime(seconds, ["timeupdate", "seeked"]);
}

async function advancePlaybackTo(seconds) {
  await setAudioTime(seconds, ["timeupdate"]);
}

async function finishChapter() {
  await page.locator(selectors.chapterAudio).evaluate((audio, seekSelector) => {
    const seek = document.querySelector(seekSelector);
    const duration = seek instanceof HTMLInputElement ? Number(seek.max) : 0;
    audio.currentTime = duration;
    audio.dispatchEvent(new Event("timeupdate"));
    audio.dispatchEvent(new Event("ended"));
  }, selectors.seek);
}

async function findFirstNarrativePauseTime() {
  return page.evaluate((transcriptBlockSelector) => {
    const dataElement = document.querySelector("#ri-chapter-data");
    if (!dataElement?.textContent) {
      throw new Error("Missing chapter timing data");
    }
    const chapterData = JSON.parse(dataElement.textContent);
    const pauseBlock = Array.from(document.querySelectorAll(transcriptBlockSelector)).find(
      (element) => element.textContent?.trim() === "...",
    );
    if (!(pauseBlock instanceof HTMLElement)) {
      throw new Error("Missing narrative pause block");
    }
    const blockIndex = Number(pauseBlock.dataset.blockIndex);
    const blockTiming = chapterData.blocks?.[blockIndex];
    if (!Array.isArray(blockTiming) || blockTiming.length !== 2) {
      throw new Error("Missing narrative pause timing");
    }
    const pauseDuration = blockTiming[1] - blockTiming[0];
    if (pauseDuration < 0.95 || pauseDuration > 1.05) {
      throw new Error(`Narrative pause duration was ${pauseDuration.toFixed(3)} seconds`);
    }
    return blockTiming[0] + pauseDuration / 2;
  }, selectors.transcriptBlock);
}

async function makePlaybackActive() {
  await page.locator(selectors.chapterAudio).evaluate(async (audio) => {
    await audio.play();
  });
  await waitForPlayState("pause");
}

async function waitForText(selector, text, targetPage = page) {
  await targetPage.waitForFunction(
    ({ targetSelector, expectedText }) => document.querySelector(targetSelector)?.textContent === expectedText,
    { targetSelector: selector, expectedText: text },
  );
}

async function waitForDownloadsActive(targetPage = page, options = undefined) {
  await targetPage.waitForFunction(
    (stateSelector) => {
      const state = document.querySelector(stateSelector)?.textContent ?? "";
      return state.startsWith("Downloading") || state === "Complete";
    },
    selectors.downloadState,
    options,
  );
}

async function waitForDownloadQueueStarted(targetPage = page, options = undefined) {
  await targetPage.waitForFunction(
    ({ stateSelector, sizeSelector }) => {
      const state = document.querySelector(stateSelector)?.textContent ?? "";
      const selectedSize = document.querySelector(sizeSelector)?.textContent ?? "";
      return (state.startsWith("Downloading") || state === "Complete") && selectedSize !== "" && selectedSize !== "Not calculated";
    },
    {
      stateSelector: selectors.downloadState,
      sizeSelector: selectors.selectedWindowSize,
    },
    options,
  );
}

async function waitForChapterOption(chapter, title, targetPage = page) {
  await targetPage.waitForFunction(
    ({ optionSelector, expectedChapter, expectedTitle }) => {
      const option = document.querySelector(optionSelector);
      return option?.textContent?.includes(`Chapter ${expectedChapter}`) && option.textContent.includes(expectedTitle);
    },
    {
      optionSelector: chapterOptionSelector(chapter),
      expectedChapter: chapter,
      expectedTitle: title,
    },
  );
}

async function assertElapsedTime(time) {
  await waitForText(selectors.elapsedTime, time);
}

async function assertPlayButtonLabel(label) {
  assert.equal(await page.locator(selectors.playToggle).getAttribute("aria-label"), label);
}

async function expectEnabled(selector, targetPage = page) {
  await targetPage.waitForFunction((targetSelector) => {
    const element = document.querySelector(targetSelector);
    return element instanceof HTMLButtonElement && !element.disabled;
  }, selector);
}

async function assertFollowedPassageNearReadingStart() {
  await page.waitForFunction((transcriptBlockSelector) => {
    const activeTranscript = document.querySelector(`${transcriptBlockSelector}.is-active`);
    if (!activeTranscript) {
      return false;
    }
    const bounds = activeTranscript.getBoundingClientRect();
    return bounds.top >= 0 && bounds.top <= Math.min(96, window.innerHeight * 0.22);
  }, selectors.transcriptBlock);
}

async function assertChapterOpeningNearReadingStart() {
  await page.waitForFunction((chapterHeaderSelector) => {
    const header = document.querySelector(chapterHeaderSelector);
    if (!header) {
      return false;
    }
    const bounds = header.getBoundingClientRect();
    return bounds.top >= 0 && bounds.top <= Math.min(96, window.innerHeight * 0.22);
  }, selectors.chapterHeader);
}

async function readPickerWindowState() {
  return page.evaluate(({ resultsSelector, searchSelector, countSelector }) => {
    const results = document.querySelector(resultsSelector);
    const search = document.querySelector(searchSelector);
    const count = document.querySelector(countSelector);
    const renderedChoices = Array.from(document.querySelectorAll(`${resultsSelector} [data-testid^="chapter-"]`)).filter(
      (element) => /^chapter-\d+$/.test(element.getAttribute("data-testid") ?? ""),
    );
    const optionHeights = renderedChoices.map((element) => element.getBoundingClientRect().height);
    return {
      renderedChoices: renderedChoices.length,
      resultsHeight: results?.clientHeight ?? 0,
      searchValue: search?.value ?? "",
      countText: count?.textContent ?? "",
      shortestOption: optionHeights.length > 0 ? Math.min(...optionHeights) : 0,
    };
  }, {
    resultsSelector: selectors.chapterResults,
    searchSelector: selectors.chapterSearch,
    countSelector: selectors.chapterResultsCount,
  });
}

async function readReaderLayout() {
  return page.evaluate(
    ({ checkedSelector, seekSelector, transcriptSelector, transcriptBlockSelector, transportSelector }) => {
      const rectFor = (element, index) => {
        const rect = element.getBoundingClientRect();
        return {
          index,
          testId: element.getAttribute("data-testid") ?? "",
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        };
      };
      const checkedElements = Array.from(document.querySelectorAll(checkedSelector)).map((element) => ({
        tag: element.tagName,
        testId: element.getAttribute("data-testid"),
        widthFits: element.scrollWidth <= element.clientWidth + 2 || getComputedStyle(element).overflowX === "visible",
        heightFits: element.scrollHeight <= element.clientHeight + 2 || getComputedStyle(element).overflowY === "visible",
      }));
      const controls = Array.from(document.querySelectorAll("button"))
        .map(rectFor)
        .filter((rect) => rect.width > 0 && rect.height > 0);
      const overlaps = [];
      for (let firstIndex = 0; firstIndex < controls.length; firstIndex += 1) {
        for (let secondIndex = firstIndex + 1; secondIndex < controls.length; secondIndex += 1) {
          const first = controls[firstIndex];
          const second = controls[secondIndex];
          const separated =
            first.right <= second.left + 1 ||
            second.right <= first.left + 1 ||
            first.bottom <= second.top + 1 ||
            second.bottom <= first.top + 1;
          if (!separated) {
            overlaps.push([first.index, second.index]);
          }
        }
      }
      window.scrollTo(0, document.documentElement.scrollHeight);
      const seek = document.querySelector(seekSelector)?.getBoundingClientRect();
      const transcript = document.querySelector(transcriptSelector);
      const transcriptBlocks = Array.from(document.querySelectorAll(transcriptBlockSelector));
      const lastTranscriptBlock = transcriptBlocks.at(-1);
      const lastTranscriptBottom =
        lastTranscriptBlock instanceof HTMLElement ? lastTranscriptBlock.getBoundingClientRect().bottom : 0;
      const transportRect = document.querySelector(transportSelector)?.getBoundingClientRect();
      const transcriptBlockRects = transcriptBlocks
        .filter((element) => element instanceof HTMLElement && element.offsetParent !== null)
        .map((element) => element.getBoundingClientRect());
      const transcriptBlockGaps = transcriptBlockRects
        .slice(1)
        .map((rect, index) => rect.top - transcriptBlockRects[index].bottom);
      const chapterCurrentKicker = document.querySelector(".chapter-current-kicker");
      const viewportMeta = document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? "";
      const themeColor = document.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? "";
      const htmlStyle = getComputedStyle(document.documentElement);
      const bodyStyle = getComputedStyle(document.body);

      return {
        bodyWidthFits: document.documentElement.scrollWidth <= window.innerWidth + 1,
        checkedElements,
        overlaps,
        undersizedControls: controls.filter((rect) => rect.width < 44 || rect.height < 44),
        chapterCurrentKicker: {
          text: chapterCurrentKicker?.textContent ?? "",
          clientWidth: chapterCurrentKicker instanceof HTMLElement ? chapterCurrentKicker.clientWidth : 0,
          scrollWidth: chapterCurrentKicker instanceof HTMLElement ? chapterCurrentKicker.scrollWidth : 0,
          fits:
            chapterCurrentKicker instanceof HTMLElement &&
            chapterCurrentKicker.scrollWidth <= chapterCurrentKicker.clientWidth + 1,
        },
        seekHitAreaFits: Boolean(seek && seek.height >= 44),
        transcriptArticleCount: document.querySelectorAll("article").length,
        transcriptIsArticle: transcript?.tagName === "ARTICLE",
        transcriptBlocksAreParagraphs: transcriptBlocks
          .filter((element) => element.getAttribute("data-kind") !== "heading")
          .every((element) => element.tagName === "P"),
        maxTranscriptBlockGap: Math.max(0, ...transcriptBlockGaps),
        transcriptClearsTransport: lastTranscriptBottom <= (transportRect?.top ?? 0) - 8,
        transportFloatsAboveBrowserChrome:
          window.innerWidth >= 760 ||
          Boolean(
            transportRect &&
              transportRect.left >= 8 &&
              window.innerWidth - transportRect.right >= 8 &&
              window.innerHeight - transportRect.bottom >= 8,
          ),
        browserChrome: {
          viewportCoversSafeArea: viewportMeta.includes("viewport-fit=cover"),
          themeColor: themeColor.toLowerCase(),
          expectedThemeColor: htmlStyle.getPropertyValue("--bg").trim().toLowerCase(),
          htmlBackground: htmlStyle.backgroundColor,
          bodyBackground: bodyStyle.backgroundColor,
          bodyBackgroundImage: bodyStyle.backgroundImage,
        },
      };
    },
    {
      checkedSelector: [
        selectors.chapterTitle,
        `${selectors.chapterNavigation} button`,
        `${selectors.transport} button`,
        selectors.seek,
      ].join(", "),
      seekSelector: selectors.seek,
      transcriptSelector: selectors.transcript,
      transcriptBlockSelector: selectors.transcriptBlock,
      transportSelector: selectors.transport,
    },
  );
}

function assertReaderLayout(layout, viewport) {
  assert.equal(layout.bodyWidthFits, true, `body overflowed at ${viewport.width}px`);
  assert.equal(layout.browserChrome.viewportCoversSafeArea, true, "viewport did not cover safe areas");
  assert.equal(
    layout.browserChrome.themeColor,
    layout.browserChrome.expectedThemeColor,
    "browser chrome color did not match the reading surface",
  );
  assert.equal(layout.browserChrome.bodyBackgroundImage, "none", "body used a decorative background image");
  assert.equal(
    layout.browserChrome.bodyBackground,
    layout.browserChrome.htmlBackground,
    "body and page backgrounds did not match",
  );
  assert.notEqual(layout.browserChrome.bodyBackground, "rgb(0, 0, 0)", "reading surface fell back to pure black");
  assert.deepEqual(
    layout.checkedElements.filter((element) => !element.widthFits || !element.heightFits),
    [],
    `text or controls clipped at ${viewport.width}px`,
  );
  assert.equal(
    layout.chapterCurrentKicker.fits,
    true,
    `${layout.chapterCurrentKicker.text} did not fit in the current chapter control at ${viewport.width}px: ${layout.chapterCurrentKicker.scrollWidth}px needed, ${layout.chapterCurrentKicker.clientWidth}px available`,
  );
  assert.deepEqual(layout.overlaps, [], `controls overlapped at ${viewport.width}px`);
  assert.deepEqual(layout.undersizedControls, [], `controls were too small at ${viewport.width}px`);
  assert.equal(layout.seekHitAreaFits, true, `seek hit area was too small at ${viewport.width}px`);
  assert.equal(layout.transcriptArticleCount, 1, `transcript used multiple article elements at ${viewport.width}px`);
  assert.equal(layout.transcriptIsArticle, true, `transcript container was not an article at ${viewport.width}px`);
  assert.equal(layout.transcriptBlocksAreParagraphs, true, `transcript paragraphs used the wrong element at ${viewport.width}px`);
  assert.equal(layout.maxTranscriptBlockGap <= 1, true, `transcript paragraph gap was too large at ${viewport.width}px`);
  assert.equal(layout.transcriptClearsTransport, true, `transport obscured transcript at ${viewport.width}px`);
  assert.equal(
    layout.transportFloatsAboveBrowserChrome,
    true,
    `transport touched the mobile browser chrome at ${viewport.width}px`,
  );
}

async function readChapterPickerLayout() {
  return page.evaluate(({ pickerSelector, resultsSelector }) => {
    const picker = document.querySelector(pickerSelector);
    const panel = picker?.querySelector(".chapter-picker-panel");
    const results = document.querySelector(resultsSelector);
    const pickerRect = picker?.getBoundingClientRect();
    const panelRect = panel?.getBoundingClientRect();
    const resultsRect = results?.getBoundingClientRect();
    const pickerButtons = Array.from(document.querySelectorAll(`${pickerSelector} button`))
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0);
    const chapterOptionHeights = Array.from(document.querySelectorAll(`${pickerSelector} button`))
      .filter((element) => /^chapter-\d+$/.test(element.getAttribute("data-testid") ?? ""))
      .map((element) => element.getBoundingClientRect().height);
    const chapterOptionHeightSpread =
      chapterOptionHeights.length > 0 ? Math.max(...chapterOptionHeights) - Math.min(...chapterOptionHeights) : 0;
    const resultsCanScroll = results
      ? results.scrollHeight > results.clientHeight && getComputedStyle(results).overflowY !== "visible"
      : false;
    const panelFitsViewport =
      Boolean(pickerRect && panelRect) && panelRect.top >= pickerRect.top && panelRect.bottom <= pickerRect.bottom + 1;
    const resultsFitsPanel =
      Boolean(panelRect && resultsRect) && resultsRect.top >= panelRect.top && resultsRect.bottom <= panelRect.bottom + 1;
    return {
      pickerWidthFits: document.documentElement.scrollWidth <= window.innerWidth + 1,
      undersizedPickerButtons: pickerButtons.filter((rect) => rect.width < 44 || rect.height < 44),
      chapterOptionHeightSpread,
      resultsCanScroll,
      panelFitsViewport,
      resultsFitsPanel,
    };
  }, { pickerSelector: selectors.chapterPicker, resultsSelector: selectors.chapterResults });
}

function assertChapterPickerLayout(layout, viewport) {
  assert.equal(layout.pickerWidthFits, true, `chapter picker overflowed at ${viewport.width}px`);
  assert.equal(layout.panelFitsViewport, true, `chapter picker panel overflowed at ${viewport.width}px`);
  assert.equal(layout.resultsFitsPanel, true, `chapter picker results overflowed at ${viewport.width}px`);
  assert.equal(layout.resultsCanScroll, true, `chapter picker results could not scroll at ${viewport.width}px`);
  assert.deepEqual(
    layout.undersizedPickerButtons,
    [],
    `chapter picker controls were too small at ${viewport.width}px`,
  );
  assert.equal(
    layout.chapterOptionHeightSpread <= 1,
    true,
    `chapter picker row heights varied at ${viewport.width}px`,
  );
}

BeforeAll(async () => {
  await runCommand("bun", ["run", "prepare"]);
  server = spawn("bun", ["run", "scripts/site.ts", "dev", "--host", "127.0.0.1", "--port", "4173"], {
    cwd: webRoot,
    env: { ...process.env, FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  await waitForServer();
  browser = await chromium.launch(chromiumLaunchOptions);
});

AfterAll(async () => {
  await browser?.close();
  if (server) {
    server.kill();
  }
});

Before(async () => {
  context = await browser.newContext({ viewport: mobileViewport });
  page = await context.newPage();
  manualScrollY = 0;
  expectedLastAvailableChapter = null;
});

After(async () => {
  await context?.close();
});

Given("the reader is ready to listen", async () => {
  await openReader();
});

Given("download storage has no available space", async () => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: {
        estimate: async () => ({ quota: 1, usage: 1 }),
        persist: async () => true,
      },
    });
  });
});

Given("chapter {int} is ready to listen", async (chapter) => {
  await openChapter(chapter);
});

Given("playback has already started", async () => {
  await makePlaybackActive();
});

Given("listening is positioned at {int} seconds", async (seconds) => {
  await setListeningTime(seconds);
});

Given("the listener previously stopped at {int} seconds in chapter {int}", async (seconds, chapter) => {
  await page.addInitScript(
    ({ key, value }) => {
      localStorage.setItem(key, value);
    },
    { key: `ri:chapter:${chapter}:currentTime`, value: String(seconds) },
  );
});

Given("the chapter has already finished", async () => {
  await finishChapter();
});

Given("chapter {int} is ready offline", async (chapter) => {
  await enableDownloads(1);
  await ensureChapterOffline(chapter);
  await waitForChapterOffline(chapter);
  await closeDownloadSheetIfOpen();
});

When("the listener starts playback", async () => {
  await page.locator(selectors.playToggle).click();
});

When("the listener pauses playback", async () => {
  await page.locator(selectors.playToggle).click();
});

When("playback reaches {int} seconds", async (seconds) => {
  await advancePlaybackTo(seconds);
});

When("playback reaches the first narrative pause", async () => {
  await advancePlaybackTo(await findFirstNarrativePauseTime());
});

When("the listener jumps to {int} seconds", async (seconds) => {
  await page.locator(selectors.seek).evaluate((seek, value) => {
    seek.value = String(value);
    seek.dispatchEvent(new Event("input", { bubbles: true }));
  }, seconds);
});

When("the listener skips backward", async () => {
  await page.locator(selectors.back15).click();
});

When("the listener skips forward", async () => {
  await page.locator(selectors.forward30).click();
});

When("the listener manually reviews another passage", async () => {
  await page.mouse.wheel(0, 520);
  await page.waitForFunction(() => window.scrollY > 120);
  await page.waitForTimeout(150);
  manualScrollY = await page.evaluate(() => window.scrollY);
});

When("the listener returns to chapter {int}", async (chapter) => {
  await openChapter(chapter);
});

When("the chapter finishes", async () => {
  await finishChapter();
});

When("the listener replays the chapter", async () => {
  await page.locator(selectors.playToggle).click();
});

When("the listener moves to the next chapter", async () => {
  await page.locator(selectors.nextChapter).click();
  await waitForReaderReady();
});

When("the listener moves to the previous chapter", async () => {
  await page.locator(selectors.previousChapter).click();
  await waitForReaderReady();
});

When("the listener chooses chapter {int}", async (chapter) => {
  await chooseChapterFromPicker(chapter);
});

When("the listener reviews available chapters", async () => {
  await openChapterPicker();
});

When("the listener searches available chapters for {string}", async (query) => {
  await openChapterPicker();
  await page.locator(selectors.chapterSearch).fill(query);
  await page.locator(`${selectors.chapterResults} button`).first().waitFor();
});

When("the listener searches for the last available chapter", async () => {
  expectedLastAvailableChapter = await lastAvailableChapter();
  await openChapterPicker();
  await page.locator(selectors.chapterSearch).fill(expectedLastAvailableChapter.chapter.id);
  await page.locator(chapterOptionSelector(expectedLastAvailableChapter.chapter.id)).waitFor();
});

When("the listener keeps no upcoming chapters offline", async () => {
  await enableDownloads(0);
});

When("the listener chooses the largest predownload window under slow downloads", async () => {
  await openDownloadSheet();
  await page.locator(selectors.clearDownloads).click();
  await waitForText(selectors.downloadState, "Off");
  await page.evaluate(() => {
    const originalFetch = window.fetch.bind(window);
    window.__riHeldAudioFetches = [];
    window.fetch = (input, init) => {
      const rawUrl = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      const url = new URL(rawUrl, window.location.href);
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      if (/^\/[1-9]\d*-[a-f0-9]{16}\.(webm|m4a)$/.test(url.pathname) && !headers.has("range")) {
        window.__riHeldAudioFetches.push(url.pathname);
        return new Promise(() => undefined);
      }
      return originalFetch(input, init);
    };
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: {
        estimate: async () => ({ quota: 20 * 1024 * 1024 * 1024, usage: 0 }),
        persist: async () => true,
      },
    });
  });
  await openDownloadSheet();
  const largestWindow = await page.locator(selectors.chaptersAhead).evaluate((input) => {
    const max = Number(input.max);
    if (!Number.isFinite(max) || max < 1) {
      throw new Error(`Invalid chapters-ahead slider max: ${input.max}`);
    }
    return max;
  });
  await enableDownloads(largestWindow);
  await page.waitForFunction(() => window.__riHeldAudioFetches.length >= 1);
  await delay(350);
});

When("the network becomes unavailable", async () => {
  await context.route("**/*", (route) => route.abort("internetdisconnected"));
});

When("the listener clears chapter downloads", async () => {
  await openDownloadSheet();
  await page.locator(selectors.clearDownloads).click();
});

Then("chapter {int} can be played in supported browsers", async (chapter) => {
  const readiness = await page.locator(selectors.chapterAudioSources).evaluateAll((elements) =>
    elements.map((element) => ({
      src: element.getAttribute("src"),
      type: element.getAttribute("type"),
    })),
  );
  assert.equal(readiness.length, 2);
  assert.match(readiness[0].src ?? "", new RegExp(`^/${chapter}-[a-f0-9]{16}\\.webm$`));
  assert.equal(readiness[0].type, 'audio/webm; codecs="opus"');
  assert.match(readiness[1].src ?? "", new RegExp(`^/${chapter}-[a-f0-9]{16}\\.m4a$`));
  assert.equal(readiness[1].type, 'audio/mp4; codecs="mp4a.40.2"');
  await expectEnabled(selectors.playToggle);
  await assertPlayButtonLabel("Play chapter");
});

Then("the browser shows chapter {int}", async (chapter) => {
  await page.waitForFunction((expectedPath) => window.location.pathname === expectedPath, `/${chapter}`);
});

Then("the selected chapter is {string}", async (label) => {
  await waitForText(selectors.chapterLabel, label);
});

Then("the chapter title is {string}", async (expectedTitle) => {
  await waitForText(selectors.chapterTitle, expectedTitle);
});

Then("the chapter opens without a manifest fetch", async () => {
  const fetchedJson = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((url) => /\/\d+\.json(?:$|\?)/.test(url)),
  );
  assert.deepEqual(fetchedJson, []);
});

Then("chapter {int} is offered as {string}", async (chapter, expectedTitle) => {
  await waitForChapterOption(chapter, expectedTitle);
});

Then("the last available chapter can be reached", async () => {
  expectedLastAvailableChapter = await lastAvailableChapter();
  await openChapterPicker();
  await page.locator(selectors.chapterResults).evaluate((results) => {
    results.scrollTop = results.scrollHeight;
    results.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  const lastOption = page.locator(chapterOptionSelector(expectedLastAvailableChapter.chapter.id));
  await lastOption.waitFor();
  const lastOptionText = await lastOption.textContent();
  assert.equal(lastOptionText?.includes(`Chapter ${expectedLastAvailableChapter.chapter.id}`), true);
  assert.equal(lastOptionText?.includes(expectedLastAvailableChapter.chapter.title), true);
});

Then("the last available chapter is offered", async () => {
  if (!expectedLastAvailableChapter) {
    expectedLastAvailableChapter = await lastAvailableChapter();
  }
  await waitForChapterOption(
    expectedLastAvailableChapter.chapter.id,
    expectedLastAvailableChapter.chapter.title,
  );
});

Then("the chapter picker keeps a bounded visible window", async () => {
  await closeDownloadSheetIfOpen();
  await openChapterPicker();
  const catalog = await chapterCatalog();
  const pickerState = await readPickerWindowState();
  const maxVisibleControls = Math.ceil(pickerState.resultsHeight / 44) + 20;
  assert.equal(pickerState.renderedChoices > 0, true);
  assert.equal(
    pickerState.renderedChoices <= maxVisibleControls,
    true,
    `rendered ${pickerState.renderedChoices} chapter choices in a ${pickerState.resultsHeight}px picker`,
  );
  assert.equal(pickerState.shortestOption >= 44, true);
  if (pickerState.searchValue.trim()) {
    assert.match(pickerState.countText, new RegExp(`in ${catalog.chapters.length} chapters?`));
  } else {
    assert.match(pickerState.countText, new RegExp(`^${catalog.chapters.length} chapters?$`));
    assert.equal(pickerState.renderedChoices < catalog.chapters.length, true);
  }
});

Then("the transport shows active playback", async () => {
  await waitForPlayState("pause");
  await assertPlayButtonLabel("Pause chapter");
});

Then("playback is paused", async () => {
  await waitForPlayState("play");
  await assertPlayButtonLabel("Play chapter");
});

Then("the transcript follows {string}", async (text) => {
  await page.waitForFunction(({ transcriptBlockSelector, expectedText }) => {
    const activeTranscript = document.querySelector(`${transcriptBlockSelector}.is-active`);
    return activeTranscript?.textContent?.includes(expectedText);
  }, { transcriptBlockSelector: selectors.transcriptBlock, expectedText: text });
});

Then("the transcript follows the narrative pause", async () => {
  await page.waitForFunction((transcriptBlockSelector) => {
    const activeTranscript = document.querySelector(`${transcriptBlockSelector}.is-active`);
    const activeCue = activeTranscript?.querySelector(".cue.is-active");
    return activeTranscript?.textContent?.trim() === "..." && activeCue?.textContent?.trim() === "...";
  }, selectors.transcriptBlock);
});

Then("the followed passage begins near the reading start", async () => {
  await assertFollowedPassageNearReadingStart();
});

Then("the chapter opening begins near the reading start", async () => {
  await assertChapterOpeningNearReadingStart();
});

Then("the listening view remains under the listener's control", async () => {
  await page.waitForTimeout(350);
  const currentScrollY = await page.evaluate(() => window.scrollY);
  assert.equal(Math.abs(currentScrollY - manualScrollY) <= 12, true);
});

Then("listening is positioned at {string}", async (time) => {
  await assertElapsedTime(time);
});

Then("the chapter is shown as complete", async () => {
  await waitForPlayState("replay");
  await assertPlayButtonLabel("Replay chapter");
});

Then("a future visit starts from the beginning", async () => {
  await openChapter(1);
  await assertElapsedTime("0:00");
});

Then("playback restarts from the beginning", async () => {
  await waitForPlayState("pause");
  await assertElapsedTime("0:00");
});

Then("the download queue starts with the default window", async () => {
  await waitForDownloadQueueStarted();
  assert.equal(await page.locator(selectors.chaptersAhead).inputValue(), "4");
  const sliderMax = await page.locator(selectors.chaptersAhead).evaluate((input) => Number(input.max));
  const expectedMax = await page.evaluate(() => {
    const dataElement = document.querySelector("#ri-chapter-data");
    if (!dataElement?.textContent) {
      throw new Error("Missing chapter data");
    }
    const chapterData = JSON.parse(dataElement.textContent);
    return chapterData.totalChapters - chapterData.orderIndex - 1;
  });
  assert.equal(sliderMax, expectedMax);
  const selectedSize = await page.locator(selectors.selectedWindowSize).textContent();
  assert.notEqual(selectedSize, "Not calculated");
});

Then("no chapter audio is selected for offline listening", async () => {
  await page.waitForFunction(
    ({ selectedSizeSelector, cachedSizeSelector }) =>
      document.querySelector(selectedSizeSelector)?.textContent === "0 B" &&
      document.querySelector(cachedSizeSelector)?.textContent === "0 B",
    {
      selectedSizeSelector: selectors.selectedWindowSize,
      cachedSizeSelector: selectors.cachedSize,
    },
  );
});

Then("the predownload work starts in a bounded queue", async () => {
  const heldFetches = await page.evaluate(() => window.__riHeldAudioFetches.length);
  assert.equal(heldFetches > 0, true);
  assert.equal(heldFetches <= 2, true, `started ${heldFetches} audio downloads immediately`);
  const visibleState = await page.locator(selectors.downloadState).textContent();
  assert.equal(visibleState, "Downloading");
});

Then("the download queue reports insufficient storage", async () => {
  await waitForText(selectors.downloadState, "Error");
  const error = await page.locator(selectors.downloadError).textContent();
  assert.match(error ?? "", /Insufficient storage/);
});

Then("cached audio for chapter {int} supports partial playback", async (chapter) => {
  const result = await page.evaluate(async (chapterId) => {
    const sourceUrl = window.__riReadyOfflineUrls?.[String(chapterId)];
    if (!sourceUrl) {
      throw new Error(`chapter ${chapterId} has no cached audio URL`);
    }
    const response = await fetch(sourceUrl, {
      headers: {
        Range: "bytes=0-1023",
      },
    });
    const body = await response.arrayBuffer();
    return {
      status: response.status,
      contentRange: response.headers.get("Content-Range"),
      acceptRanges: response.headers.get("Accept-Ranges"),
      bytes: body.byteLength,
    };
  }, chapter);
  assert.equal(result.status, 206);
  assert.match(result.contentRange ?? "", /^bytes 0-1023\/\d+$/);
  assert.equal(result.acceptRanges, "bytes");
  assert.equal(result.bytes, 1024);
});

Then("downloaded chapter audio is removed", async () => {
  const chapterTwoUrl = await preferredAudioUrlFor(2);
  await page.waitForFunction(
    async ({ url, cacheName, dbName }) => {
      const cache = await caches.open(cacheName);
      const cached = await cache.match(url);
      const dbRequest = indexedDB.open(dbName, 1);
      const db = await new Promise((resolveDb, rejectDb) => {
        dbRequest.addEventListener("success", () => resolveDb(dbRequest.result));
        dbRequest.addEventListener("error", () => rejectDb(dbRequest.error));
      });
      const transaction = db.transaction("assets", "readonly");
      const recordsRequest = transaction.objectStore("assets").getAll();
      const records = await new Promise((resolveRecords, rejectRecords) => {
        recordsRequest.addEventListener("success", () => resolveRecords(recordsRequest.result));
        recordsRequest.addEventListener("error", () => rejectRecords(recordsRequest.error));
      });
      db.close();
      return !cached && records.length === 0;
    },
    { url: chapterTwoUrl, cacheName: downloadCacheName, dbName: downloadDbName },
  );
});

Then("chapter predownloads are available in supported browser engines", async () => {
  const engines = [
    ["Chromium", chromium],
    ["Firefox", firefox],
    ["WebKit", webkit],
  ];
  for (const [name, browserType] of engines) {
    const engineBrowser = await browserType.launch(name === "Chromium" ? chromiumLaunchOptions : { headless: true });
    const engineContext = await engineBrowser.newContext({ viewport: mobileViewport });
    const enginePage = await engineContext.newPage();
    try {
      await enginePage.goto(`${baseUrl}/1`);
      await waitForReaderReady(enginePage);
      await enableDownloads(1, enginePage);
      await waitForDownloadsActive(enginePage, { timeout: 10_000 }).catch(async (error) => {
        const state = await enginePage.locator(selectors.downloadState).textContent();
        const message = await enginePage.locator(selectors.downloadError).textContent();
        throw new Error(`${error instanceof Error ? error.message : String(error)}; state=${state}; error=${message}`);
      });
    } catch (error) {
      throw new Error(`${name} predownload check failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await engineContext.close();
      await engineBrowser.close();
    }
  }
});

Then("the listening interface fits common screens", async () => {
  await openChapter(1);
  const layoutChapter = await lastAvailableChapter();
  for (const viewport of layoutViewports) {
    await page.setViewportSize(viewport);
    await openChapter(layoutChapter.chapter.id);
    assertReaderLayout(await readReaderLayout(), viewport);

    await openChapterPicker();
    assertChapterPickerLayout(await readChapterPickerLayout(), viewport);
    await page.keyboard.press("Escape");
  }
});
