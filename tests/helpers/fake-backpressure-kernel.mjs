#!/usr/bin/env node
import readline from "node:readline";

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "backpressure", received: message.params } });
  } else if (message.method === "test/flood") {
    // 远超 OS pipe 和 Readable highWaterMark；SIGTERM 时仍有真实 pipe 数据未读。
    for (let index = 0; index < 512; index++) {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "backpressure", update: {
        sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x".repeat(8192) }
      } } });
    }
  }
});
setInterval(() => {}, 60_000);
