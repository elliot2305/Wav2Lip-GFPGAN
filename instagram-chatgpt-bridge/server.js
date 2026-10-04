import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 3000);
const API_VERSION = process.env.META_API_VERSION || "v26.0";
const GRAPH = `https://graph.instagram.com/${API_VERSION}`;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

async function metaGet(path, params = {}) {
  const token = required("IG_ACCESS_TOKEN");
  const url = new URL(`${GRAPH}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw data;
  return data;
}

async function metaPost(path, body) {
  const token = required("IG_ACCESS_TOKEN");
  const response = await fetch(`${GRAPH}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw data;
  return data;
}

function publicError(error) {
  return {
    message: error?.error?.message || error?.message || "Instagram API error",
    type: error?.error?.type,
    code: error?.error?.code,
    error_subcode: error?.error?.error_subcode,
  };
}

function participantsOf(conversation) {
  const rows = conversation?.participants?.data || conversation?.participants || [];
  return Array.isArray(rows) ? rows.map((p) => ({ id: p?.id, username: p?.username, name: p?.name })) : [];
}

async function getProfile() {
  return metaGet("/me", { fields: "id,username,name,account_type" });
}

async function listConversations(limit = 20, after) {
  const data = await metaGet("/me/conversations", {
    platform: "instagram",
    fields: "id,updated_time,participants",
    limit: Math.min(Math.max(Number(limit) || 20, 1), 50),
    after,
  });
  return {
    conversations: (data?.data || []).map((c) => ({ id: c?.id, updated_time: c?.updated_time, participants: participantsOf(c) })),
    next_cursor: data?.paging?.cursors?.after || null,
  };
}

async function searchConversations(query, maxPages = 5) {
  const needle = String(query).trim().toLowerCase().replace(/^@/, "");
  const matches = [];
  let after;
  for (let page = 0; page < Math.min(Math.max(Number(maxPages) || 5, 1), 10); page++) {
    const result = await listConversations(50, after);
    for (const conversation of result.conversations) {
      const haystack = conversation.participants.map((p) => `${p.username || ""} ${p.name || ""} ${p.id || ""}`.toLowerCase()).join(" ");
      if (haystack.includes(needle)) matches.push(conversation);
    }
    if (!result.next_cursor || matches.length >= 20) break;
    after = result.next_cursor;
  }
  return { conversations: matches.slice(0, 20) };
}

async function getMessages(conversationId, limit = 20) {
  const n = Math.min(Math.max(Number(limit) || 20, 1), 20);
  const data = await metaGet(`/${encodeURIComponent(conversationId)}`, {
    fields: `messages.limit(${n}){id,created_time,from,to,message}`,
  });
  const block = data?.messages || {};
  return {
    messages: (block?.data || []).map((m) => ({
      id: m?.id,
      created_time: m?.created_time,
      from: m?.from ? { id: m.from.id, username: m.from.username, name: m.from.name } : null,
      to: Array.isArray(m?.to?.data) ? m.to.data.map((p) => ({ id: p.id, username: p.username, name: p.name })) : m?.to || null,
      message: m?.message || "",
    })),
    next_cursor: block?.paging?.cursors?.after || null,
  };
}

function textResult(payload, summary) {
  return { content: [{ type: "text", text: `${summary}\n${JSON.stringify(payload, null, 2)}` }] };
}

function errorResult(error) {
  return { isError: true, content: [{ type: "text", text: JSON.stringify(publicError(error), null, 2) }] };
}

function createServer() {
  const server = new McpServer({ name: "elliot-instagram", version: "1.0.0" });

  server.registerTool("instagram_profile", {
    title: "Instagram profile",
    description: "Get the connected Instagram professional account.",
    inputSchema: {},
  }, async () => {
    try {
      const profile = await getProfile();
      return textResult({ profile }, `Connected account: @${profile?.username || profile?.id}`);
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("instagram_list_conversations", {
    title: "List Instagram conversations",
    description: "List recent DM conversations for the connected Instagram professional account.",
    inputSchema: {
      limit: z.number().int().min(1).max(50).optional(),
      after: z.string().optional(),
    },
  }, async ({ limit, after }) => {
    try {
      const result = await listConversations(limit || 20, after);
      return textResult(result, `Found ${result.conversations.length} conversations.`);
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("instagram_search_conversations", {
    title: "Search Instagram conversations",
    description: "Search recent Instagram DM conversations by username, display name, or Instagram-scoped user id.",
    inputSchema: {
      query: z.string().min(1),
      max_pages: z.number().int().min(1).max(10).optional(),
    },
  }, async ({ query, max_pages }) => {
    try {
      const result = await searchConversations(query, max_pages || 5);
      return textResult(result, `Found ${result.conversations.length} matching conversations.`);
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("instagram_get_messages", {
    title: "Read Instagram messages",
    description: "Read the most recent messages from one Instagram DM conversation.",
    inputSchema: {
      conversation_id: z.string().min(1),
      limit: z.number().int().min(1).max(20).optional(),
    },
  }, async ({ conversation_id, limit }) => {
    try {
      const result = await getMessages(conversation_id, limit || 20);
      return textResult(result, `Retrieved ${result.messages.length} messages.`);
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("instagram_reply", {
    title: "Reply on Instagram",
    description: "Send a text reply in an existing Instagram DM conversation. Only use when the user explicitly asks to send or reply.",
    inputSchema: {
      conversation_id: z.string().min(1),
      text: z.string().min(1).max(1000),
    },
  }, async ({ conversation_id, text }) => {
    try {
      const [profile, conversation] = await Promise.all([
        getProfile(),
        metaGet(`/${encodeURIComponent(conversation_id)}`, { fields: "participants" }),
      ]);
      const recipient = participantsOf(conversation).find((p) => String(p.id) !== String(profile.id));
      if (!recipient?.id) throw new Error("Could not identify the other participant in this conversation.");
      const sent = await metaPost(`/${encodeURIComponent(profile.id)}/messages`, {
        recipient: { id: recipient.id },
        message: { text },
      });
      return textResult({ sent: true, recipient_id: sent?.recipient_id || recipient.id, message_id: sent?.message_id || null }, "Instagram message sent.");
    } catch (error) { return errorResult(error); }
  });

  return server;
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/check/:secret", async (req, res) => {
  if (!process.env.MCP_PATH_SECRET || req.params.secret !== process.env.MCP_PATH_SECRET) return res.status(404).json({ error: "not_found" });
  try {
    const profile = await getProfile();
    const conversations = await listConversations(1);
    res.json({ ok: true, username: profile?.username || null, instagram_id: profile?.id || null, conversations_api: true, sample_count: conversations.conversations.length });
  } catch (error) {
    res.status(502).json({ ok: false, ...publicError(error) });
  }
});

app.post("/mcp/:secret", async (req, res) => {
  if (!process.env.MCP_PATH_SECRET || req.params.secret !== process.env.MCP_PATH_SECRET) return res.status(404).end();
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request failed", publicError(error));
    if (!res.headersSent) res.status(500).json({ error: "mcp_request_failed" });
  }
});

app.get("/mcp/:secret", (_req, res) => res.status(405).set("Allow", "POST").end());
app.delete("/mcp/:secret", (_req, res) => res.status(405).set("Allow", "POST").end());

app.listen(PORT, "0.0.0.0", () => console.log(`Instagram ChatGPT bridge listening on ${PORT}`));
