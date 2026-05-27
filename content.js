// Content script for NotebookLM Prompt Queue.
// Drives the CHAT panel only — explicitly avoids Sources/Discover inputs.

const CHAT_PATTERNS = [
  "ask a question",
  "create something",
  "ask anything",
  "message notebooklm",
  "type a message",
  "chat"
];

const EXCLUDED_PATTERNS = [
  "discover",
  "search",
  "find sources",
  "web",
  "reference",
  "provide all"
];

let isRunning = false;
let shouldStop = false;
let config = { delayMs: 3000, maxWaitMs: 600000 };

// ---------- DOM helpers ----------

function isVisible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = window.getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
}

function getLabelText(el) {
  if (!el) return "";
  const parts = [
    el.getAttribute("placeholder") || "",
    el.getAttribute("aria-label") || "",
    el.getAttribute("aria-placeholder") || ""
  ];
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const labelEl = document.getElementById(labelledBy);
    if (labelEl) parts.push(labelEl.textContent || "");
  }
  return parts.join(" ").toLowerCase();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 30000, intervalMs = 250) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (shouldStop) throw new Error("stopped");
    const result = predicate();
    if (result) return result;
    await sleep(intervalMs);
  }
  throw new Error("timeout");
}

// ---------- Fresh-query element finders ----------
// NEVER hold references across awaits — DOM re-renders after each response.

function findChatInput() {
  const candidates = [
    ...document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]')
  ].filter(isVisible);

  if (candidates.length === 0) return null;

  // Prefer inputs whose label clearly says "chat" / "ask a question"
  for (const el of candidates) {
    const text = getLabelText(el);
    if (CHAT_PATTERNS.some(p => text.includes(p))) return el;
  }

  // Exclude obvious sources/discover inputs, pick bottom-most
  const filtered = candidates.filter(el => {
    const text = getLabelText(el);
    if (!text) return true;
    return !EXCLUDED_PATTERNS.some(p => text.includes(p));
  });
  const pool = filtered.length > 0 ? filtered : candidates;
  return [...pool].sort((a, b) =>
    b.getBoundingClientRect().top - a.getBoundingClientRect().top
  )[0];
}

function findButtonByLabel(labelKeywords) {
  // Find all visible buttons whose aria-label matches one of the keywords,
  // then pick the one nearest to the chat input.
  const input = findChatInput();
  if (!input) return null;
  const inputRect = input.getBoundingClientRect();
  const inputCenter = { x: inputRect.left + inputRect.width / 2, y: inputRect.top + inputRect.height / 2 };

  const matches = [...document.querySelectorAll("button")].filter(btn => {
    if (!isVisible(btn)) return false;
    const label = (btn.getAttribute("aria-label") || "").toLowerCase();
    return labelKeywords.some(k => label.includes(k));
  });

  if (matches.length === 0) return null;

  // Sort by distance to input
  return matches.sort((a, b) => {
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    const da = Math.hypot((ra.left + ra.width / 2) - inputCenter.x, (ra.top + ra.height / 2) - inputCenter.y);
    const db = Math.hypot((rb.left + rb.width / 2) - inputCenter.x, (rb.top + rb.height / 2) - inputCenter.y);
    return da - db;
  })[0];
}

function findSendButton() {
  return findButtonByLabel(["submit", "send"]);
}

function findStopButton() {
  return findButtonByLabel(["stop", "cancel generating", "cancel"]);
}

function isSubmitEnabled(btn) {
  if (!btn) return false;
  if (btn.disabled) return false;
  if (btn.getAttribute("aria-disabled") === "true") return false;
  return true;
}

// ---------- Input handling ----------

function setInputValue(el, value) {
  if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (el.isContentEditable) {
    el.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand("insertText", false, value);
  }
}

// ---------- Core queue runner ----------

