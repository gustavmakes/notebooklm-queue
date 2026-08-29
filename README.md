# DEPRECATED. GOOGLE IS IMPLEMENTING THIS IN NOTEBOOK SEPTEMBER 2 2026 (https://blog.google/innovation-and-ai/products/gemini-notebook/new-flexible-usage-limits/)

# NotebookLM Prompt Queue

A small Chrome extension that queues up prompts for [NotebookLM](https://notebooklm.google.com) and auto-submits them one after the other. Send 20 prompts before your morning coffee, come back to 20 answers.

NotebookLM has no public API, so this is the next best thing: it drives the chat UI directly via a content script.

## Install (unpacked, free)

1. [Download the latest release](../../releases/latest) and unzip it (or clone this repo)
2. Open `chrome://extensions` in Chrome
3. Toggle **Developer mode** (top right)
4. Click **Load unpacked** and select the `nblm-queue` folder
5. Pin the extension to your toolbar

## Use

1. Open a NotebookLM notebook
2. Click the extension icon
3. Paste prompts — separate multiple with a blank line or `---`
4. Click **Start queue**
5. Keep the NotebookLM tab visible (don't minimize the window — Chrome throttles background tabs, which breaks the completion polling)

State persists across popup closes. Stop and resume at any time.

## How it works

- **Targets the chat input only.** Identified by placeholder text like "Ask a question or create something". Explicitly refuses the Sources/Discover field even if matched first.
- **Detects completion via the "Stop" button.** After clicking send, waits for the stop button to appear, then waits for it to disappear for 2 seconds of stability. This survives most UI updates better than DOM class names.
- **All lookups are fresh queries** — no held references — so NotebookLM re-rendering the chat area between prompts doesn't break anything.

If submission breaks because NotebookLM changes its UI, the fix is editing the `CHAT_PATTERNS` / `EXCLUDED_PATTERNS` arrays at the top of `content.js`.

## Settings

- **Delay between prompts** — buffer after one finishes (default 3s)
- **Max wait per prompt** — safety timeout if a single prompt takes too long (default 10 min)

## Limitations

- NotebookLM tab needs to stay visible. Chrome throttles JS timers in background tabs.
- Doesn't capture responses — they stay in NotebookLM as normal chat messages.
- If NotebookLM significantly redesigns the chat UI, selectors may need an update.

## Debug

Open DevTools on the NotebookLM tab and watch the console for `[NBLM Queue]` log lines. Every step logs what it's doing.

To inspect what the extension sees, switch the Console context dropdown from `top` to the content script context, then:

```js
__nblmQueueDebug.findChatInput()   // highlights the input it would use
__nblmQueueDebug.findSendButton()  // highlights the send button
```

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (V3) |
| `popup.html/css/js` | The queue management UI |
| `content.js` | Runs on NotebookLM — finds inputs, submits, waits for completion |
| `background.js` | Minimal service worker |
| `icons/` | Extension icons (16/48/128px) |

## Contributing

PRs welcome, especially:
- Selector fixes when NotebookLM updates its UI
- Better completion detection (e.g. watching the chat history for stream end)
- Localized placeholder patterns (the current ones are English)

## License

MIT — see [LICENSE](LICENSE).
