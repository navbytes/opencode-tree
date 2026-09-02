// Minimal OpenAI-compatible mock provider. Records every request body to
// requests.jsonl and answers with a canned reply. Supports streaming (SSE) and
// non-streaming chat completions. Optional tool call scripted via env MOCK_TOOL=1
// for the first request of each session (detected by absence of tool messages).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.MOCK_PORT || 4010);
const LOG = process.env.MOCK_LOG || path.join(process.cwd(), "requests.jsonl");
const REPLY = process.env.MOCK_REPLY || "mock reply";

function sse(res, chunks) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const url = req.url || "";
    if (req.method === "GET" && url.startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ object: "list", data: [{ id: "mock-a" }, { id: "mock-b" }] }));
    }
    if (req.method === "POST" && url.startsWith("/v1/chat/completions")) {
      let json = {};
      try { json = JSON.parse(body || "{}"); } catch {}
      fs.appendFileSync(LOG, JSON.stringify({ ts: Date.now(), url, model: json.model, stream: !!json.stream, body: json }) + "\n");
      const id = "chatcmpl-" + Date.now();
      const created = Math.floor(Date.now() / 1000);
      // MOCK_TOOL=1: answer with a bash tool call whenever the latest message is a user
      // message mentioning "tool" (so tests control tool turns per prompt); a request that
      // ends with a tool result gets plain text.
      const msgs = json.messages || [];
      const lastMsg = msgs[msgs.length - 1] || {};
      const lastText = typeof lastMsg.content === "string" ? lastMsg.content : Array.isArray(lastMsg.content) ? lastMsg.content.map((c) => c.text || "").join(" ") : "";
      const wantTool = process.env.MOCK_TOOL === "1" && lastMsg.role === "user" && /^run the tool/i.test(lastText.trim()) && (json.tools || []).some((t) => t.function?.name === "bash");
      if (json.stream) {
        const chunks = [];
        if (wantTool) {
          chunks.push({ id, object: "chat.completion.chunk", created, model: json.model, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: process.env.MOCK_TOOL_CMD || "echo mock-tool-output", description: "mock" }) } }] }, finish_reason: null }] });
          chunks.push({ id, object: "chat.completion.chunk", created, model: json.model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
        } else {
          chunks.push({ id, object: "chat.completion.chunk", created, model: json.model, choices: [{ index: 0, delta: { role: "assistant", content: REPLY }, finish_reason: null }] });
          chunks.push({ id, object: "chat.completion.chunk", created, model: json.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } });
        }
        return sse(res, chunks);
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id, object: "chat.completion", created, model: json.model, choices: [{ index: 0, message: { role: "assistant", content: REPLY }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } }));
    }
    res.writeHead(404); res.end("not found");
  });
});
server.listen(PORT, "127.0.0.1", () => console.log(`mock provider on http://127.0.0.1:${PORT}/v1 -> ${LOG}`));