async function submitPrompt(text) {
  console.log("[NBLM Queue] Submitting prompt:", text.substring(0, 60));

  // 1. Find chat input
  const input = findChatInput();
  if (!input) throw new Error("Couldn't find chat input.");

  const labelText = getLabelText(input);
  if (EXCLUDED_PATTERNS.some(p => labelText.includes(p)) &&
      !CHAT_PATTERNS.some(p => labelText.includes(p))) {
    throw new Error(`Refused: found a sources/discover field ("${labelText.trim().substring(0, 60)}").`);
  }
  console.log("[NBLM Queue] Chat input found:", labelText.trim() || "(no label)");

  // 2. Type the prompt
  input.focus();
  await sleep(150);
  setInputValue(input, text);
  await sleep(500);

  // 3. Wait for send button to be enabled, then click
  let sendBtn = null;
  try {
    await waitFor(() => {
      sendBtn = findSendButton();
      return sendBtn && isSubmitEnabled(sendBtn);
    }, 8000);
  } catch (e) {
    throw new Error("Send button never became enabled after typing.");
  }

  console.log("[NBLM Queue] Clicking send button.");
  sendBtn.click();

  // 4. Wait for generation to START (stop button appears, with grace period)
  let generationStarted = false;
  try {
    await waitFor(() => {
      if (shouldStop) return true;
      return findStopButton() !== null;
    }, 15000);
    generationStarted = true;
    console.log("[NBLM Queue] Generation started (stop button detected).");
  } catch (e) {
    console.warn("[NBLM Queue] Stop button never appeared. Generation may have been too fast, or signal missed.");
  }

  if (shouldStop) throw new Error("stopped");

  // 5. Wait for generation to END.
  // ONLY check for stop-button absence — do NOT rely on send button being enabled,
  // because NotebookLM clears the input after sending which keeps send disabled.
  // Use a stability window so we don't false-positive on transient stop-button removal.
  if (generationStarted) {
    const STABILITY_MS = 2000;
    let stopGoneSince = null;
    await waitFor(() => {
      if (shouldStop) return true;
      const stop = findStopButton();
      if (stop) {
        stopGoneSince = null;
        return false;
      }
      if (stopGoneSince === null) {
        stopGoneSince = Date.now();
        return false;
      }
      return (Date.now() - stopGoneSince) >= STABILITY_MS;
    }, config.maxWaitMs);
    console.log("[NBLM Queue] Generation finished (stop button gone for", STABILITY_MS, "ms).");
  } else {
    // Fallback: short fixed wait if we never saw the stop button
    console.log("[NBLM Queue] No start signal — falling back to 5s fixed wait.");
    await sleep(5000);
  }

  if (shouldStop) throw new Error("stopped");

  // 6. Ensure the input is ready for the next prompt
  // (re-query fresh; the previous element may have been replaced)
  try {
    await waitFor(() => {
      if (shouldStop) return true;
      const freshInput = findChatInput();
      if (!freshInput) return false;
      // Input must accept new text. We check by reading current value/text - should be empty.
      const current = (freshInput.value !== undefined ? freshInput.value : freshInput.textContent || "").trim();
      return current === "" || current.length < 5;
    }, 10000);
  } catch (e) {
    console.warn("[NBLM Queue] Input didn't appear ready, continuing anyway.");
  }

  console.log("[NBLM Queue] Prompt complete. Moving to next.");
}

async function runQueue() {
  if (isRunning) return;
  isRunning = true;
  shouldStop = false;
  console.log("[NBLM Queue] Queue started.");

  try {
    while (!shouldStop) {
      const data = await chrome.storage.local.get(["queue"]);
      const queue = data.queue || [];
      const idx = queue.findIndex(q => q.status === "pending");

      if (idx === -1) {
        console.log("[NBLM Queue] No more pending prompts.");
        break;
      }

      await chrome.storage.local.set({ currentIdx: idx });

      try {
        await submitPrompt(queue[idx].text);
        queue[idx].status = "done";
        console.log(`[NBLM Queue] Prompt ${idx + 1} marked done.`);
      } catch (err) {
        if (err.message === "stopped") {
          console.log("[NBLM Queue] Stopped by user.");
          break;
        }
        queue[idx].status = "error";
        queue[idx].error = err.message;
        console.error(`[NBLM Queue] Error on prompt ${idx + 1}:`, err);
        await chrome.storage.local.set({ queue, running: false, currentIdx: -1 });
        isRunning = false;
        return;
      }

      await chrome.storage.local.set({ queue });
      if (shouldStop) break;
      console.log(`[NBLM Queue] Sleeping ${config.delayMs}ms before next prompt.`);
      await sleep(config.delayMs);
    }
  } finally {
    await chrome.storage.local.set({ running: false, currentIdx: -1 });
    isRunning = false;
    shouldStop = false;
    console.log("[NBLM Queue] Queue finished.");
  }
}

// ---------- Messages ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "START") {
    config.delayMs = msg.delayMs || 3000;
    config.maxWaitMs = msg.maxWaitMs || 600000;
    runQueue();
    sendResponse({ ok: true });
  } else if (msg.type === "STOP") {
    shouldStop = true;
    sendResponse({ ok: true });
  } else if (msg.type === "PING") {
    sendResponse({ ok: true, url: location.href });
  } else if (msg.type === "DEBUG") {
    const input = findChatInput();
    const send = findSendButton();
    const stop = findStopButton();
    sendResponse({
      ok: true,
      input: input ? { tag: input.tagName, label: getLabelText(input).trim() } : null,
      sendBtn: send ? { label: (send.getAttribute("aria-label") || "").trim(), enabled: isSubmitEnabled(send) } : null,
      stopBtn: stop ? { label: (stop.getAttribute("aria-label") || "").trim() } : null
    });
  }
  return true;
});

chrome.storage.local.get(["running"], (data) => {
  if (data.running) chrome.storage.local.set({ running: false, currentIdx: -1 });
});

console.log("[NBLM Queue] Content script v1.0.2 loaded.");

// Expose debug helpers - access via DevTools by switching the Console context dropdown
// to the extension's content script (instead of "top").
window.__nblmQueueDebug = { findChatInput, findSendButton, findStopButton, getLabelText, isSubmitEnabled };
