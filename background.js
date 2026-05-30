const MEDIA_URL_PATTERN = /\.(mp4|m4v|webm|ogg|ogv|mov|m3u8|mpd|ts|m4s)(?:[?#]|$)/i;
const MEDIA_CONTENT_TYPES = [
  "video/",
  "audio/",
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "application/dash+xml",
  "application/mp4",
  "application/octet-stream"
];
const STORAGE_KEY = "recentMediaRequests";
const MAX_REQUESTS_PER_TAB = 80;

function now() {
  return new Date().toISOString();
}

function getExtension(url) {
  return url.match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i)?.[1]?.toLowerCase() || "";
}

function isMediaContentType(contentType) {
  const normalized = contentType.toLowerCase();
  return MEDIA_CONTENT_TYPES
    .filter((type) => type !== "application/octet-stream")
    .some((type) => normalized.includes(type));
}

function getHeader(headers, name) {
  return headers?.find((header) => header.name.toLowerCase() === name)?.value || "";
}

async function readRequests() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] || {};
}

async function writeRequests(requests) {
  await chrome.storage.local.set({ [STORAGE_KEY]: requests });
}

async function recordRequest(tabId, request) {
  if (tabId < 0 || !request.url) {
    return;
  }

  const requests = await readRequests();
  const tabKey = String(tabId);
  const existing = requests[tabKey] || [];
  const next = [
    request,
    ...existing.filter((item) => item.url !== request.url)
  ].slice(0, MAX_REQUESTS_PER_TAB);

  requests[tabKey] = next;
  await writeRequests(requests);
  console.debug("[Page Info Viewer] media candidate", request);
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!MEDIA_URL_PATTERN.test(details.url)) {
      return;
    }

    recordRequest(details.tabId, {
      url: details.url,
      method: details.method,
      source: `network:${details.type}`,
      type: getExtension(details.url),
      detectedBy: "url",
      initiator: details.initiator || "",
      time: now()
    });
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] }
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const contentType = getHeader(details.responseHeaders, "content-type");

    const looksLikeMediaUrl = MEDIA_URL_PATTERN.test(details.url);
    const isOctetStream = contentType.toLowerCase().includes("application/octet-stream");

    if (!contentType || (!isMediaContentType(contentType) && !(isOctetStream && looksLikeMediaUrl))) {
      return;
    }

    recordRequest(details.tabId, {
      url: details.url,
      method: details.method,
      source: `network:${details.type}`,
      type: contentType.split(";")[0],
      detectedBy: "content-type",
      initiator: details.initiator || "",
      time: now()
    });
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] },
  ["responseHeaders"]
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "get-media-requests") {
    return false;
  }

  readRequests()
    .then((requests) => {
      sendResponse({ requests: requests[String(message.tabId)] || [] });
    })
    .catch((error) => {
      sendResponse({ requests: [], error: error.message });
    });

  return true;
});
