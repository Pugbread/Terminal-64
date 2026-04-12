#!/usr/bin/env node

// Terminal 64 Widget MCP Server
// Provides tools for widgets to access Terminal 64 data:
// - Active sessions, terminal info, canvas state
// - Event subscriptions (prompt ran, session created, etc.)
// Protocol: MCP over stdio (JSON-RPC 2.0)

import { createInterface } from "readline";
import http from "http";

const PORT = parseInt(process.env.T64_WIDGET_PORT || "0", 10);
const WIDGET_ID = process.env.T64_WIDGET_ID || "";

const TOOLS = [
  {
    name: "get_sessions",
    description: "Get a list of all active Claude Code sessions in Terminal 64, including their names, working directories, and status.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_terminals",
    description: "Get a list of all terminal panels on the Terminal 64 canvas, including their positions, titles, and types.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_session_messages",
    description: "Get recent messages from a specific Claude session.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "The session ID to get messages from" },
        last: { type: "number", description: "Number of recent messages (default: 10)" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "get_canvas_state",
    description: "Get the current canvas state: pan position, zoom level, and number of open panels.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "emit_widget_event",
    description: "Emit a custom event from this widget that Terminal 64 can listen to. Use for inter-widget communication or triggering UI updates.",
    inputSchema: {
      type: "object",
      properties: {
        event_type: { type: "string", description: "Event type name" },
        data: { type: "object", description: "Event payload data" },
      },
      required: ["event_type"],
    },
  },
];

// JSON-RPC helpers
function send(msg) {
  const str = JSON.stringify(msg);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(str)}\r\n\r\n${str}`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

// HTTP helper for permission server queries
function httpGet(path) {
  return new Promise((resolve, reject) => {
    if (!PORT) return reject(new Error("No T64_WIDGET_PORT configured"));
    const req = http.request(
      { hostname: "127.0.0.1", port: PORT, path, method: "GET", timeout: 5000 },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try { resolve(JSON.parse(body)); } catch { resolve(body); }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

function httpPost(path, data) {
  return new Promise((resolve, reject) => {
    if (!PORT) return reject(new Error("No T64_WIDGET_PORT configured"));
    const payload = JSON.stringify(data);
    const req = http.request(
      {
        hostname: "127.0.0.1", port: PORT, path, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
        timeout: 5000,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try { resolve(JSON.parse(body)); } catch { resolve(body); }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(payload);
    req.end();
  });
}

// Tool handlers
async function handleToolCall(name, args) {
  switch (name) {
    case "get_sessions": {
      try {
        const data = await httpGet("/widget/sessions");
        return JSON.stringify(data, null, 2);
      } catch (err) {
        return `Error fetching sessions: ${err.message}`;
      }
    }
    case "get_terminals": {
      try {
        const data = await httpGet("/widget/terminals");
        return JSON.stringify(data, null, 2);
      } catch (err) {
        return `Error fetching terminals: ${err.message}`;
      }
    }
    case "get_session_messages": {
      try {
        const last = args.last || 10;
        const data = await httpGet(`/widget/session/${args.session_id}/messages?last=${last}`);
        return JSON.stringify(data, null, 2);
      } catch (err) {
        return `Error fetching messages: ${err.message}`;
      }
    }
    case "get_canvas_state": {
      try {
        const data = await httpGet("/widget/canvas");
        return JSON.stringify(data, null, 2);
      } catch (err) {
        return `Error fetching canvas state: ${err.message}`;
      }
    }
    case "emit_widget_event": {
      try {
        await httpPost("/widget/event", {
          widget_id: WIDGET_ID,
          event_type: args.event_type,
          data: args.data || {},
        });
        return "Event emitted successfully";
      } catch (err) {
        return `Error emitting event: ${err.message}`;
      }
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

// Message router
async function handleMessage(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case "initialize":
      respond(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "t64-widget", version: "1.0.0" },
      });
      break;

    case "notifications/initialized":
      break;

    case "tools/list":
      respond(id, { tools: TOOLS });
      break;

    case "tools/call": {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      try {
        const result = await handleToolCall(toolName, toolArgs);
        respond(id, {
          content: [{ type: "text", text: result }],
          isError: false,
        });
      } catch (err) {
        respond(id, {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        });
      }
      break;
    }

    default:
      if (id !== undefined) {
        respondError(id, -32601, `Method not found: ${method}`);
      }
  }
}

// MCP stdio transport (Content-Length framing)
let buffer = "";

function processBuffer() {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;
    const header = buffer.slice(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) { buffer = buffer.slice(headerEnd + 4); continue; }
    const len = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + len) break;
    const body = buffer.slice(bodyStart, bodyStart + len);
    buffer = buffer.slice(bodyStart + len);
    try {
      handleMessage(JSON.parse(body));
    } catch (err) {
      process.stderr.write(`[t64-widget] Parse error: ${err.message}\n`);
    }
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  processBuffer();
});

process.stderr.write(`[t64-widget] Started for widget ${WIDGET_ID || "(unknown)"}\n`);
