/**
 * discord-streaming — Claude Code Discord MCP plugin with Tier-2 progress streaming
 *
 * Provides three MCP tools:
 *   reply(chat_id, text)         — send final answer, pings user
 *   post_update(chat_id, text)   — edit working message silently (no ping)
 *   fetch_messages(channel, n)   — read recent history
 *
 * Setup: set DISCORD_BOT_TOKEN in your environment.
 * Install the bun process as a Claude Code MCP plugin — see README.md.
 */

import { Client, GatewayIntentBits, TextChannel, type Interaction } from 'discord.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const TOKEN = process.env.DISCORD_BOT_TOKEN
if (!TOKEN) {
  process.stderr.write('discord-streaming: DISCORD_BOT_TOKEN is required\n')
  process.exit(1)
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
})

// ── Tier-2 streaming state ───────────────────────────────────────────────────
// Maps chat_id → message_id of the current working message.
// post_update edits it in place; reply() clears it so the next task starts fresh.
const activeWorkingMsg = new Map<string, string>()

// ── Typing indicator ─────────────────────────────────────────────────────────
const typingIntervals = new Map<string, ReturnType<typeof setInterval>>()

function startTyping(channelId: string): void {
  if (typingIntervals.has(channelId)) return
  const send = () => {
    client.channels.fetch(channelId).then(ch => {
      if (ch && 'sendTyping' in ch) (ch as TextChannel).sendTyping().catch(() => {})
    }).catch(() => {})
  }
  send()
  typingIntervals.set(channelId, setInterval(send, 8000))
}

function stopTyping(channelId: string): void {
  const t = typingIntervals.get(channelId)
  if (t) { clearInterval(t); typingIntervals.delete(channelId) }
}

// ── Chunk long messages ───────────────────────────────────────────────────────
const MAX_CHUNK = 1900

function chunk(text: string): string[] {
  if (text.length <= MAX_CHUNK) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > MAX_CHUNK) {
    // Break at last newline within limit to avoid mid-word cuts
    const slice = remaining.slice(0, MAX_CHUNK)
    const nl = slice.lastIndexOf('\n')
    const cut = nl > MAX_CHUNK / 2 ? nl + 1 : MAX_CHUNK
    chunks.push(remaining.slice(0, cut))
    remaining = remaining.slice(cut)
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

// ── MCP server ────────────────────────────────────────────────────────────────
const mcp = new McpServer({ name: 'discord-streaming', version: '1.0.0' })

mcp.tool(
  'reply',
  'Send your final answer to Discord. Stops the typing indicator and pings the user. Use only for the completed response — use post_update for intermediate progress.',
  {
    chat_id: z.string().describe('Channel ID from the inbound message'),
    text: z.string().describe('Message content'),
    reply_to: z.string().optional().describe('Message ID to thread under'),
  },
  async ({ chat_id, text, reply_to }) => {
    stopTyping(chat_id)
    activeWorkingMsg.delete(chat_id)

    const ch = await client.channels.fetch(chat_id) as TextChannel
    const chunks = chunk(text)
    const sentIds: string[] = []
    for (let i = 0; i < chunks.length; i++) {
      const sent = await ch.send({
        content: chunks[i],
        ...(reply_to && i === 0 ? { reply: { messageReference: reply_to, failIfNotExists: false } } : {}),
      })
      sentIds.push(sent.id)
    }
    return {
      content: [{
        type: 'text' as const,
        text: sentIds.length === 1 ? `sent (id: ${sentIds[0]})` : `sent ${sentIds.length} chunks`,
      }],
    }
  }
)

mcp.tool(
  'post_update',
  'Post an intermediate progress update. Edits the current working message silently (no push notification) if one exists, otherwise posts a new one. Cleared automatically when reply() lands. Call after each significant step (SSH result, file read, API call) to narrate what you found and what you\'re doing next.',
  {
    chat_id: z.string().describe('Channel ID from the inbound message'),
    text: z.string().describe('Progress update text'),
  },
  async ({ chat_id, text }) => {
    const ch = await client.channels.fetch(chat_id) as TextChannel

    const existingId = activeWorkingMsg.get(chat_id)
    if (existingId) {
      try {
        const prev = await ch.messages.fetch(existingId)
        const edited = await prev.edit(text)
        return { content: [{ type: 'text' as const, text: `updated working message (id: ${edited.id})` }] }
      } catch {
        // Message deleted — fall through to post new
      }
    }
    const sent = await ch.send({ content: text })
    activeWorkingMsg.set(chat_id, sent.id)
    return { content: [{ type: 'text' as const, text: `posted working message (id: ${sent.id})` }] }
  }
)

mcp.tool(
  'fetch_messages',
  "Fetch recent messages from a Discord channel. Returns oldest-first with IDs.",
  {
    channel: z.string().describe('Channel ID'),
    limit: z.number().optional().describe('Max messages (default 20, max 100)'),
  },
  async ({ channel, limit = 20 }) => {
    const ch = await client.channels.fetch(channel) as TextChannel
    const msgs = await ch.messages.fetch({ limit: Math.min(limit, 100) })
    const me = client.user?.id
    const arr = [...msgs.values()].reverse()
    const out = arr.length === 0
      ? '(no messages)'
      : arr.map(m => {
          const who = m.author.id === me ? 'me' : m.author.username
          const text = m.content.replace(/[\r\n]+/g, ' ⏎ ')
          return `[${m.createdAt.toISOString()}] ${who}: ${text}  (id: ${m.id})`
        }).join('\n')
    return { content: [{ type: 'text' as const, text: out }] }
  }
)

// ── Inbound message handler ───────────────────────────────────────────────────
client.on('messageCreate', async msg => {
  if (msg.author.bot) return
  if (!msg.mentions.users.has(client.user!.id) && msg.channel.type !== 1 /* DM */) return

  const chat_id = msg.channelId
  startTyping(chat_id)

  mcp.server.notification({
    method: 'notifications/claude/channel',
    params: {
      content: msg.content,
      meta: {
        chat_id,
        message_id: msg.id,
        user: msg.author.username,
        user_id: msg.author.id,
        ts: msg.createdAt.toISOString(),
        instructions:
          'For multi-step tasks (SSH, file reads, searches, API calls), call post_update(chat_id, text) after each significant step to narrate progress. Edits a working message silently — no ping until reply() lands. Use reply() only for the final answer.',
      },
    },
  }).catch(() => {})
})

// ── Boot ─────────────────────────────────────────────────────────────────────
await mcp.connect(new StdioServerTransport())

let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  setTimeout(() => process.exit(0), 2000)
  void Promise.resolve(client.destroy()).finally(() => process.exit(0))
}
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

client.once('ready', c => {
  process.stderr.write(`discord-streaming: connected as ${c.user.tag}\n`)
})

client.login(TOKEN).catch(err => {
  process.stderr.write(`discord-streaming: login failed: ${err}\n`)
  process.exit(1)
})
