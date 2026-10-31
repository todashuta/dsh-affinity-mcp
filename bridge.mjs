#!/usr/bin/env node
/**
 * affinity-bridge.mjs
 *
 * Affinity by Canva の内蔵 MCP サーバー（旧式 HTTP+SSE、IPv6 [::1]:6767）を
 * stdio の MCP サーバーとして DSH に見せるプロキシ。
 *
 * なぜ必要か:
 *   1. DSH の mcp-client は Streamable HTTP と stdio しか話せず、Affinity の
 *      SSE トランスポートへ直接つながらない（POST /sse が 405 になる）。
 *   2. Affinity は常時起動ではない。DSH 側の mcp-client は起動時に接続できな
 *      いとツールを登録せず、切断後も再接続を 10 回で諦めるため、Affinity を
 *      後から起動しても DSH を再起動するまでツールが戻らない。
 *   このブリッジは stdio プロセスとして常駐し、上流への接続を「ツール呼び出し
 *   のたび」に確立・回復する。DSH から見るとサーバーはずっと生きているので、
 *   ツール登録は維持されたまま、Affinity を起動した瞬間から使える。
 *
 * なぜ mcp-remote ではなく自前か: mcp-remote は stdio プロセス自体が上流の
 * 生死に引きずられる構成で、DSH の再接続上限もそのまま効く。オンデマンド
 * 再接続を成立させるには「DSH から見て生き続ける stdio サーバー」と
 * 「必要なときだけ張り直す上流接続」を分離する必要があるため。
 *
 * DSH の設定（cordis.patch.yml）:
 *
 *   - insert:
 *       - id: affinity-mcp
 *         name: '@deepseek-ai/dsh-mcp-client'
 *         config:
 *           serverName: affinity
 *           transport: stdio
 *           command: node
 *           args: ['C:/Users/<you>/.dsh/mcp/affinity-bridge.mjs']
 *
 * 環境変数:
 *   AFFINITY_MCP_URL           上流のベース URL（既定 http://[::1]:6767）
 *   AFFINITY_MCP_TIMEOUT_MS    ツール 1 回のタイムアウト（既定 120000）
 *   AFFINITY_MCP_CONNECT_MS    接続確立のタイムアウト（既定 10000）
 *
 * 依存なし。Node 18 以降（グローバルの fetch / AbortController）。
 * ログは stderr のみ。stdout には DSH 向けの JSON-RPC 行だけを流す。
 */

import process from 'node:process'
import readline from 'node:readline'

const BASE = (process.env.AFFINITY_MCP_URL ?? 'http://[::1]:6767').replace(/\/+$/, '')
const SSE_URL = `${BASE}/sse`
const CALL_TIMEOUT_MS = Number(process.env.AFFINITY_MCP_TIMEOUT_MS ?? 120_000)
const CONNECT_TIMEOUT_MS = Number(process.env.AFFINITY_MCP_CONNECT_MS ?? 10_000)
const PROTOCOL_VERSION = '2025-11-25'

const log = (...args) => console.error('[affinity-bridge]', ...args)

