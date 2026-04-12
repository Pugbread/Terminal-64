#!/usr/bin/env node

// Terminal 64 Delegation MCP Server
// Provides team communication tools for delegated child agents.
// Communicates with the permission server's /delegation/ HTTP endpoints.
// Protocol: MCP over stdio (JSON-RPC 2.0)

import { createInterface } from "readline";
import http from "http";

const PORT = parseInt(process.env.T64_DELEGATION_PORT || "0", 10);
const SECRET = process.env.T64_DELEGATION_SECRET || "";
const GROUP_ID = process.env.T64_GROUP_ID || "";
const AGENT_LABEL = process.env.T64_AGENT_LABEL || "Agent";

if (!PORT || !GROUP_ID || !SECRET) {
  process.stderr.write("[t64-delegation] Missing T64_DELEGATION_PORT, T64_DELEGATION_SECRET, or T64_GROUP_ID\n");
  process.exit(1);
}

const TOOLS = [
  {
    name: "send_to_team",
    description: "Send a message to the delegation team chat. Use this to share progress updates, findings, or coordinate with other agents.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "The message to send to the team" },
      },
      required: ["message"],
    },
  },
  {
    name: "read_team",
    description: "Read recent messages from the delegation team chat to see what other agents have posted.",
    inputSchema: {
      type: "object",
      properties: {
        last: { type: "number", description: "Number of recent messages to retrieve (default: 20)" },
      },
    },
  },
  {
    name: "report_done",
    description: "Signal that your task is complete. Include a summary of what you accomplished.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Summary of what was accomplished" },
      },
      required: ["summary"],
    },
  },
];

function httpRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "127.0.0.1",
      port: PORT,
      path,
      method,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SECRET}`,
      },
    };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => {
      req.destroy(new Error("Request timeout"));
    });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function handleToolCall(name, args) {
  switch (name) {
    case "send_to_team": {
      await httpRequest("POST", "/delegation/message", {
        group_id: GROUP_ID,
        agent: AGENT_LABEL,
        message: args.message || "",
      });
      return { content: [{ type: "text", text: "Message sent to team chat." }] };
    }
    case "read_team": {
      const last = args.last || 20;
      const msgs = await httpRequest("GET", `/delegation/messages?group=${encodeURIComponent(GROUP_ID)}&last=${last}`);
      if (!Array.isArray(msgs) || msgs.length === 0) {
        return { content: [{ type: "text", text: "No team messages yet." }] };
      }
      const formatted = msgs.map((m) => {
        const time = new Date(m.timestamp).toLocaleTimeString();
        const prefix = m.msg_type === "complete" ? "[DONE]" : "";
        return `[${time}] ${m.agent}: ${prefix}${m.message}`;
      }).join("\n");
      return { content: [{ type: "text", text: formatted }] };
    }
    case "report_done": {
      await httpRequest("POST", "/delegation/complete", {
        group_id: GROUP_ID,
        agent: AGENT_LABEL,
        summary: args.summary || "",
      });
      return { content: [{ type: "text", text: "Task completion reported." }] };
    }
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}

function send(msg) {
  const json = JSON.stringify(msg);
  process.stdout.write(json + "\n");
}

function handleMessage(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "t64-delegation", version: "1.0.0" },
        },
      });
      break;

    case "notifications/initialized":
      // No response needed for notifications
      break;

    case "tools/list":
      send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      break;

    case "tools/call":
      handleToolCall(params.name, params.arguments || {})
        .then((result) => send({ jsonrpc: "2.0", id, result }))
        .catch((err) => {
          send({
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true },
          });
        });
      break;

    default:
      if (id !== undefined) {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
  }
}

// MCP stdio transport: newline-delimited JSON-RPC
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    handleMessage(JSON.parse(line));
  } catch (err) {
    process.stderr.write(`[t64-delegation] Parse error: ${err.message}\n`);
  }
});

process.stderr.write(`[t64-delegation] Started for group ${GROUP_ID.slice(0, 8)} on port ${PORT}\n`);
