const fields = {
  pageTitle: document.querySelector("#pageTitle"),
  pageUrl: document.querySelector("#pageUrl"),
  hostname: document.querySelector("#hostname"),
  protocol: document.querySelector("#protocol"),
  pathname: document.querySelector("#pathname"),
  language: document.querySelector("#language"),
  charset: document.querySelector("#charset"),
  description: document.querySelector("#description"),
  linkCount: document.querySelector("#linkCount"),
  imageCount: document.querySelector("#imageCount")
};

const statusEl = document.querySelector("#status");
const contentEl = document.querySelector("#content");
const refreshButton = document.querySelector("#refreshButton");
const detectNowButton = document.querySelector("#detectNowButton");
const cacheButton = document.querySelector("#cacheButton");
const videoCountEl = document.querySelector("#videoCount");
const videoListEl = document.querySelector("#videoList");
const cacheInfoEl = document.querySelector("#cacheInfo");
const debugLogEl = document.querySelector("#debugLog");
const videoItemTemplate = document.querySelector("#videoItemTemplate");

let currentSnapshot = null;

function addDebug(logs, message, data = "") {
  const detail = typeof data === "string" ? data : JSON.stringify(data);
  logs.push(detail ? `${message}: ${detail}` : message);
}

function toAbsoluteUrl(value) {
  if (!value) {
    return "";
  }

  try {
    return new URL(value, location.href).href;
  } catch {
    return "";
  }
}

function getVideoLabel(element, fallback) {
  return (
    element.getAttribute("title") ||
    element.getAttribute("aria-label") ||
    element.getAttribute("data-title") ||
    fallback
  );
}