// ---------------------------------------------------------------------------
// 上流のツール定義。Affinity が落ちている間も tools/list を返せるよう、
// 既知の 11 ツールをここに持つ。接続できたら本物の tools/list で置き換える。
// ---------------------------------------------------------------------------
const KNOWN_TOOLS = [
  {
    name: 'add_sdk_hint',
    description: 'Add a hint to the preamble document so future sessions can be more efficient.',
    inputSchema: {
      properties: { hint: { type: 'string', description: 'The hint to add to the preamble.' } },
      type: 'object',
      required: ['hint'],
    },
  },
  {
    name: 'execute_script',
    description: "Execute Javascript and return the results. You MUST read the 'preamble' documentation before using this tool.",
    inputSchema: {
      properties: { script: { type: 'string', description: 'The Javascript to execute' } },
      type: 'object',
      required: ['script'],
    },
  },
  {
    name: 'list_library_scripts',
    description: 'List the names of the scripts in the script library.',
    inputSchema: { type: 'object' },
  },
  {
    name: 'list_sdk_documentation',
    description: 'List SDK documentation topics.',
    inputSchema: { type: 'object' },
  },
  {
    name: 'read_library_script',
    description: 'Read a script from the script library.',
    inputSchema: {
      properties: { title: { type: 'string', description: 'The title of the script to read.' } },
      type: 'object',
      required: ['title'],
    },
  },
  {
    name: 'read_sdk_documentation_topic',
    description: "Read SDK documentation topic. You MUST run this tool with the 'preamble' file before any other files.",
    inputSchema: {
      properties: { filename: { type: 'string', description: 'The SDK documentation filename from list_sdk_documentation' } },
      type: 'object',
      required: ['filename'],
    },
  },
  {
    name: 'render_selection',
    description: 'Render the currently selected nodes to a base64 encoded JPEG. The JPEG has a maximum dimension of 1024px, so may be downscaled.',
    inputSchema: {
      properties: { document_session_uuid: { type: 'string', description: 'The session Uuid of the document to render.' } },
      type: 'object',
      required: ['document_session_uuid'],
    },
  },
  {
    name: 'render_spread',
    description: 'Render a spread to a base64 encoded JPEG. The JPEG has a maximum dimension of 1024px, so may be downscaled.',
    inputSchema: {
      properties: {
        document_session_uuid: { type: 'string', description: 'The session Uuid of the document to render.' },
        spread_index: { type: 'number', description: 'The zero-based index of the spread to render.' },
      },
      type: 'object',
      required: ['document_session_uuid', 'spread_index'],
    },
  },
  {
    name: 'report_sdk_issue',
    description: 'Report an issue with the SDK to the Affinity. Be sure the issue is real before reporting.',
    inputSchema: {
      properties: {
        description: { type: 'string', description: 'A description of the SDK issue' },
        code: { type: 'string', description: 'JavaScript demonstrating the issue, if appropriate' },
      },
      type: 'object',
      required: ['description'],
    },
  },
  {
    name: 'save_script_to_library',
    description: 'Completed scripts can be saved to the Affinity script library for use later on.',
    inputSchema: {
      properties: {
        title: { type: 'string', description: 'The title of the script' },
        description: { type: 'string', description: 'A brief description of the script' },
        code: { type: 'string', description: 'The JavaScript itself' },
      },
      type: 'object',
      required: ['title', 'description', 'code'],
    },
  },
  {
    name: 'search_sdk_hints',
    description: 'Search a global pool of SDK hints from millions of other MCP sessions. Use it to check for existing solutions to problems you are facing.',
    inputSchema: {
      properties: { prompt: { type: 'string', description: 'A prompt describing the issue you are facing.' } },
      type: 'object',
      required: ['prompt'],
    },
  },
]

const STATUS_TOOL = {
  name: 'affinity_status',
  description: 'Report whether this bridge is connected to the Affinity app. Use it to check availability before running scripts.',
  inputSchema: { type: 'object', properties: {} },
}

// ---------------------------------------------------------------------------
// 状態
// ---------------------------------------------------------------------------
let endpoint = null
let abortController = null
let connected = false
let connecting = null
let lastError = null
let initializedByClient = false
let knownTools = null // 上流から取得した本物のツール一覧（接続成功時のみ）
const pending = new Map()
let sequence = 0

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

const reply = (id, result) => ({ jsonrpc: '2.0', id, result })
const failure = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })

// ---------------------------------------------------------------------------
// SSE トランスポート
// ---------------------------------------------------------------------------
function parseEvent(block) {
  let event = 'message'
  let data = ''
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data += line.slice(5).trim()
  }
  return { event, data }
}

/** SSE ストリームを読み、endpoint イベントの受信で resolve する。 */
async function openSse() {
  const controller = new AbortController()
  abortController = controller
  endpoint = null

  const response = await fetch(SSE_URL, {
    signal: controller.signal,
    headers: { accept: 'text/event-stream' },
  })
  if (!response.ok) throw new Error(`SSE HTTP ${response.status}`)
  if (!response.body) throw new Error('SSE response has no body')

  const endpointReady = new Promise((resolve, reject) => {
    const decoder = new TextDecoder()
    const reader = response.body.getReader()
    let buffer = ''

    const consume = () => {
      for (;;) {
        // Affinity は \r\n\r\n 区切りで返す。\n\n だけを見ると
        // endpoint イベントを取りこぼして接続タイムアウトになる。
        let index = buffer.indexOf('\r\n\r\n')
        let separator = 4
        if (index < 0) {
          index = buffer.indexOf('\n\n')
          separator = 2
        }
        if (index < 0) break
        const block = buffer.slice(0, index)
        buffer = buffer.slice(index + separator)
        const { event, data } = parseEvent(block)
        if (event === 'endpoint') {
          endpoint = data
          resolve()
        } else if (event === 'message' && data !== '') {
          let message
          try {
            message = JSON.parse(data)
          } catch {
            continue
          }
          if (message && message.id !== undefined && pending.has(message.id)) {
            const waiter = pending.get(message.id)
            pending.delete(message.id)
            waiter.resolve(message)
          }
        }
      }
    }

    const read = async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          consume()
        }
        reject(new Error('SSE stream ended'))
      } catch (error) {
        reject(error)
      } finally {
        // ストリームが終わったら接続済みフラグを落とし、次の呼び出しで
        // 再接続できるようにする。
        if (connected) log('upstream SSE stream ended')
        connected = false
        endpoint = null
      }
    }
    void read()
  })

  await Promise.race([
    endpointReady,
    new Promise((_, reject) => setTimeout(() => reject(new Error('SSE endpoint timeout')), CONNECT_TIMEOUT_MS)),
  ])
}

