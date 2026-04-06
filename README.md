# WhatsApp LLM Agent

Minimal prototype: talk to Claude via WhatsApp. ~200 lines of code total.

## Architecture

```
Your Phone (WhatsApp) ──QR link──▶ Your Server (Node.js)
                                     ├── Baileys (WhatsApp Web WebSocket)
                                     ├── Message Router
                                     ├── INSTRUCTIONS.md (editable system prompt)
                                     ├── Chat History (JSON per contact)
                                     └── Anthropic SDK ──▶ api.anthropic.com
```

**Why this approach?**
- **Baileys** speaks WhatsApp Web's native WebSocket protocol — no Meta Business API, no webhooks, no ngrok, no public URL. Scan a QR code and go.
- **Node.js** is required because Baileys only exists in JS/TS. Python approaches need the Meta Business API which adds massive friction.
- **You need a running server** — any always-on machine (your PC, Mac Mini, $6 VPS). The process holds the WhatsApp WebSocket open.

## Quick Start

### 1. Prerequisites
- Node.js 18+ (`node --version`)
- An Anthropic API key ([console.anthropic.com](https://console.anthropic.com))
- A phone with WhatsApp

### 2. Install

```bash
git clone <this-repo>  # or copy the folder
cd whatsapp-llm-agent
npm install
```

### 3. Configure

```bash
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY
```

### 4. Run

```bash
npm start
```

A QR code appears in your terminal. Scan it with:
**WhatsApp → Settings → Linked Devices → Link a Device**

That's it. Send yourself a message (or have someone message you) and Claude responds.

## Customize

### Edit the agent's personality
Open `INSTRUCTIONS.md` in any text editor. Changes take effect on the **next message** — no restart needed. This is your system prompt.

### Restrict who can talk to it
Set `ALLOWED_NUMBERS` in `.env`:
```
ALLOWED_NUMBERS=15551234567,447700900000
```

### Change the model
```
MODEL=claude-sonnet-4-20250514
```

### Commands (in WhatsApp)
- `/reset` — Clear conversation history
- `/help` — Show available commands

## File Structure

```
whatsapp-llm-agent/
├── index.js            # Main bot (~200 lines)
├── INSTRUCTIONS.md     # ✏️  System prompt — edit this!
├── package.json
├── .env.example        # Copy to .env
├── .gitignore
├── auth/               # (auto-created) WhatsApp session keys
└── history/            # (auto-created) Chat history per contact
```

## Comparison with Alternatives

| Feature | This project | OpenClaw | Meta Business API |
|---------|-------------|----------|-------------------|
| Lines of code | ~200 | ~500k | ~300+ |
| Setup time | 2 min | 10-30 min | 1-2 hours |
| Needs public URL | No | No | Yes (webhook) |
| Needs Meta account | No | No | Yes |
| WhatsApp connection | Baileys (WS) | Baileys (WS) | Official API |
| Skills/tools | No | 50+ | DIY |
| Memory | Per-contact JSON | Sophisticated | DIY |
| Production-ready | Prototype | Yes | Yes |

## Security Notes

- **Baileys is unofficial** — it reverse-engineers WhatsApp Web. WhatsApp could break it or ban accounts using it. Don't use your primary number if that concerns you.
- **Auth keys** in `./auth` grant full WhatsApp access. Guard them.
- **API key** in `.env` — never commit this.
- For production use, consider OpenClaw or the official Meta Business API.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| QR code doesn't appear | Delete `./auth` folder and restart |
| "Connection closed" loop | Delete `./auth` folder and restart |
| "Rate limit" from Anthropic | Reduce message frequency or upgrade API plan |
| Long responses get cut off | They auto-split at 4000 chars |
| Want to change numbers | Set `ALLOWED_NUMBERS` in `.env` and restart |
