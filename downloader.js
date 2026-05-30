const titleEl = document.querySelector("#title");
const sourceUrlEl = document.querySelector("#sourceUrl");
const progressBarEl = document.querySelector("#progressBar");
const statusTextEl = document.querySelector("#statusText");
const logListEl = document.querySelector("#logList");

function addLog(message) {
  const item = document.createElement("li");
  item.textContent = message;
  logListEl.append(item);
}

function setProgress(done, total) {
  const percent = total ? Math.round((done / total) * 100) : 0;
  progressBarEl.style.width = `${percent}%`;
  statusTextEl.textContent = total ? `${done}/${total} segments (${percent}%)` : "Preparing segments...";
}

function getTaskId() {
  return new URL(location.href).searchParams.get("task");
}

function resolveUrl(value, baseUrl) {
  return new URL(value, baseUrl).href;
}

async function fetchText(url, task) {
  const response = await fetch(url, {
    credentials: "include",
    referrer: task.pageUrl || "",
    referrerPolicy: "no-referrer-when-downgrade"
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch manifest: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

function parsePlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const variants = [];
  const segments = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (line.startsWith("#EXT-X-KEY")) {
      throw new Error("Encrypted HLS is not supported by this basic downloader.");
    }

    if (line.startsWith("#EXT-X-STREAM-INF")) {
      const next = lines[index + 1];

      if (next && !next.startsWith("#")) {
        variants.push(resolveUrl(next, baseUrl));
      }
      continue;
    }

    if (!line.startsWith("#")) {
      segments.push(resolveUrl(line, baseUrl));
    }
  }

  return { variants, segments };
}

async function fetchSegment(url, task) {
  const response = await fetch(url, {
    credentials: "include",
    referrer: task.pageUrl || "",
    referrerPolicy: "no-referrer-when-downgrade"
  });

  if (!response.ok) {
    throw new Error(`Segment failed: ${response.status} ${response.statusText}`);
  }

  return response.blob();
}

async function saveBlob(blob, filename) {
  const objectUrl = URL.createObjectURL(blob);

  try {
    await chrome.downloads.download({
      url: objectUrl,
      filename,
      saveAs: true
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
  }
}

async function run() {
  const taskId = getTaskId();

  if (!taskId) {
    throw new Error("Missing download task id.");
  }

  const key = `downloadTask:${taskId}`;
  const data = await chrome.storage.local.get(key);
  const task = data[key];

  if (!task?.url) {
    throw new Error("Download task was not found.");
  }

  titleEl.textContent = task.label || "HLS Download";
  sourceUrlEl.textContent = task.url;
  addLog(`Manifest: ${task.url}`);

  let playlistUrl = task.url;
  let playlist = parsePlaylist(await fetchText(playlistUrl, task), playlistUrl);

  if (playlist.variants.length > 0) {
    playlistUrl = playlist.variants[playlist.variants.length - 1];
    addLog(`Variant selected: ${playlistUrl}`);
    playlist = parsePlaylist(await fetchText(playlistUrl, task), playlistUrl);
  }

  if (playlist.segments.length === 0) {
    throw new Error("No HLS segments found.");
  }

  addLog(`Segments: ${playlist.segments.length}`);
  const blobs = [];

  for (let index = 0; index < playlist.segments.length; index += 1) {
    blobs.push(await fetchSegment(playlist.segments[index], task));
    setProgress(index + 1, playlist.segments.length);
  }

  const output = new Blob(blobs, { type: "video/mp2t" });
  await saveBlob(output, `${task.label || "hls-video"}.ts`);
  statusTextEl.textContent = "Finished. Save dialog opened.";
  addLog("Finished.");
}

run().catch((error) => {
  titleEl.textContent = "Download failed";
  statusTextEl.textContent = error.message;
  addLog(error.stack || error.message);
});