function closeSse() {
  try {
    abortController?.abort()
  } catch {
    // ignore
  }
  abortController = null
  endpoint = null
  for (const waiter of pending.values()) waiter.reject(new Error('upstream connection closed'))
  pending.clear()
}

async function post(payload) {
  if (endpoint === null) throw new Error('upstream is not connected')
  const url = new URL(endpoint, BASE)
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`POST HTTP ${response.status}: ${body.slice(0, 300)}`)
  }
  await response.arrayBuffer().catch(() => {})
}

function request(method, params, timeoutMs = CALL_TIMEOUT_MS) {
  const id = ++sequence
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`timeout waiting for ${method}`))
    }, timeoutMs)
    pending.set(id, {
      resolve: value => {
        clearTimeout(timer)
        resolve(value)
      },
      reject: error => {
        clearTimeout(timer)
        reject(error)
      },
    })
  })
  post({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }).catch(error => {
    const waiter = pending.get(id)
    if (waiter) {
      pending.delete(id)
      waiter.reject(error)
    }
  })
  return promise
}

// ---------------------------------------------------------------------------
// 接続管理
// ---------------------------------------------------------------------------
async function connect() {
  if (connected) return
  if (connecting !== null) return connecting

  connecting = (async () => {
    try {
      await openSse()
      const init = await request(
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'affinity-bridge', version: '1.0.0' },
        },
        CONNECT_TIMEOUT_MS,
      )
      if (init.error) throw new Error(init.error.message ?? 'upstream initialize failed')

      const listed = await request('tools/list', {}, CONNECT_TIMEOUT_MS)
      if (listed.result?.tools) knownTools = listed.result.tools

      await post({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => {})

      connected = true
      lastError = null
      log(`connected to ${SSE_URL}`)

      // 立ち上がった直後に DSH がツール一覧を取り直せるよう通知する
      if (initializedByClient) {
        write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
      }
    } catch (error) {
      connected = false
      lastError = error?.message ?? String(error)
      closeSse()
      throw error
    }
  })().finally(() => {
    connecting = null
  })

  return connecting
}

async function ensureConnected() {
  if (connected) return
  await connect()
}

async function callUpstream(name, args) {
  const response = await request('tools/call', { name, arguments: args ?? {} })
  if (!response) throw new Error('upstream returned an empty tools/call response')
  if (response.error) throw new Error(response.error.message ?? 'upstream tool call failed')
  return response.result ?? {}
}

function statusText() {
  const toolCount = (knownTools ?? KNOWN_TOOLS).length
  return [
    `connected: ${connected ? 'yes' : 'no'}`,
    `upstream: ${SSE_URL}`,
    `tools: ${toolCount}`,
    lastError === null ? 'lastError: none' : `lastError: ${lastError}`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// stdio 側の MCP ハンドラ
// ---------------------------------------------------------------------------
async function onRequest(message) {
  const { id, method } = message
  switch (method) {
    case 'initialize': {
      // 上流に繋がらなくても初期化は成功させる。これが「Affinity が落ちて
      // いても DSH にツールが見え続ける」ための要点。
      try {
        await ensureConnected()
      } catch (error) {
        log(`upstream unavailable at startup: ${error?.message ?? error}`)
      }
      return reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'affinity-bridge', version: '1.0.0' },
        instructions:
          "You MUST read the 'preamble' documentation with read_sdk_documentation_topic before using the Affinity SDK.",
      })
    }
    case 'ping':
      return reply(id, {})
    case 'tools/list': {
      // 接続できていれば本物、まだなら既知の定義。どちらでも応答する。
      const tools = knownTools ?? KNOWN_TOOLS
      return reply(id, { tools: [...tools, STATUS_TOOL] })
    }
    case 'tools/call': {
      const name = message.params?.name
      if (name === 'affinity_status') {
        return reply(id, { content: [{ type: 'text', text: statusText() }] })
      }
      try {
        await ensureConnected()
        const result = await callUpstream(name, message.params?.arguments)
        return reply(id, result)
      } catch (error) {
        const hint = connected ? '' : '\n(Affinity が起動していない可能性があります。起動後に再試行してください)'
        return failure(id, -32603, `${error?.message ?? String(error)}${hint}`)
      }
    }
    default:
      return failure(id, -32601, `unsupported method: ${method}`)
  }
}

async function handle(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return
  if (message.method === undefined) return
  if (message.id === undefined) {
    if (message.method === 'notifications/initialized') initializedByClient = true
    return
  }
  try {
    write(await onRequest(message))
  } catch (error) {
    write(failure(message.id, -32603, error?.message ?? String(error)))
  }
}

const input = readline.createInterface({ input: process.stdin })
input.on('line', line => {
  const trimmed = line.trim()
  if (trimmed === '') return
  let message
  try {
    message = JSON.parse(trimmed)
  } catch {
    log('ignoring a malformed JSON line')
    return
  }
  void handle(message)
})