function uniqueVideos(videos) {
  const seen = new Set();

  return videos.filter((video) => {
    const key = video.url;

    if (!video.url || seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function getOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function classifyMedia(video) {
  const url = video.url || "";
  const type = video.type || "";

  if (url.startsWith("blob:")) {
    return "blob";
  }

  if (/\.m3u8(?:[?#]|$)/i.test(url) || /mpegurl/i.test(type)) {
    return "hls";
  }

  if (/\.mpd(?:[?#]|$)/i.test(url) || /dash\+xml/i.test(type)) {
    return "dash";
  }

  if (/\.(m4s|ts)(?:[?#]|$)/i.test(url)) {
    return "segment";
  }

  return "direct";
}

function getMediaScore(video) {
  const kind = classifyMedia(video);
  const source = video.source || "";
  let score = 0;

  if (kind === "hls") {
    score += 1000;
  } else if (kind === "dash") {
    score += 900;
  } else if (kind === "direct") {
    score += 700;
  } else if (kind === "segment") {
    score += 250;
  }

  if (/player config|__playinfo__/i.test(source)) {
    score += 120;
  }

  if (/network/i.test(source)) {
    score += 80;
  }

  if (/performance/i.test(source)) {
    score += 20;
  }

  if (/\.(mp4|m4v|webm)(?:[?#]|$)/i.test(video.url || "")) {
    score += 150;
  }

  return score;
}

function getSegmentGroupKey(video) {
  try {
    const url = new URL(video.url);
    const directory = url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1);
    const extension = url.pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() || "segment";
    return `${url.origin}${directory}|${extension}`;
  } catch {
    return video.url;
  }
}

function collapseSegmentGroups(videos, logs) {
  const preferred = [];
  const segmentGroups = new Map();

  videos.forEach((video) => {
    if (classifyMedia(video) !== "segment") {
      preferred.push(video);
      return;
    }

    const key = getSegmentGroupKey(video);
    const group = segmentGroups.get(key) || [];
    group.push(video);
    segmentGroups.set(key, group);
  });

  const collapsedSegments = [...segmentGroups.values()].map((group, index) => {
    const sorted = [...group].sort((a, b) => getMediaScore(b) - getMediaScore(a));
    const first = sorted[0];

    return {
      ...first,
      label: `Segment group ${index + 1}`,
      source: `${first.source || "segment"} grouped`,
      segmentCount: group.length,
      isGroupedSegment: true
    };
  });

  if (segmentGroups.size > 0) {
    addDebug(logs, "segment groups collapsed", {
      groups: segmentGroups.size,
      segments: videos.length - preferred.length
    });
  }

  return [...preferred, ...collapsedSegments];
}

function prepareDisplayVideos(videos, logs) {
  const blobCount = videos.filter((video) => classifyMedia(video) === "blob").length;
  const nonBlob = videos.filter((video) => classifyMedia(video) !== "blob");
  const hasPlayableEntry = nonBlob.some((video) => ["hls", "dash", "direct"].includes(classifyMedia(video)));
  const collapsed = hasPlayableEntry
    ? nonBlob.filter((video) => classifyMedia(video) !== "segment")
    : collapseSegmentGroups(nonBlob, logs);
  const sorted = [...collapsed].sort((a, b) => getMediaScore(b) - getMediaScore(a));
  const visible = sorted.slice(0, 12);

  if (blobCount > 0) {
    addDebug(logs, "blob urls hidden from download list", blobCount);
  }

  addDebug(logs, "display videos after ranking", {
    total: sorted.length,
    visible: visible.length
  });

  return visible.map((video, index) => ({
    ...video,
    isRecommended: index === 0
  }));
}

function shellQuote(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

function getHeaderText(video) {
  const referer = video.pageUrl || currentSnapshot?.url || "";
  const origin = video.pageOrigin || getOrigin(referer);
  const headers = [];

  if (referer) {
    headers.push(`Referer: ${referer}`);
  }

  if (origin) {
    headers.push(`Origin: ${origin}`);
  }

  headers.push("User-Agent: Mozilla/5.0");
  return headers.join("\\r\\n");
}

function getFfmpegCommand(video, index) {
  const outputName = getDownloadName(video, index).replace(/\.[^.]+$/, ".mp4");
  const kind = classifyMedia(video);

  if (video.isGroupedSegment || kind === "segment") {
    return [
      "# This is a media segment, not a full playlist. Play the video longer and look for an m3u8/mpd entry, or merge all related segments manually.",
      "ffmpeg",
      "-headers",
      shellQuote(`${getHeaderText(video)}\\r\\n`),
      "-i",
      shellQuote(video.url),
      "-c",
      "copy",
      shellQuote(outputName)
    ].join(" ");
  }

  return [
    "ffmpeg",
    "-headers",
    shellQuote(`${getHeaderText(video)}\\r\\n`),
    "-i",
    shellQuote(video.url),
    "-c",
    "copy",
    shellQuote(outputName)
  ].join(" ");
}

function getPageDetails() {
  function pageToAbsoluteUrl(value) {
    if (!value) {
      return "";
    }

    try {
      return new URL(value, location.href).href;
    } catch {
      return "";
    }
  }

  function pageGetVideoLabel(element, fallback) {
    return (
      element.getAttribute("title") ||
      element.getAttribute("aria-label") ||
      element.getAttribute("data-title") ||
      fallback
    );
  }

  function pageUniqueVideos(videos) {
    const seen = new Set();

    return videos.filter((video) => {
      if (!video.url || seen.has(video.url)) {
        return false;
      }

      seen.add(video.url);
      return true;
    });
  }

  function pageAddDebug(logs, message, data = "") {
    const detail = typeof data === "string" ? data : JSON.stringify(data);
    logs.push(detail ? `${message}: ${detail}` : message);
  }

  function pageCollectConfigUrls(value, logs, results, path = "root", depth = 0) {
    if (!value || depth > 8) {
      return;
    }

    if (typeof value === "string") {
      if (mediaUrlPattern.test(value)) {
        results.push({ url: pageToAbsoluteUrl(value), path });
      }
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => pageCollectConfigUrls(item, logs, results, `${path}[${index}]`, depth + 1));
      return;
    }

    if (typeof value !== "object") {
      return;
    }

    Object.entries(value).forEach(([key, item]) => {
      if (/^(base_?url|backup_?url|url)$/i.test(key)) {
        pageCollectConfigUrls(item, logs, results, `${path}.${key}`, depth + 1);
        return;
      }

      if (/^(dash|video|audio|data|result|stream|accept|codec)$/i.test(key)) {
        pageCollectConfigUrls(item, logs, results, `${path}.${key}`, depth + 1);
      }
    });
  }

  const description = document.querySelector('meta[name="description"]')?.content || "";
  const videos = [];
  const debugLogs = [];
  const pageUrl = location.href;
  const pageOrigin = location.origin;
  const mediaUrlPattern = /\.(mp4|m4v|webm|ogg|ogv|mov|m3u8|mpd|ts|m4s)(?:[?#]|$)/i;

  const videoElements = document.querySelectorAll("video");
  const sourceElements = document.querySelectorAll("source");
  pageAddDebug(debugLogs, "DOM video elements", videoElements.length);
  pageAddDebug(debugLogs, "DOM source elements", sourceElements.length);

  videoElements.forEach((video, index) => {
    const fallback = `Video ${index + 1}`;
    const currentSource = pageToAbsoluteUrl(video.currentSrc || video.src);

    if (currentSource) {
      pageAddDebug(debugLogs, "video.currentSrc/src candidate", currentSource);
      videos.push({
        label: pageGetVideoLabel(video, fallback),
        url: currentSource,
        source: "video",
        type: video.getAttribute("type") || "",
        pageUrl,
        pageOrigin,
        duration: Number.isFinite(video.duration) ? Math.round(video.duration) : null,
        width: video.videoWidth || null,
        height: video.videoHeight || null
      });
    }

    video.querySelectorAll("source").forEach((source, sourceIndex) => {
      const sourceUrl = pageToAbsoluteUrl(source.src);
      pageAddDebug(debugLogs, "video source candidate", sourceUrl || "empty source");
      videos.push({
        label: `${pageGetVideoLabel(video, fallback)} source ${sourceIndex + 1}`,
        url: sourceUrl,
        source: "source",
        type: source.type || "",
        pageUrl,
        pageOrigin,
        duration: Number.isFinite(video.duration) ? Math.round(video.duration) : null,
        width: video.videoWidth || null,
        height: video.videoHeight || null
      });
    });
  });

  let matchedLinks = 0;
  document.querySelectorAll("a[href]").forEach((link) => {
    const href = pageToAbsoluteUrl(link.href);

    if (mediaUrlPattern.test(href)) {
      matchedLinks += 1;
      videos.push({
        label: link.textContent.trim() || "Video link",
        url: href,
        source: "link",
        type: href.split(".").pop().split(/[?#]/)[0].toLowerCase(),
        pageUrl,
        pageOrigin,
        duration: null,
        width: null,
        height: null
      });
    }
  });
  pageAddDebug(debugLogs, "matching video links", matchedLinks);

  const configUrls = [];
  pageCollectConfigUrls(window.__playinfo__, debugLogs, configUrls, "window.__playinfo__");
  pageAddDebug(debugLogs, "player config media urls", configUrls.length);
  configUrls.forEach((item, index) => {
    videos.push({
      label: `Player config ${index + 1}`,
      url: item.url,
      source: item.path,
      type: item.url.split(".").pop().split(/[?#]/)[0].toLowerCase(),
      pageUrl,
      pageOrigin,
      duration: null,
      width: null,
      height: null
    });
  });

  let matchedResources = 0;
  performance.getEntriesByType("resource").forEach((entry) => {
    if (!mediaUrlPattern.test(entry.name) && !["video", "audio", "fetch", "xmlhttprequest"].includes(entry.initiatorType)) {
      return;
    }

    if (!mediaUrlPattern.test(entry.name)) {
      pageAddDebug(debugLogs, "performance resource skipped without media extension", {
        name: entry.name,
        initiatorType: entry.initiatorType
      });
      return;
    }

    matchedResources += 1;
    videos.push({
      label: "Performance resource",
      url: entry.name,
      source: `performance:${entry.initiatorType || "resource"}`,
      type: entry.name.split(".").pop().split(/[?#]/)[0].toLowerCase(),
      pageUrl,
      pageOrigin,
      duration: null,
      width: null,
      height: null
    });
  });
  pageAddDebug(debugLogs, "matching performance resources", matchedResources);

  return {
    title: document.title,
    url: location.href,
    language: document.documentElement.lang || navigator.language || "",
    charset: document.characterSet || "",
    description,
    linkCount: document.links.length,
    imageCount: document.images.length,
    videos: pageUniqueVideos(videos),
    debugLogs
  };
}

function setStatus(message) {
  statusEl.textContent = message;
  statusEl.hidden = false;
  contentEl.hidden = true;
}

function setText(element, value) {
  element.textContent = value || "Not provided";
}

function formatDuration(seconds) {
  if (!seconds) {
    return "";
  }

  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function getDownloadName(video, index) {
  const extensionMatch = video.url.match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i);
  const extension = extensionMatch?.[1] || "mp4";
  const baseName = (video.label || `video-${index + 1}`)
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

  return `${baseName || `video-${index + 1}`}.${extension}`;
}

async function downloadVideo(video, index) {
  const referer = video.pageUrl || currentSnapshot?.url || "";
  const origin = video.pageOrigin || getOrigin(referer);
  const headers = [];

  if (referer) {
    headers.push({ name: "Referer", value: referer });
  }

  if (origin) {
    headers.push({ name: "Origin", value: origin });
  }

  await chrome.downloads.download({
    url: video.url,
    filename: getDownloadName(video, index),
    headers,
    saveAs: true
  });
}

async function fetchDownloadVideo(video, index) {
  const response = await fetch(video.url, {
    credentials: "include",
    referrer: video.pageUrl || currentSnapshot?.url || "",
    referrerPolicy: "no-referrer-when-downgrade"
  });

  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);

  try {
    await chrome.downloads.download({
      url: objectUrl,
      filename: getDownloadName(video, index),
      saveAs: true
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
  }
}

function normalizeFilename(value) {
  return String(value)
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

async function openHlsDownloader(video, index) {
  const taskId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const label = normalizeFilename(video.label || `hls-video-${index + 1}`) || `hls-video-${index + 1}`;

  await chrome.storage.local.set({
    [`downloadTask:${taskId}`]: {
      ...video,
      label
    }
  });

  await chrome.tabs.create({
    url: chrome.runtime.getURL(`downloader.html?task=${encodeURIComponent(taskId)}`)
  });
}

async function copyText(value) {
  await navigator.clipboard.writeText(value);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function getNetworkVideos(tabId, debugLogs) {
  let response = null;

  try {
    response = await chrome.runtime.sendMessage({
      type: "get-media-requests",
      tabId
    });
  } catch (error) {
    addDebug(debugLogs, "network detector unavailable", error.message);
    return [];
  }

  if (response?.error) {
    addDebug(debugLogs, "network detector error", response.error);
  }

  const requests = response?.requests || [];
  addDebug(debugLogs, "network candidates", requests.length);

  return requests.map((request, index) => ({
    label: `Network media ${index + 1}`,
    url: request.url,
    source: request.source || "network",
    type: request.type || "",
    pageUrl: request.initiator || currentSnapshot?.url || "",
    pageOrigin: getOrigin(request.initiator || currentSnapshot?.url || ""),
    duration: null,
    width: null,
    height: null,
    detectedBy: request.detectedBy,
    time: request.time
  }));
}

async function readCache(pageUrl) {
  const { videoInfoCache = {} } = await chrome.storage.local.get("videoInfoCache");
  return videoInfoCache[pageUrl] || null;
}

async function writeCache(snapshot) {
  const { videoInfoCache = {} } = await chrome.storage.local.get("videoInfoCache");
  videoInfoCache[snapshot.url] = {
    ...snapshot,
    cachedAt: new Date().toISOString()
  };

  await chrome.storage.local.set({ videoInfoCache });
}

function renderVideos(videos) {
  videoListEl.textContent = "";
  videoCountEl.textContent = String(videos.length);
  cacheButton.disabled = videos.length === 0;

  if (videos.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No video sources were detected on this page.";
    videoListEl.append(empty);
    return;
  }

  videos.forEach((video, index) => {
    const item = videoItemTemplate.content.firstElementChild.cloneNode(true);
    if (video.isRecommended) {
      item.classList.add("is-recommended");
    }
    const title = item.querySelector("h3");
    const url = item.querySelector(".video-url");
    const detail = item.querySelector(".video-detail");
    const openLink = item.querySelector(".open-link");
    const downloadButton = item.querySelector(".download-button");
    const fetchButton = item.querySelector(".fetch-button");
    const copyCommandButton = item.querySelector(".copy-command-button");
    const size = video.width && video.height ? `${video.width}x${video.height}` : "";
    const duration = formatDuration(video.duration);
    const isSegment = /\.(m4s|ts)(?:[?#]|$)/i.test(video.url);
    const mediaKind = classifyMedia(video);

    title.textContent = `${video.isRecommended ? "Recommended - " : ""}${video.label || `Video ${index + 1}`}`;
    url.textContent = video.url;
    detail.textContent = [
      mediaKind,
      video.source,
      video.segmentCount ? `${video.segmentCount} segments` : "",
      video.type,
      size,
      duration,
      isSegment ? "segmented stream" : ""
    ].filter(Boolean).join(" | ");
    openLink.href = video.url;
    fetchButton.textContent = mediaKind === "hls" ? "HLS" : "Fetch";
    fetchButton.disabled = video.isGroupedSegment;
    downloadButton.disabled = video.isGroupedSegment;
    downloadButton.addEventListener("click", async () => {
      if (video.isGroupedSegment) {
        return;
      }

      downloadButton.disabled = true;
      downloadButton.textContent = "Downloading";

      try {
        await downloadVideo(video, index);
        downloadButton.textContent = "Download";
      } catch (error) {
        if (currentSnapshot?.debugLogs) {
          addDebug(currentSnapshot.debugLogs, "download failed", {
            url: video.url,
            error: error.message,
            referer: video.pageUrl || currentSnapshot.url
          });
          renderDebugLogs(currentSnapshot.debugLogs);
        }
        downloadButton.textContent = "Failed";
      } finally {
        downloadButton.disabled = false;
      }
    });
    fetchButton.addEventListener("click", async () => {
      if (video.isGroupedSegment) {
        return;
      }

      fetchButton.disabled = true;
      fetchButton.textContent = "Fetching";

      try {
        if (mediaKind === "hls") {
          await openHlsDownloader(video, index);
        } else {
          await fetchDownloadVideo(video, index);
        }
        fetchButton.textContent = mediaKind === "hls" ? "HLS" : "Fetch";
      } catch (error) {
        if (currentSnapshot?.debugLogs) {
          addDebug(currentSnapshot.debugLogs, "fetch download failed", {
            url: video.url,
            error: error.message,
            referrer: video.pageUrl || currentSnapshot.url
          });
          renderDebugLogs(currentSnapshot.debugLogs);
        }
          fetchButton.textContent = "Failed";
      } finally {
        fetchButton.disabled = false;
      }
    });
    copyCommandButton.addEventListener("click", async () => {
      copyCommandButton.disabled = true;

      try {
        await copyText(getFfmpegCommand(video, index));
        copyCommandButton.textContent = "Copied";
      } catch (error) {
        if (currentSnapshot?.debugLogs) {
          addDebug(currentSnapshot.debugLogs, "copy command failed", error.message);
          renderDebugLogs(currentSnapshot.debugLogs);
        }
        copyCommandButton.textContent = "Failed";
      } finally {
        setTimeout(() => {
          copyCommandButton.textContent = "Cmd";
          copyCommandButton.disabled = false;
        }, 1200);
      }
    });
    videoListEl.append(item);
  });
}

function renderDebugLogs(logs) {
  debugLogEl.textContent = "";

  if (!logs?.length) {
    const item = document.createElement("li");
    item.textContent = "No debug logs for this run.";
    debugLogEl.append(item);
    return;
  }

  logs.forEach((log) => {
    const item = document.createElement("li");
    item.textContent = log;
    debugLogEl.append(item);
  });
}

function renderSnapshot(snapshot, url) {
  setText(fields.pageTitle, snapshot.title);
  setText(fields.pageUrl, snapshot.url);
  setText(fields.hostname, url.hostname);
  setText(fields.protocol, url.protocol.replace(":", ""));
  setText(fields.pathname, url.pathname || "/");
  setText(fields.language, snapshot.language);
  setText(fields.charset, snapshot.charset);
  setText(fields.description, snapshot.description);
  setText(fields.linkCount, String(snapshot.linkCount));
  setText(fields.imageCount, String(snapshot.imageCount));
  renderVideos(snapshot.videos || []);
  renderDebugLogs(snapshot.debugLogs || []);

  statusEl.hidden = true;
  contentEl.hidden = false;
}

async function loadPageInfo() {
  setStatus("Loading page information...");

  try {
    const tab = await getActiveTab();

    if (!tab?.id || !tab.url) {
      throw new Error("Unable to read the current tab.");
    }

    const url = new URL(tab.url);
    let pageDetails = {
      title: tab.title || "",
      url: tab.url,
      language: "",
      charset: "",
      description: "",
      linkCount: 0,
      imageCount: 0,
      videos: [],
      debugLogs: []
    };

    if (url.protocol === "http:" || url.protocol === "https:") {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: getPageDetails
      });

      pageDetails = { ...pageDetails, ...result };
    }

    const debugLogs = pageDetails.debugLogs || [];
    const networkVideos = await getNetworkVideos(tab.id, debugLogs);
    pageDetails.videos = uniqueVideos([...(pageDetails.videos || []), ...networkVideos]);
    pageDetails.debugLogs = debugLogs;
    if (pageDetails.videos.some((video) => /\.m4s(?:[?#]|$)/i.test(video.url))) {
      addDebug(
        pageDetails.debugLogs,
        "m4s note",
        "m4s is usually a segmented stream. Sites such as Bilibili often separate video/audio and require valid Referer/cookies."
      );
    }
    addDebug(pageDetails.debugLogs, "raw unique videos", pageDetails.videos.length);
    pageDetails.rawVideos = pageDetails.videos;
    pageDetails.videos = prepareDisplayVideos(pageDetails.rawVideos, pageDetails.debugLogs);
    addDebug(pageDetails.debugLogs, "recommended video", pageDetails.videos[0]?.url || "none");

    currentSnapshot = pageDetails;
    const cached = await readCache(pageDetails.url);
    cacheInfoEl.textContent = cached?.cachedAt
      ? `Cached: ${new Date(cached.cachedAt).toLocaleString()}`
      : "";

    renderSnapshot(pageDetails, url);
  } catch (error) {
    setStatus(error.message || "Failed to read this page. Please try again.");
  }
}

refreshButton.addEventListener("click", loadPageInfo);
detectNowButton.addEventListener("click", loadPageInfo);
cacheButton.addEventListener("click", async () => {
  if (!currentSnapshot) {
    return;
  }

  await writeCache(currentSnapshot);
  cacheInfoEl.textContent = `Cached: ${new Date().toLocaleString()}`;
});

loadPageInfo();
