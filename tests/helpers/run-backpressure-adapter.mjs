import { Writable } from "node:stream";

const { runOfficialKernel } = await import(process.argv[2]);
let blocking = false;
let pending = "";
const output = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) {
  if (blocking) {
    // 永远不 drain，SIGTERM 必须依靠代理自己的关闭路径排空内核 pipe。
    process.send?.({ event: "blocked" });
    return;
  }
  pending += chunk.toString("utf8");
  let newline;
  while ((newline = pending.indexOf("\n")) >= 0) {
    const message = JSON.parse(pending.slice(0, newline));
    pending = pending.slice(newline + 1);
    if (message.result?.sessionId) {
      const server = message.result.received.mcpServers.find(entry => entry.name === "paseo_skills");
      process.send?.({ event: "session", url: server.url });
      blocking = true;
    }
  }
  callback();
} });

try {
  await runOfficialKernel({ stdin: process.stdin, stdout: output, env: process.env, version: "signal-test" });
  process.send?.({ event: "cleaned" });
} catch (error) {
  process.send?.({ event: "failed", error: String(error) });
  process.exitCode = 1;
} finally {
  process.stdin.destroy();
  process.disconnect?.();
}
