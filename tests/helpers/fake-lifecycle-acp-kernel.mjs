import readline from "node:readline";

const pending = new Map();
const write = message => process.stdout.write(`${JSON.stringify(message)}\n`);
readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentInfo: { name: "fake", version: "1" } } });
  } else if (["session/load", "session/resume"].includes(message.method)) {
    write({ jsonrpc: "2.0", id: message.id, result: { sessionId: message.params.sessionId } });
  } else if (message.method === "session/prompt") {
    pending.set(message.params.sessionId, message.id);
    write({ jsonrpc: "2.0", id: `permission:${message.params.sessionId}`, method: "session/request_permission", params: { sessionId: message.params.sessionId, toolCall: { toolCallId: "tool", title: "fake approval", status: "pending" }, options: [{ optionId: "reject", name: "Reject", kind: "reject_once" }] } });
  } else if (message.method === "session/cancel") {
    const id = pending.get(message.params.sessionId);
    if (id !== undefined) {
      pending.delete(message.params.sessionId);
      write({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
    }
  } else if (typeof message.id === "string" && message.id.startsWith("permission:")) {
    const sessionId = message.id.slice("permission:".length);
    const id = pending.get(sessionId);
    if (id !== undefined) {
      pending.delete(sessionId);
      write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: message.result?.outcome?.optionId === "reject" ? "permission rejected" : "unexpected approval" } } } });
      write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    }
  }
});
