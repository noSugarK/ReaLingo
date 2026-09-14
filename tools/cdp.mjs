// Evaluate JS inside the running app's WebView2 page, over the Chrome DevTools Protocol.
//   node cdp.mjs <file-with-js>            -> runs against the main window
//   node cdp.mjs <file-with-js> subtitle   -> runs against the subtitle window
//   node cdp.mjs --list                    -> show debuggable targets
import fs from "node:fs";

const PORT = process.env.CDP_PORT || 9222;

const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
const pages = targets.filter((t) => t.type === "page");

if (process.argv[2] === "--list") {
  console.log(pages.map((p) => `${p.title}  <-  ${p.url}`).join("\n") || "(no pages)");
  process.exit(0);
}

const want = process.argv[3] === "subtitle";
const target =
  pages.find((p) => p.url.includes("subtitle.html") === want) ?? pages[0];
if (!target) {
  console.error("no debuggable page; is the app running with --remote-debugging-port?");
  process.exit(1);
}

const expression = fs.readFileSync(process.argv[2], "utf8");
const ws = new WebSocket(target.webSocketDebuggerUrl);

ws.addEventListener("open", () => {
  ws.send(
    JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: { expression, awaitPromise: true, returnByValue: true, userGesture: true },
    })
  );
});

ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id !== 1) return;
  const r = msg.result;
  if (r.exceptionDetails) {
    console.error("PAGE ERROR:", r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  } else {
    const v = r.result.value;
    console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
  }
  ws.close();
  process.exit(0);
});

ws.addEventListener("error", (e) => {
  console.error("ws error", e.message ?? e);
  process.exit(1);
});
