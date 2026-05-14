import express from "express";
import pino from "pino";
import { Boom } from "@hapi/boom";
import {
  default as makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} from "@whiskeysockets/baileys";
import path from "node:path";
import fs from "node:fs/promises";

const log = pino({ level: process.env.LOG_LEVEL || "info" });
const app = express();
app.use(express.json({ limit: "1mb" }));

const TOKEN = process.env.RAILWAY_TOKEN;
const AUTH_DIR = process.env.AUTH_DIR || "/data/auth";
const PORT = Number(process.env.PORT || 8080);

if (!TOKEN) { log.error("RAILWAY_TOKEN env var is required"); process.exit(1); }

/** session_id -> { sock, sessionMeta, lastQrAt } */
const sessions = new Map();

function auth(req, res, next) {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.status(401).json({ error: "unauthorized" });
  next();
}

async function postBack(meta, event) {
  if (!meta?.callback_url) return;
  try {
    await fetch(meta.callback_url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${meta.callback_token}`,
      },
      body: JSON.stringify({
        account_id: meta.account_id,
        session_id: meta.session_id,
        ...event,
      }),
    });
  } catch (e) {
    log.error({ err: String(e) }, "callback failed");
  }
}

async function startSocket(meta) {
  const dir = path.join(AUTH_DIR, meta.session_id);
  await fs.mkdir(dir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: log.child({ session: meta.session_id }),
    browser: ["HostStay", "Chrome", "120.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      await postBack(meta, {
        event_type: "qr",
        qr,
        qr_expires_at: new Date(Date.now() + 60_000).toISOString(),
      });
    }
    if (connection === "open") {
      const me = sock.user;
      await postBack(meta, {
        event_type: "connected",
        display_name: me?.name || me?.id,
      });
    }
    if (connection === "close") {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      await postBack(meta, {
        event_type: loggedOut ? "logged_out" : "disconnected",
        reason: lastDisconnect?.error?.message || `code:${code}`,
      });
      if (!loggedOut) {
        // Auto-reconnect with backoff
        setTimeout(() => startSocket(meta).catch((e) => log.error({ err: String(e) }, "reconnect failed")), 3000);
      } else {
        sessions.delete(meta.session_id);
      }
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    // Forward inbound messages back to HostStay (optional pipeline).
    if (m.type !== "notify") return;
    for (const msg of m.messages) {
      if (msg.key.fromMe) continue;
      await postBack(meta, {
        event_type: "message",
        message: {
          id: msg.key.id,
          from: msg.key.remoteJid,
          text: msg.message?.conversation || msg.message?.extendedTextMessage?.text || "",
          timestamp: msg.messageTimestamp,
        },
      });
    }
  });

  sessions.set(meta.session_id, { sock, meta });
  return sock;
}

app.get("/health", (_req, res) => res.json({ ok: true, sessions: sessions.size }));

app.post("/sessions/start", auth, async (req, res) => {
  const meta = req.body;
  if (!meta?.session_id) return res.status(400).json({ error: "session_id required" });
  if (sessions.has(meta.session_id)) {
    return res.json({ ok: true, status: "already_running" });
  }
  try {
    await startSocket(meta);
    res.json({ ok: true, status: "starting" });
  } catch (e) {
    log.error({ err: String(e) }, "start failed");
    res.status(500).json({ error: String(e) });
  }
});

app.post("/sessions/restart", auth, async (req, res) => {
  const meta = req.body;
  const existing = sessions.get(meta.session_id);
  if (existing) {
    try { existing.sock.end(); } catch {}
    sessions.delete(meta.session_id);
  }
  try {
    await startSocket(meta);
    res.json({ ok: true, status: "restarting" });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/sessions/disconnect", auth, async (req, res) => {
  const meta = req.body;
  const existing = sessions.get(meta.session_id);
  if (existing) {
    try { await existing.sock.logout(); } catch {}
    sessions.delete(meta.session_id);
  }
  try { await fs.rm(path.join(AUTH_DIR, meta.session_id), { recursive: true, force: true }); } catch {}
  res.json({ ok: true });
});

app.post("/sessions/send", auth, async (req, res) => {
  const { session_id, to, text } = req.body || {};
  const s = sessions.get(session_id);
  if (!s) return res.status(404).json({ error: "session_not_found" });
  try {
    const result = await s.sock.sendMessage(to, { text });
    res.json({ ok: true, id: result?.key?.id });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/sessions/:id/status", auth, (req, res) => {
  const s = sessions.get(req.params.id);
  res.json({ status: s ? "running" : "stopped" });
});

app.listen(PORT, () => log.info({ port: PORT }, "hoststay-whatsapp transport listening"));
