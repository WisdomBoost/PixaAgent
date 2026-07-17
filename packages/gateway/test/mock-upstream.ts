import http from "node:http";

interface MockDelta {
  content: string;
  finish_reason?: string;
}

interface MockUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost: number;
}

interface MockChunk {
  choices: [{ delta: MockDelta; finish_reason?: string }];
  usage?: MockUsage;
}

// Mimics OpenRouter's streaming shape closely enough to prove the gateway
// forwards chunks live instead of buffering: several delta events, a keep-alive
// comment, a final usage event, then [DONE].
const chunks: MockChunk[] = [
  { choices: [{ delta: { content: "Hello" } }] },
  { choices: [{ delta: { content: " from" } }] },
  { choices: [{ delta: { content: " the" } }] },
  { choices: [{ delta: { content: " mock" } }] },
  {
    choices: [{ delta: { content: " upstream." }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9, cost: 0.00012 },
  },
];

http
  .createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    let i = 0;
    const timer = setInterval(() => {
      if (i >= chunks.length) {
        res.write("data: [DONE]\n\n");
        res.end();
        clearInterval(timer);
        return;
      }
      res.write(`data: ${JSON.stringify(chunks[i])}\n\n`);
      console.log(`[mock upstream] sent chunk ${i} at ${Date.now()}`);
      i++;
    }, 400); // 400ms between chunks — enough to make buffering obvious if it happens
  })
  .listen(9091, () => console.log("mock upstream listening on :9091"));