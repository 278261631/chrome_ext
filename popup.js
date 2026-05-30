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

function getPageDetails() {
  const description = document.querySelector('meta[name="description"]')?.content || "";

  return {
    title: document.title,
    url: location.href,
    language: document.documentElement.lang || navigator.language || "",
    charset: document.characterSet || "",
    description,
    linkCount: document.links.length,
    imageCount: document.images.length
  };
}

function setStatus(message) {
  statusEl.textContent = message;
  statusEl.hidden = false;
  contentEl.hidden = true;
}

function setText(element, value) {
  element.textContent = value || "未提供";
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function loadPageInfo() {
  setStatus("正在读取页面信息...");

  try {
    const tab = await getActiveTab();

    if (!tab?.id || !tab.url) {
      throw new Error("无法读取当前标签页。");
    }

    const url = new URL(tab.url);
    let pageDetails = {
      title: tab.title || "",
      url: tab.url,
      language: "",
      charset: "",
      description: "",
      linkCount: 0,
      imageCount: 0
    };

    if (url.protocol === "http:" || url.protocol === "https:") {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: getPageDetails
      });

      pageDetails = { ...pageDetails, ...result };
    }

    setText(fields.pageTitle, pageDetails.title);
    setText(fields.pageUrl, pageDetails.url);
    setText(fields.hostname, url.hostname);
    setText(fields.protocol, url.protocol.replace(":", ""));
    setText(fields.pathname, url.pathname || "/");
    setText(fields.language, pageDetails.language);
    setText(fields.charset, pageDetails.charset);
    setText(fields.description, pageDetails.description);
    setText(fields.linkCount, String(pageDetails.linkCount));
    setText(fields.imageCount, String(pageDetails.imageCount));

    statusEl.hidden = true;
    contentEl.hidden = false;
  } catch (error) {
    setStatus(error.message || "读取失败，请刷新后重试。");
  }
}

refreshButton.addEventListener("click", loadPageInfo);

loadPageInfo();
