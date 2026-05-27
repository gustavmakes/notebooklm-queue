const $ = id => document.getElementById(id);

let state = {
  queue: [],
  running: false,
  currentIdx: -1,
  delaySec: 3,
  maxWaitMin: 10
};

async function loadState() {
  const data = await chrome.storage.local.get(["queue", "running", "currentIdx", "delaySec", "maxWaitMin"]);
  state.queue = data.queue || [];
  state.running = data.running || false;
  state.currentIdx = data.currentIdx ?? -1;
  state.delaySec = data.delaySec ?? 3;
  state.maxWaitMin = data.maxWaitMin ?? 10;
  $("delaySec").value = state.delaySec;
  $("maxWaitMin").value = state.maxWaitMin;
}

async function saveState() {
  await chrome.storage.local.set({
    queue: state.queue,
    running: state.running,
    currentIdx: state.currentIdx,
    delaySec: state.delaySec,
    maxWaitMin: state.maxWaitMin
  });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function render() {
  const list = $("list");
  const pending = state.queue.filter(q => q.status === "pending").length;
  const done = state.queue.filter(q => q.status === "done").length;
  const error = state.queue.filter(q => q.status === "error").length;

  $("stats").textContent = state.queue.length === 0
    ? "No prompts queued."
    : `${pending} pending · ${done} done${error ? ` · ${error} error` : ""} · ${state.queue.length} total`;

  if (state.queue.length === 0) {
    list.innerHTML = '<div style="color:#666;text-align:center;padding:14px;font-size:11px">Add prompts to get started.</div>';
  } else {
    list.innerHTML = state.queue.map((item, i) => {
      const isCurrent = state.running && i === state.currentIdx;
      return `
        <div class="item ${item.status === 'done' ? 'done' : ''} ${item.status === 'error' ? 'error' : ''} ${isCurrent ? 'current' : ''}">
          <div class="item-num">${i + 1}</div>
          <div class="item-text">${isCurrent ? '⏳ ' : ''}${escapeHtml(item.text.substring(0, 200))}${item.text.length > 200 ? '…' : ''}</div>
          <div class="item-actions">
            ${!state.running && item.status === 'done' ? `<button class="icon-btn" data-action="reset" data-i="${i}" title="Mark pending">↺</button>` : ''}
            ${!state.running ? `<button class="icon-btn" data-action="remove" data-i="${i}" title="Delete">✕</button>` : ''}
          </div>
        </div>
      `;
    }).join("");
  }

  // Toggle start/stop buttons
  $("startBtn").style.display = state.running ? "none" : "block";
  $("stopBtn").style.display = state.running ? "block" : "none";
  $("startBtn").disabled = pending === 0;
  $("addBtn").disabled = state.running;
  $("clearBtn").disabled = state.running;
  $("sampleBtn").disabled = state.running;
  $("input").disabled = state.running;
}

async function checkTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const statusEl = $("status");
  if (tab && tab.url && tab.url.startsWith("https://notebooklm.google.com/")) {
    statusEl.textContent = state.running ? "Running…" : "Connected";
    statusEl.className = "status " + (state.running ? "running" : "connected");
    return tab;
  } else {
    statusEl.textContent = "Open NotebookLM";
    statusEl.className = "status error";
    return null;
  }
}

function addPrompts() {
  const raw = $("input").value.trim();
  if (!raw) return;
  const parts = raw.split(/\n\s*(?:---+)?\s*\n/).map(s => s.trim()).filter(Boolean);
  parts.forEach(text => state.queue.push({ text, status: "pending" }));
  $("input").value = "";
  saveState();
  render();
}

function clearAll() {
  if (state.queue.length === 0) return;
  if (!confirm("Clear the entire queue?")) return;
  state.queue = [];
  state.currentIdx = -1;
  saveState();
  render();
}

async function startQueue() {
  const tab = await checkTab();
  if (!tab) {
    alert("Open a NotebookLM notebook in this tab first.");
    return;
  }
  state.delaySec = parseInt($("delaySec").value) || 3;
  state.maxWaitMin = parseInt($("maxWaitMin").value) || 10;
  state.running = true;
  await saveState();
  render();

  chrome.tabs.sendMessage(tab.id, {
    type: "START",
    delayMs: state.delaySec * 1000,
    maxWaitMs: state.maxWaitMin * 60 * 1000
  }, response => {
    if (chrome.runtime.lastError) {
      state.running = false;
      saveState();
      render();
      alert("Couldn't reach NotebookLM tab. Reload the NotebookLM page and try again.");
    }
  });
}

async function stopQueue() {
  const tab = await checkTab();
  if (tab) {
    chrome.tabs.sendMessage(tab.id, { type: "STOP" }, () => { /* ignore errors */ });
  }
  state.running = false;
  await saveState();
  render();
}

// Listen for queue updates from content script
chrome.storage.onChanged.addListener((changes) => {
  if (changes.queue) state.queue = changes.queue.newValue || [];
  if (changes.running) state.running = changes.running.newValue;
  if (changes.currentIdx) state.currentIdx = changes.currentIdx.newValue;
  render();
  checkTab();
});

// Event delegation for list buttons
$("list").addEventListener("click", e => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const i = parseInt(btn.dataset.i);
  const action = btn.dataset.action;
  if (action === "remove") state.queue.splice(i, 1);
  if (action === "reset") state.queue[i].status = "pending";
  saveState();
  render();
});

$("addBtn").addEventListener("click", addPrompts);
$("clearBtn").addEventListener("click", clearAll);
$("startBtn").addEventListener("click", startQueue);
$("stopBtn").addEventListener("click", stopQueue);
$("sampleBtn").addEventListener("click", () => {
  $("input").value = `Summarize the key arguments across the sources.

---

What contradictions exist between the sources?

---

Generate 5 follow-up questions a skeptical reader would ask.`;
});

$("input").addEventListener("keydown", e => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    addPrompts();
  }
});

(async () => {
  await loadState();
  await checkTab();
  render();
})();
