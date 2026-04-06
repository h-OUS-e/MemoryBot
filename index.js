import Anthropic from "@anthropic-ai/sdk";
import { Boom } from "@hapi/boom";
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import "dotenv/config";
import fs from "fs";
import path from "path";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { fileURLToPath } from "url";

// ─── Config ────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  // Anthropic
  model: process.env.MODEL || "claude-sonnet-4-20250514",
  maxTokens: parseInt(process.env.MAX_TOKENS || "1024"),

  // Allowed phone numbers (with country code, no +). Empty = allow all.
  // Example: ["15551234567"]
  allowedNumbers: process.env.ALLOWED_NUMBERS
    ? process.env.ALLOWED_NUMBERS.split(",").map((n) => n.trim())
    : [],

  // Paths
  authDir: path.join(__dirname, "auth"),
  historyDir: path.join(__dirname, "history"),
  instructionsPath: path.join(__dirname, "INSTRUCTIONS.md"),
};

// ─── Anthropic client ──────────────────────────────────────────
const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env

// ─── Instructions (system prompt) ──────────────────────────────
function loadInstructions() {
  try {
    return fs.readFileSync(CONFIG.instructionsPath, "utf-8").trim();
  } catch {
    return "You are a helpful AI assistant responding via WhatsApp. Keep responses concise and conversational.";
  }
}

// ─── Chat history (per-contact, on disk) ───────────────────────
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function historyPath(jid) {
  const safe = jid.replace(/[^a-zA-Z0-9]/g, "_");
  return path.join(CONFIG.historyDir, `${safe}.json`);
}

function loadHistory(jid) {
  try {
    return JSON.parse(fs.readFileSync(historyPath(jid), "utf-8"));
  } catch {
    return [];
  }
}

function saveHistory(jid, messages) {
  ensureDir(CONFIG.historyDir);
  // Keep last 50 messages to avoid unbounded growth
  const trimmed = messages.slice(-50);
  fs.writeFileSync(historyPath(jid), JSON.stringify(trimmed, null, 2));
}

// ─── LLM call ──────────────────────────────────────────────────
async function ask(jid, userMessage) {
  const history = loadHistory(jid);
  history.push({ role: "user", content: userMessage });

  const systemPrompt = loadInstructions();

  try {
    const response = await anthropic.messages.create({
      model: CONFIG.model,
      max_tokens: CONFIG.maxTokens,
      system: systemPrompt,
      messages: history,
    });

    const assistantText = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    history.push({ role: "assistant", content: assistantText });
    saveHistory(jid, history);

    return assistantText;
  } catch (err) {
    console.error("LLM error:", err.message);
    return `⚠️ Error calling LLM: ${err.message}`;
  }
}

// ─── Access control ────────────────────────────────────────────
function isAllowed(jid) {
  if (CONFIG.allowedNumbers.length === 0) return true;
  // jid format: "15551234567@s.whatsapp.net"
  const number = jid.split("@")[0];
  return CONFIG.allowedNumbers.includes(number);
}

// ─── WhatsApp connection ───────────────────────────────────────
async function startBot() {
  ensureDir(CONFIG.authDir);
  const { state, saveCreds } = await useMultiFileAuthState(CONFIG.authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    browser: ["WhatsApp LLM Agent", "Chrome", "1.0.0"],
  });

  // Save auth credentials on update
  sock.ev.on("creds.update", saveCreds);

  // Handle connection events
  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrcode.generate(qr, { small: true });
      console.log(
        "\n📱 Scan the QR code above with WhatsApp → Linked Devices → Link a Device\n",
      );
    }

    if (connection === "open") {
      console.log("✅ Connected to WhatsApp!");
      console.log(`📋 Instructions loaded from: ${CONFIG.instructionsPath}`);
      console.log(`🤖 Model: ${CONFIG.model}`);
      console.log(
        `🔒 Allowed numbers: ${
          CONFIG.allowedNumbers.length
            ? CONFIG.allowedNumbers.join(", ")
            : "ALL (set ALLOWED_NUMBERS to restrict)"
        }`,
      );
      console.log("\n💬 Waiting for messages...\n");
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(
        `Connection closed. ${shouldReconnect ? "Reconnecting..." : "Logged out. Delete ./auth and restart."}`,
      );
      if (shouldReconnect) startBot();
    }
  });

  // Handle incoming messages
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      // Skip own messages and status broadcasts
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid === "status@broadcast") continue;

      // Extract text content
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        null;

      if (!text) continue; // Skip non-text messages (images, etc.)

      const jid = msg.key.remoteJid;
      const sender = msg.pushName || jid.split("@")[0];

      // Access control
      if (!isAllowed(jid)) {
        console.log(`🚫 Blocked message from ${sender} (${jid})`);
        continue;
      }

      console.log(`📩 ${sender}: ${text}`);

      // Special commands
      if (text.toLowerCase() === "/reset") {
        saveHistory(jid, []);
        await sock.sendMessage(jid, {
          text: "🔄 Conversation history cleared.",
        });
        console.log(`🔄 Reset history for ${sender}`);
        continue;
      }

      if (text.toLowerCase() === "/help") {
        await sock.sendMessage(jid, {
          text: [
            "🤖 *WhatsApp LLM Agent*",
            "",
            "Just send me a message and I'll respond using AI.",
            "",
            "Commands:",
            "/reset — Clear conversation history",
            "/help — Show this message",
          ].join("\n"),
        });
        continue;
      }

      // Show typing indicator
      await sock.presenceSubscribe(jid);
      await sock.sendPresenceUpdate("composing", jid);

      // Get LLM response
      const reply = await ask(jid, text);

      // Send response (split if too long for WhatsApp)
      const MAX_MSG_LEN = 4000;
      if (reply.length <= MAX_MSG_LEN) {
        await sock.sendMessage(jid, { text: reply });
      } else {
        // Split into chunks
        const chunks = [];
        for (let i = 0; i < reply.length; i += MAX_MSG_LEN) {
          chunks.push(reply.slice(i, i + MAX_MSG_LEN));
        }
        for (const chunk of chunks) {
          await sock.sendMessage(jid, { text: chunk });
        }
      }

      await sock.sendPresenceUpdate("available", jid);
      console.log(`🤖 Replied to ${sender} (${reply.length} chars)`);
    }
  });
}

// ─── Start ─────────────────────────────────────────────────────
console.log(`
╔══════════════════════════════════════╗
║   WhatsApp LLM Agent                ║
║   Baileys + Anthropic Claude        ║
╚══════════════════════════════════════╝
`);

startBot().catch(console.error);
