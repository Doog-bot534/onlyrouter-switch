// ─────────────────────────────────────────────────────────────────────────
// OnlyRouter Switch · 本地翻译网关
//
// 在 127.0.0.1 起一个 HTTP 服务，把 Codex 的 Responses API 请求翻译成
// Chat Completions 转发到 OnlyRouter，再把（流式）响应翻译回 Responses 事件流。
// 解决 Codex 只会发 wire_api=responses、而 DeepSeek/Kimi 等上游只有 chat 的 404 问题。
//
// 关键契约（经 openai/codex 源码与 MetaFARS/codex-relay 验证，勿随意改）：
//   · Codex 无状态：store:false、无 previous_response_id、每轮全量 input[] 重发 → 网关无状态即可。
//   · 终止信号唯一：response.completed，且必须带 usage。
//   · assistant message item 必须带 id + status（否则下一轮回放历史校验报错，issue #12669）。
//   · 流式工具调用：按 index 累积，流结束后一次性 emit（Codex 对 arguments 分片敏感）。
//   · reasoning input item 要丢弃，不能转成 chat 消息。
//   · 未知 Responses 事件会被 Codex 忽略 → 不发 reasoning 事件是安全的。
// ─────────────────────────────────────────────────────────────────────────

const http = require('http')
const crypto = require('crypto')
const security = require('./security')
const { Router, detectModality } = require('./routing')

const DEFAULT_UPSTREAM = 'https://onlyrouter.ai/v1'

// 智能路由器在网关生命周期内常驻（会话粘性/迟滞需要跨请求状态）
const router = new Router()

// 模型表缓存（智能/模态路由用），公开接口无需鉴权
let _models = { at: 0, list: [] }
async function getModels() {
  if (Date.now() - _models.at < 60000 && _models.list.length) return _models.list
  try {
    const r = await fetch('https://onlyrouter.ai/api/models')
    const data = await r.json()
    const raw = Array.isArray(data) ? data : (data.data || [])
    const list = raw.filter(m => m.is_active).map(m => ({
      name: m.name, model_type: m.model_type || 'text',
      input_price: numOf(m.input_price), output_price: numOf(m.output_price),
      cache_read_price: numOf(m.cache_read_price), cache_write_price: numOf(m.cache_write_price),
      max_output_tokens: m.max_output_tokens || null,
    }))
    if (list.length) _models = { at: Date.now(), list }
  } catch {}
  return _models.list
}
function numOf(v) { return v == null || v === '' || isNaN(v) ? null : Number(v) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ─── 上游协议识别 ──────────────────────────────────────────────────────────
// 实测(2026-06-25)：OnlyRouter 上模型按名字后缀走不同协议，模型表里无字段标识，只能按名判。
//   · `*-ab` 的 Claude（Anthropic 直连渠道，如 claude-opus-4-8-ab）：只认 /v1/messages，
//     走 /chat/completions 或 /responses 都返回 400 "not configured for openai/responses protocol"。
//   · 其余（gpt-*、deepseek-*、claude-*-openrouter 等）：走 /chat/completions。
// 因此 -ab 的 Claude 必须用 messages 协议，网关在此做请求/响应的二次翻译（chat ↔ anthropic）。
function isAnthropicNative(model) {
  return /claude/i.test(model || '') && /-ab$/i.test(model || '')
}

// chat 请求体 → anthropic /v1/messages 请求体（含 system 抽离、tools、tool_calls、tool 结果转换）
function chatToAnthropic(chatBody) {
  const sys = []
  const messages = []
  for (const m of chatBody.messages || []) {
    if (!m) continue
    if (m.role === 'system') { sys.push(typeof m.content === 'string' ? m.content : flattenText(m.content)); continue }
    if (m.role === 'tool') {
      // chat 的 tool 结果 → anthropic 的 user/tool_result block
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }] })
      continue
    }
    if (m.role === 'assistant') {
      const blocks = []
      if (m.content) blocks.push({ type: 'text', text: typeof m.content === 'string' ? m.content : flattenText(m.content) })
      if (Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) {
        let input = {}
        try { input = JSON.parse((tc.function && tc.function.arguments) || '{}') } catch {}
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function && tc.function.name, input })
      }
      messages.push({ role: 'assistant', content: blocks.length ? blocks : '' })
      continue
    }
    // user：字符串直传；含图片的 parts → anthropic image block
    if (typeof m.content === 'string') { messages.push({ role: 'user', content: m.content }); continue }
    if (Array.isArray(m.content)) {
      const blocks = m.content.map(p => {
        if (!p) return null
        if (p.type === 'text') return { type: 'text', text: p.text || '' }
        if (p.type === 'image_url') {
          const url = (p.image_url && p.image_url.url) || p.image_url
          return { type: 'image', source: { type: 'url', url } }
        }
        return null
      }).filter(Boolean)
      messages.push({ role: 'user', content: blocks.length ? blocks : '' })
      continue
    }
    messages.push({ role: 'user', content: String(m.content || '') })
  }
  const out = {
    model: chatBody.model,
    max_tokens: chatBody.max_tokens || 8192,   // anthropic 必填；缺省给个安全上限
    messages,
    stream: !!chatBody.stream,
  }
  if (sys.length) out.system = sys.join('\n\n')
  if (chatBody.temperature != null) out.temperature = chatBody.temperature
  if (chatBody.top_p != null) out.top_p = chatBody.top_p
  if (Array.isArray(chatBody.tools) && chatBody.tools.length) {
    out.tools = chatBody.tools.map(t => {
      const f = t.function || t
      return { name: f.name, description: f.description, input_schema: f.parameters || { type: 'object', properties: {} } }
    })
  }
  return out
}

// anthropic 非流式响应 → chat 响应（供下游 chatToResponses 复用，零额外分支）
function anthropicToChat(a) {
  const blocks = (a && a.content) || []
  let text = ''
  const toolCalls = []
  for (const b of blocks) {
    if (b.type === 'text') text += b.text || ''
    else if (b.type === 'tool_use') toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } })
  }
  const message = { role: 'assistant', content: text || null }
  if (toolCalls.length) message.tool_calls = toolCalls
  const u = a && a.usage
  return {
    model: a && a.model,
    choices: [{ index: 0, message, finish_reason: (a && a.stop_reason) === 'tool_use' ? 'tool_calls' : 'stop' }],
    usage: u ? { prompt_tokens: u.input_tokens || 0, completion_tokens: u.output_tokens || 0, total_tokens: (u.input_tokens || 0) + (u.output_tokens || 0) } : null,
  }
}

// ─── 跨家族（Claude Code 选了 gpt 等 chat-only 模型）：anthropic messages ↔ chat 镜像翻译 ──
// Claude Code 只会发 anthropic /v1/messages；若目标模型只支持 chat completions，则需双向翻译。

// anthropic messages 请求 → chat 请求体（chatToAnthropic 的逆向）
function anthropicReqToChat(body) {
  const messages = []
  // system 可为字符串或 block 数组
  if (body.system) {
    const sysText = typeof body.system === 'string'
      ? body.system
      : (Array.isArray(body.system) ? body.system.map(b => (b && b.text) || '').join('') : '')
    if (sysText) messages.push({ role: 'system', content: sysText })
  }
  for (const m of body.messages || []) {
    if (!m) continue
    const c = m.content
    // 字符串内容直传
    if (typeof c === 'string') { messages.push({ role: m.role, content: c }); continue }
    if (!Array.isArray(c)) continue
    if (m.role === 'assistant') {
      // assistant：text block 合并为 content，tool_use block → tool_calls
      let text = ''
      const toolCalls = []
      for (const b of c) {
        if (!b) continue
        if (b.type === 'text') text += b.text || ''
        else if (b.type === 'tool_use') toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } })
      }
      const msg = { role: 'assistant', content: text || null }
      if (toolCalls.length) msg.tool_calls = toolCalls
      messages.push(msg)
      continue
    }
    // user：可能混有 text / image / tool_result。tool_result 要拆成独立的 role:'tool' 消息（chat 要求）。
    const parts = []
    for (const b of c) {
      if (!b) continue
      if (b.type === 'tool_result') {
        // 先把已积累的普通 parts 作为一条 user 消息发出，再发 tool 消息，保持顺序
        if (parts.length) { messages.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts.slice() }); parts.length = 0 }
        const resultText = typeof b.content === 'string'
          ? b.content
          : (Array.isArray(b.content) ? b.content.map(x => (x && x.text) || '').join('') : JSON.stringify(b.content || ''))
        messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: resultText })
      } else if (b.type === 'text') {
        parts.push({ type: 'text', text: b.text || '' })
      } else if (b.type === 'image') {
        const src = b.source || {}
        const url = src.type === 'url' ? src.url : (src.type === 'base64' ? `data:${src.media_type};base64,${src.data}` : null)
        if (url) parts.push({ type: 'image_url', image_url: { url } })
      }
    }
    if (parts.length) messages.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts })
  }
  const chat = { model: body.model, messages, stream: !!body.stream }
  if (body.stream) chat.stream_options = { include_usage: true }
  if (body.temperature != null) chat.temperature = body.temperature
  if (body.top_p != null) chat.top_p = body.top_p
  if (body.max_tokens != null) chat.max_tokens = body.max_tokens
  if (Array.isArray(body.tools) && body.tools.length) {
    chat.tools = body.tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema || { type: 'object', properties: {} } },
    }))
  }
  if (body.tool_choice) {
    const tc = body.tool_choice
    if (tc.type === 'auto') chat.tool_choice = 'auto'
    else if (tc.type === 'any') chat.tool_choice = 'required'
    else if (tc.type === 'tool' && tc.name) chat.tool_choice = { type: 'function', function: { name: tc.name } }
  }
  return chat
}

// chat 非流式响应 → anthropic Message 对象（content: text + tool_use blocks）
function chatRespToAnthropic(chat, model) {
  const msg = (chat.choices && chat.choices[0] && chat.choices[0].message) || {}
  const content = []
  if (msg.content) content.push({ type: 'text', text: typeof msg.content === 'string' ? msg.content : flattenText(msg.content) })
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let input = {}
      try { input = JSON.parse((tc.function && tc.function.arguments) || '{}') } catch {}
      content.push({ type: 'tool_use', id: tc.id || rid('toolu_'), name: tc.function && tc.function.name, input })
    }
  }
  const fr = chat.choices && chat.choices[0] && chat.choices[0].finish_reason
  const stop_reason = fr === 'tool_calls' ? 'tool_use' : (fr === 'length' ? 'max_tokens' : 'end_turn')
  const u = chat.usage
  return {
    id: rid('msg_'),
    type: 'message',
    role: 'assistant',
    model: model || chat.model,
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: (u && u.prompt_tokens) || 0, output_tokens: (u && u.completion_tokens) || 0 },
  }
}

// 渠道故障转移：上游瞬时错误(429/5xx)或网络异常时自动重试（给 OnlyRouter 换健康渠道的机会）；
// 仍失败则依次换备用模型。返回 { res, model, native } 或 { res:null, tries }。
// native=true 表示该响应是 anthropic /v1/messages 格式（下游需走 anthropic 翻译路径）。
// 流式响应一旦 200 即提交，不中途重试。
const TRANSIENT = [408, 425, 429, 500, 502, 503, 504]
async function forwardChat(upstream, auth, chatBody, wantStream, alternates) {
  const models = [chatBody.model, ...(alternates || []).filter(m => m && m !== chatBody.model)]
  const tries = []
  for (const model of models) {
    const native = isAnthropicNative(model)
    const path = native ? '/messages' : '/chat/completions'
    const body = native
      ? chatToAnthropic(Object.assign({}, chatBody, { model }))
      : Object.assign({}, chatBody, { model })
    const headers = { 'Content-Type': 'application/json', Authorization: auth, Accept: wantStream ? 'text/event-stream' : 'application/json' }
    if (native) headers['anthropic-version'] = '2023-06-01'
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(upstream + path, { method: 'POST', headers, body: JSON.stringify(body) })
        if (r.ok) return { res: r, model, native, tries }
        if (!TRANSIENT.includes(r.status)) return { res: r, model, native, tries }  // 非瞬时错误(如400/401)：直接返回，不重试
        tries.push(`${model} HTTP ${r.status}`)
        await sleep(300 * (attempt + 1))
      } catch (e) {
        tries.push(`${model} ${e && e.message}`)
        await sleep(300 * (attempt + 1))
      }
    }
  }
  return { res: null, tries }
}

// 对翻译后的 chat messages 做出站脱敏（字符串与文本 part 都覆盖）
function redactMessages(messages, store) {
  let total = 0
  for (const m of messages) {
    if (typeof m.content === 'string') {
      const r = security.redact(m.content, store); m.content = r.text; total += r.count
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part && typeof part.text === 'string') {
          const r = security.redact(part.text, store); part.text = r.text; total += r.count
        }
      }
    }
  }
  return total
}

function rid(prefix) {
  return prefix + crypto.randomBytes(16).toString('hex')
}

function nowSec() {
  return Math.floor(Date.now() / 1000)
}

// ─── 请求翻译：Responses → Chat Completions ──────────────────────────────
function responsesToChat(body) {
  const systemMsgs = []
  const convo = []

  if (body.instructions) {
    systemMsgs.push({ role: 'system', content: String(body.instructions) })
  }

  const input = body.input
  if (typeof input === 'string') {
    convo.push({ role: 'user', content: input })
  } else if (Array.isArray(input)) {
    for (const item of input) {
      const t = item && item.type
      if (t === 'reasoning') {
        // 思维 item 不回放，丢弃，否则会污染成空消息
        continue
      } else if (t === 'function_call') {
        convo.push({
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: item.call_id || item.id,
            type: 'function',
            function: { name: item.name, arguments: item.arguments || '' },
          }],
        })
      } else if (t === 'function_call_output') {
        convo.push({
          role: 'tool',
          tool_call_id: item.call_id,
          content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output),
        })
      } else if (t === 'message' || item.role) {
        const role = item.role || 'user'
        const content = contentToChat(item.content)
        // 夹在工具调用之间的 system/developer 消息会破坏 assistant→tool 顺序，移到最前
        if (role === 'system' || role === 'developer') {
          systemMsgs.push({ role: 'system', content: typeof content === 'string' ? content : flattenText(item.content) })
        } else {
          convo.push({ role, content })
        }
      }
    }
  }

  const messages = systemMsgs.concat(convo)

  const chat = { model: body.model, messages, stream: !!body.stream }
  if (body.stream) chat.stream_options = { include_usage: true }
  if (body.temperature != null) chat.temperature = body.temperature
  if (body.top_p != null) chat.top_p = body.top_p
  if (body.max_output_tokens != null) chat.max_tokens = body.max_output_tokens
  if (Array.isArray(body.tools) && body.tools.length) {
    chat.tools = body.tools.map(toChatTool).filter(Boolean)
  }
  if (body.tool_choice && body.tool_choice !== 'auto') chat.tool_choice = mapToolChoice(body.tool_choice)
  if (body.parallel_tool_calls != null) chat.parallel_tool_calls = body.parallel_tool_calls
  return chat
}

// Responses 的 content 数组 → chat content（纯文本则合并成字符串，含图片则用 parts 数组）
function contentToChat(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return String(content)
  const parts = []
  let hasImage = false
  for (const p of content) {
    if (!p) continue
    if (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text') {
      parts.push({ type: 'text', text: p.text || '' })
    } else if (p.type === 'input_image') {
      hasImage = true
      const url = p.image_url || (p.image_url && p.image_url.url) || p.url
      parts.push({ type: 'image_url', image_url: { url: typeof url === 'string' ? url : (url && url.url) } })
    }
  }
  if (!hasImage) return parts.map(p => p.text || '').join('')
  return parts
}

function flattenText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(p => (p && (p.text || '')) || '').join('')
}

function toChatTool(t) {
  if (!t) return null
  if (t.type && t.type !== 'function') return null // 暂只转 function 工具
  const f = t.function || t // Responses 把字段扁平在 tool 上；兼容已嵌套
  return {
    type: 'function',
    function: {
      name: f.name,
      description: f.description,
      parameters: f.parameters || { type: 'object', properties: {} },
    },
  }
}

function mapToolChoice(tc) {
  if (typeof tc === 'string') return tc
  if (tc && tc.type === 'function') {
    const name = tc.name || (tc.function && tc.function.name)
    return { type: 'function', function: { name } }
  }
  return tc
}

function mapUsage(u) {
  if (!u) return { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
  return {
    input_tokens: u.prompt_tokens || 0,
    output_tokens: u.completion_tokens || 0,
    total_tokens: u.total_tokens || ((u.prompt_tokens || 0) + (u.completion_tokens || 0)),
  }
}

// ─── 响应翻译（非流式）：Chat → Responses ────────────────────────────────
function chatToResponses(chat, fallbackModel) {
  const msg = (chat.choices && chat.choices[0] && chat.choices[0].message) || {}
  const output = []
  if (msg.content) {
    output.push(messageItem(msg.content))
  }
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      output.push({
        type: 'function_call',
        id: rid('fc_'),
        call_id: tc.id,
        name: tc.function && tc.function.name,
        arguments: (tc.function && tc.function.arguments) || '',
        status: 'completed',
      })
    }
  }
  return {
    id: rid('resp_'),
    object: 'response',
    created_at: chat.created || nowSec(),
    status: 'completed',
    model: chat.model || fallbackModel,
    output,
    usage: mapUsage(chat.usage),
  }
}

function messageItem(text) {
  return {
    id: rid('msg_'),
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  }
}

// ─── SSE 写出 ─────────────────────────────────────────────────────────────
function sse(res, type, obj) {
  res.write('event: ' + type + '\n')
  res.write('data: ' + JSON.stringify(Object.assign({ type }, obj)) + '\n\n')
}

function baseResponse(id, status, model, output, usage) {
  const r = { id, object: 'response', created_at: nowSec(), status, model, output: output || [] }
  if (usage) r.usage = usage
  return r
}

// ─── 响应翻译（流式）：消费上游 chat SSE，吐出 Responses 事件 ───────────────
async function streamChatToResponses(upstreamRes, res, model, hooks) {
  hooks = hooks || {}
  const respId = rid('resp_')
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  sse(res, 'response.created', { response: baseResponse(respId, 'in_progress', model) })

  // 累积状态
  const msgId = rid('msg_')
  let msgAdded = false
  let text = ''
  const toolCalls = [] // [{id,name,args}] 按 index
  let usage = null
  let finished = false

  const decoder = new TextDecoder()
  let buf = ''

  function handleLine(line) {
    line = line.trim()
    if (!line || !line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (data === '[DONE]') return
    let chunk
    try { chunk = JSON.parse(data) } catch { return }
    if (chunk.usage) usage = chunk.usage
    const choice = chunk.choices && chunk.choices[0]
    if (!choice) return
    const delta = choice.delta || {}

    if (delta.content) {
      const piece = hooks.onText ? hooks.onText(delta.content) : delta.content
      if (piece) {
        if (!msgAdded) {
          msgAdded = true
          sse(res, 'response.output_item.added', {
            output_index: 0,
            item: { id: msgId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
          })
        }
        text += piece
        sse(res, 'response.output_text.delta', { item_id: msgId, output_index: 0, content_index: 0, delta: piece })
      }
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const i = tc.index != null ? tc.index : 0
        if (!toolCalls[i]) toolCalls[i] = { id: null, name: '', args: '' }
        if (tc.id) toolCalls[i].id = tc.id
        if (tc.function && tc.function.name) toolCalls[i].name += tc.function.name
        if (tc.function && tc.function.arguments) toolCalls[i].args += tc.function.arguments
      }
    }

    if (choice.finish_reason) finished = true
  }

  try {
    for await (const part of upstreamRes.body) {
      buf += decoder.decode(part, { stream: true })
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        handleLine(line)
      }
    }
    if (buf) handleLine(buf)
  } catch (e) {
    // 上游断流且未正常结束：发 response.failed，不可把半截工具调用当历史
    sse(res, 'response.failed', {
      response: Object.assign(baseResponse(respId, 'failed', model), { error: { message: 'upstream stream error: ' + (e && e.message) } }),
    })
    res.end()
    return
  }

  // 收尾前：冲刷安全 hook 里跨 chunk 缓冲的尾部（未闭合占位符等）
  if (hooks.flush) {
    const tail = hooks.flush()
    if (tail) {
      if (!msgAdded) {
        msgAdded = true
        sse(res, 'response.output_item.added', { output_index: 0, item: { id: msgId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } })
      }
      text += tail
      sse(res, 'response.output_text.delta', { item_id: msgId, output_index: 0, content_index: 0, delta: tail })
    }
  }

  // 收尾：message item done
  const output = []
  if (msgAdded) {
    const item = { id: msgId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }
    sse(res, 'response.output_item.done', { output_index: 0, item })
    output.push(item)
  }
  // 工具调用：流结束后一次性 emit
  let idx = msgAdded ? 1 : 0
  for (const tc of toolCalls) {
    if (!tc) continue
    const fcId = rid('fc_')
    const args = hooks.restoreFull ? hooks.restoreFull(tc.args) : tc.args
    const item = { id: fcId, type: 'function_call', call_id: tc.id || fcId, name: tc.name, arguments: args, status: 'completed' }
    sse(res, 'response.output_item.added', { output_index: idx, item: Object.assign({}, item, { status: 'in_progress', arguments: '' }) })
    sse(res, 'response.function_call_arguments.delta', { item_id: fcId, output_index: idx, delta: args })
    sse(res, 'response.output_item.done', { output_index: idx, item })
    output.push(item)
    idx++
  }

  sse(res, 'response.completed', { response: baseResponse(respId, 'completed', model, output, mapUsage(usage)) })
  res.end()
}

// ─── 响应翻译（流式）：消费上游 anthropic SSE，吐出 Responses 事件 ───────────
// 用于 -ab 的 Claude（只走 /v1/messages）。事件：content_block_delta(text/input_json) → 文本/工具增量。
async function streamAnthropicToResponses(upstreamRes, res, model, hooks) {
  hooks = hooks || {}
  const respId = rid('resp_')
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  sse(res, 'response.created', { response: baseResponse(respId, 'in_progress', model) })

  const msgId = rid('msg_')
  let msgAdded = false
  let text = ''
  const toolBlocks = {}   // index → { id, name, args }
  let usage = null

  function handleEvent(data) {
    let ev
    try { ev = JSON.parse(data) } catch { return }
    const t = ev.type
    if (t === 'content_block_start' && ev.content_block && ev.content_block.type === 'tool_use') {
      toolBlocks[ev.index] = { id: ev.content_block.id, name: ev.content_block.name || '', args: '' }
    } else if (t === 'content_block_delta' && ev.delta) {
      if (ev.delta.type === 'text_delta') {
        const piece = hooks.onText ? hooks.onText(ev.delta.text || '') : (ev.delta.text || '')
        if (piece) {
          if (!msgAdded) {
            msgAdded = true
            sse(res, 'response.output_item.added', { output_index: 0, item: { id: msgId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } })
          }
          text += piece
          sse(res, 'response.output_text.delta', { item_id: msgId, output_index: 0, content_index: 0, delta: piece })
        }
      } else if (ev.delta.type === 'input_json_delta' && toolBlocks[ev.index]) {
        toolBlocks[ev.index].args += ev.delta.partial_json || ''
      }
    } else if (t === 'message_delta' && ev.usage) {
      usage = Object.assign(usage || {}, ev.usage)
    } else if (t === 'message_start' && ev.message && ev.message.usage) {
      usage = Object.assign(usage || {}, ev.message.usage)
    }
  }

  const decoder = new TextDecoder()
  let buf = ''
  try {
    for await (const part of upstreamRes.body) {
      buf += decoder.decode(part, { stream: true })
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line.startsWith('data:')) handleEvent(line.slice(5).trim())
      }
    }
  } catch (e) {
    sse(res, 'response.failed', { response: Object.assign(baseResponse(respId, 'failed', model), { error: { message: 'upstream stream error: ' + (e && e.message) } }) })
    res.end()
    return
  }

  if (hooks.flush) {
    const tail = hooks.flush()
    if (tail) {
      if (!msgAdded) { msgAdded = true; sse(res, 'response.output_item.added', { output_index: 0, item: { id: msgId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } }) }
      text += tail
      sse(res, 'response.output_text.delta', { item_id: msgId, output_index: 0, content_index: 0, delta: tail })
    }
  }

  const output = []
  if (msgAdded) {
    const item = { id: msgId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }
    sse(res, 'response.output_item.done', { output_index: 0, item })
    output.push(item)
  }
  let idx = msgAdded ? 1 : 0
  for (const k of Object.keys(toolBlocks)) {
    const tc = toolBlocks[k]
    const fcId = rid('fc_')
    const args = hooks.restoreFull ? hooks.restoreFull(tc.args) : tc.args
    const item = { id: fcId, type: 'function_call', call_id: tc.id || fcId, name: tc.name, arguments: args, status: 'completed' }
    sse(res, 'response.output_item.added', { output_index: idx, item: Object.assign({}, item, { status: 'in_progress', arguments: '' }) })
    sse(res, 'response.function_call_arguments.delta', { item_id: fcId, output_index: idx, delta: args })
    sse(res, 'response.output_item.done', { output_index: idx, item })
    output.push(item)
    idx++
  }
  const u = usage ? { prompt_tokens: usage.input_tokens || 0, completion_tokens: usage.output_tokens || 0, total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0) } : null
  sse(res, 'response.completed', { response: baseResponse(respId, 'completed', model, output, mapUsage(u)) })
  res.end()
}

// ─── 响应翻译（流式）：消费上游 chat SSE，吐出 anthropic messages SSE ──────────
// 用于 Claude Code 跨家族（选了 gpt 等 chat-only 模型）。事件序列遵循 anthropic 规范：
//   message_start → [content_block_start + delta… + content_block_stop]… → message_delta → message_stop
// 文本块 index 0；工具调用各占一个 block，input 用 input_json_delta 分片回放。
function anthSse(res, type, obj) {
  res.write('event: ' + type + '\n')
  res.write('data: ' + JSON.stringify(Object.assign({ type }, obj)) + '\n\n')
}
async function streamChatToAnthropic(upstreamRes, res, model, hooks) {
  hooks = hooks || {}
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  const msgId = rid('msg_')
  anthSse(res, 'message_start', { message: { id: msgId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })

  let textOpen = false          // 文本 block(index 0) 是否已 start
  let textClosed = false
  let nextIndex = 0             // 下一个 content block 的 index
  let textIndex = -1
  const toolBlocks = {}         // chat tool_calls index → { anthIndex, started }
  let usage = null
  let finishReason = null

  function ensureTextBlock() {
    if (!textOpen) {
      textIndex = nextIndex++
      anthSse(res, 'content_block_start', { index: textIndex, content_block: { type: 'text', text: '' } })
      textOpen = true
    }
  }
  function closeTextBlock() {
    if (textOpen && !textClosed) { anthSse(res, 'content_block_stop', { index: textIndex }); textClosed = true }
  }

  function handleChunk(chunk) {
    if (chunk.usage) usage = chunk.usage
    const choice = chunk.choices && chunk.choices[0]
    if (!choice) return
    const delta = choice.delta || {}
    if (delta.content) {
      const piece = hooks.onText ? hooks.onText(delta.content) : delta.content
      if (piece) { ensureTextBlock(); anthSse(res, 'content_block_delta', { index: textIndex, delta: { type: 'text_delta', text: piece } }) }
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const ci = tc.index != null ? tc.index : 0
        if (!toolBlocks[ci]) {
          // 工具块开始前，先关掉文本块（anthropic 要求块顺序闭合）
          closeTextBlock()
          const anthIndex = nextIndex++
          toolBlocks[ci] = { anthIndex }
          anthSse(res, 'content_block_start', { index: anthIndex, content_block: { type: 'tool_use', id: (tc.id || rid('toolu_')), name: (tc.function && tc.function.name) || '', input: {} } })
        }
        if (tc.function && tc.function.arguments) {
          anthSse(res, 'content_block_delta', { index: toolBlocks[ci].anthIndex, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } })
        }
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason
  }

  const decoder = new TextDecoder()
  let buf = ''
  try {
    for await (const part of upstreamRes.body) {
      buf += decoder.decode(part, { stream: true })
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') continue
        try { handleChunk(JSON.parse(data)) } catch {}
      }
    }
  } catch (e) {
    // 断流：尽力收尾，发 error 事件
    anthSse(res, 'error', { error: { type: 'api_error', message: 'upstream stream error: ' + (e && e.message) } })
    res.end()
    return
  }
  // 安全 hook 尾部冲刷
  if (hooks.flush) { const tail = hooks.flush(); if (tail) { ensureTextBlock(); anthSse(res, 'content_block_delta', { index: textIndex, delta: { type: 'text_delta', text: tail } }) } }
  // 闭合所有打开的块
  closeTextBlock()
  for (const k of Object.keys(toolBlocks)) anthSse(res, 'content_block_stop', { index: toolBlocks[k].anthIndex })
  // message_delta（stop_reason + 累计 usage）+ message_stop
  const stop_reason = finishReason === 'tool_calls' ? 'tool_use' : (finishReason === 'length' ? 'max_tokens' : 'end_turn')
  anthSse(res, 'message_delta', { delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: (usage && usage.completion_tokens) || 0 } })
  anthSse(res, 'message_stop', {})
  res.end()
}

// ─── 读请求体 ─────────────────────────────────────────────────────────────
// body 大小上限：服务虽只监听 127.0.0.1，但任一本机进程都能发请求，无限累积会被打爆内存。
// 50MB 足够覆盖含图片的多模态请求；超限抛 PayloadTooLarge，由调用方回 413。
const MAX_BODY = 50 * 1024 * 1024
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let aborted = false
    req.on('data', c => {
      if (aborted) return
      size += c.length
      if (size > MAX_BODY) {
        aborted = true
        const e = new Error('request body too large'); e.code = 'PAYLOAD_TOO_LARGE'
        // 停止累积但不立刻 destroy：让调用方有机会写出 413 响应（destroy 会让客户端只收到 RST）。
        req.pause()
        reject(e)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => { if (!aborted) resolve(Buffer.concat(chunks)) })
    req.on('error', reject)
  })
}

// 从 chat messages 提取最后一条用户文本（模态/难度判断用）
function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      const c = messages[i].content
      return typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => (p && p.text) || '').join('') : '')
    }
  }
  return ''
}

// ─── 主处理 ───────────────────────────────────────────────────────────────
async function handleResponses(req, res, body, upstream, auth, options) {
  options = options || {}
  let parsed
  try { parsed = JSON.parse(body.toString('utf8')) } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'invalid JSON body' } }))
    return
  }
  const wantStream = !!parsed.stream
  const chatBody = responsesToChat(parsed)
  const userText = lastUserText(chatBody.messages)

  // ── 模态路由（属智能路由模式）：识别"生成图/视频"→ 改道图像/视频模型 ──
  if (options.smartRouting) {
    const modality = detectModality(userText)
    if (modality === 'image' || modality === 'video') {
      try { return await handleModality(res, parsed, userText, modality, upstream, auth, wantStream) }
      catch (e) { /* 模态失败则回退正常文本路径，fail-open */ }
    }
  }

  // ── 智能路由：全自主选模型（忽略用户所选）+ 备用模型（渠道/模型故障转移用）──
  let alternates = []
  let routeDifficulty = null
  if (options.smartRouting) {
    try {
      const models = await getModels()
      const d = router.decide(chatBody.messages, chatBody.model, models, { learner: options.learner })
      if (d.model) chatBody.model = d.model
      routeDifficulty = d.difficulty
      if (options.onEvent) options.onEvent({ type: 'route', to: d.model, reason: d.reason })
      // 备用：按价格取另外两个文本模型，主模型/渠道故障时自动切换
      alternates = models.filter(m => (m.model_type || 'text') === 'text' && m.input_price != null && m.name !== chatBody.model)
        .sort((a, b) => b.input_price - a.input_price)
      alternates = [alternates[0] && alternates[0].name, alternates[alternates.length - 1] && alternates[alternates.length - 1].name].filter(Boolean)
    } catch (e) { /* fail-open：路由出错不影响转发 */ }
  }

  // ── 安全网关：只做入站投毒检测 ──
  // 注：出站 PII 脱敏已弃用——OnlyRouter 上游本就是云端模型，prompt 必然送达，
  //     脱敏既无法真正保护隐私、又会把真实内容换成占位符破坏模型可用性。
  //     安全网关现仅负责检查"收到的内容"是否被投毒（隐藏指令/外泄链接/危险命令）。
  let hooks = null
  if (options.security) {
    hooks = {
      onText: piece => {
        const scan = security.scanInbound(piece)
        if (scan.findings.length && options.onEvent) options.onEvent({ type: 'inbound', findings: scan.findings })
        return scan.text
      },
      flush: () => '',
      restoreFull: s => security.scanInbound(s).text,
    }
  }

  // ── Fusion：虚拟融合模型（面板并行作答 → 评委综合，质量超单模型）──
  if (isFusion(chatBody.model)) {
    try { return await handleFusion(res, parsed, chatBody, upstream, auth, wantStream, hooks) }
    catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'fusion 失败：' + (e && e.message) } }))
      return
    }
  }

  // 带渠道/模型故障转移地转发（瞬时错误自动重试 + 智能模式下换备用模型）
  const t0 = Date.now()
  const fwd = await forwardChat(upstream, auth, chatBody, wantStream, alternates)
  const upstreamRes = fwd.res
  // 自迭代：记录本次路由真实效果（成功与否/延迟），喂给每日学习 Loop
  if (options.learner && routeDifficulty) {
    try { options.learner.record({ difficulty: routeDifficulty, model: fwd.model || chatBody.model, ok: !!(upstreamRes && upstreamRes.ok), latencyMs: Date.now() - t0 }) } catch {}
  }
  if (!upstreamRes) {
    res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: '上游多次重试仍失败：' + (fwd.tries || []).join('; ') } }))
    return
  }
  if (fwd.model) { chatBody.model = fwd.model; parsed.model = fwd.model }  // 实际命中的模型（可能已故障转移到备用），回传给响应翻译

  if (!upstreamRes.ok) {
    const errText = await upstreamRes.text()
    res.writeHead(upstreamRes.status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'upstream ' + upstreamRes.status + ': ' + errText.slice(0, 500) } }))
    return
  }

  if (wantStream) {
    if (fwd.native) await streamAnthropicToResponses(upstreamRes, res, parsed.model, hooks)
    else await streamChatToResponses(upstreamRes, res, parsed.model, hooks)
  } else {
    const raw = await upstreamRes.json()
    const chat = fwd.native ? anthropicToChat(raw) : raw   // -ab Claude 走 messages：先翻成 chat 形态再统一处理
    if (hooks && chat.choices && chat.choices[0] && chat.choices[0].message) {
      const msg = chat.choices[0].message
      if (typeof msg.content === 'string') msg.content = hooks.restoreFull(msg.content)
      if (Array.isArray(msg.tool_calls)) for (const tc of msg.tool_calls) if (tc.function) tc.function.arguments = hooks.restoreFull(tc.function.arguments || '')
    }
    const out = chatToResponses(chat, parsed.model)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(out))
  }
}

// 模态路由：调 OnlyRouter 图像/视频端点，把结果包成 Responses 返回（Codex 终端里呈现为链接）
async function handleModality(res, parsed, prompt, modality, upstream, auth, wantStream) {
  const models = await getModels()
  const pick = models.find(m => m.model_type === modality)
  if (!pick) throw new Error('no ' + modality + ' model available')
  let noteText
  if (modality === 'image') {
    const r = await fetch(upstream + '/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify({ model: pick.name, prompt, n: 1 }),
    })
    const data = await r.json()
    if (!r.ok) throw new Error('image gen failed')
    const item0 = (data.data && data.data[0]) || {}
    const url = item0.url || (item0.b64_json ? 'data:image/png;base64,' + item0.b64_json.slice(0, 24) + '…(b64)' : null)
    noteText = url
      ? `已用模型 ${pick.name} 生成图片：\n\n![generated](${url})\n\n（链接 24h 有效；在 Switch 生成面板可直接预览/下载）`
      : `已生成图片，但未取到可显示链接。`
  } else {
    noteText = `视频生成为异步任务，建议在 Switch 的生成面板里发起并轮询。检测到的提示词：「${prompt.slice(0, 60)}」`
  }
  if (wantStream) {
    const respId = rid('resp_'), msgId = rid('msg_')
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    sse(res, 'response.created', { response: baseResponse(respId, 'in_progress', pick.name) })
    sse(res, 'response.output_item.added', { output_index: 0, item: { id: msgId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } })
    sse(res, 'response.output_text.delta', { item_id: msgId, output_index: 0, content_index: 0, delta: noteText })
    const item = { id: msgId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: noteText, annotations: [] }] }
    sse(res, 'response.output_item.done', { output_index: 0, item })
    sse(res, 'response.completed', { response: baseResponse(respId, 'completed', pick.name, [item], { input_tokens: 0, output_tokens: 0, total_tokens: 0 }) })
    res.end()
  } else {
    const out = chatToResponses({ model: pick.name, choices: [{ message: { content: noteText } }] }, pick.name)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(out))
  }
}

// ─── Fusion：多模型融合（仿 OpenRouter Fusion）────────────────────────────
// 三层：① 面板模型并行独立作答 ② 评委读全部答案做结构化分析 ③ 评委综合出最终答案。
// 默认面板 = Opus 4.8 + GPT-5.5，评委 = Opus（编码最强）。
// 面板与评委都选**各家族里价格最低的渠道/版本**，把融合成本压到最低。
function isFusion(model) { return /fusion/i.test(model || '') }

function pickFusionPanel(models) {
  const text = models.filter(m => (m.model_type || 'text') === 'text' && m.input_price != null)
  const cheapestMatching = re => {
    const cands = text.filter(m => re.test(m.name)).sort((a, b) => a.input_price - b.input_price)
    return cands[0] && cands[0].name
  }
  const opus = cheapestMatching(/opus/i)
  const gpt55 = cheapestMatching(/gpt-?5\.?5/i)
  let panel = [opus, gpt55].filter(Boolean)
  if (panel.length < 2) {  // 回退：能力最高的两个文本模型（仍取同家族最低价）
    panel = text.slice().sort((a, b) => a.input_price - b.input_price).slice(0, 2).map(m => m.name)
  }
  return { panel, judge: opus || panel[0] }
}

// 单次调用一个模型（非流式），按模型协议自动选 /messages 或 /chat/completions。
// 失败时保留上游真实报错（HTTP 状态 + 原文片段），不再吞成空字符串——守住"报错给完整原文"。
async function callModelOnce(upstream, auth, model, conv) {
  const native = isAnthropicNative(model)
  try {
    if (native) {
      const body = chatToAnthropic({ model, messages: conv, max_tokens: 8192, stream: false })
      const r = await fetch(upstream + '/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
      })
      if (!r.ok) return { model, ok: false, text: '', error: `HTTP ${r.status}: ${(await r.text()).slice(0, 300)}` }
      const j = await r.json()
      return { model, ok: true, text: anthropicToChat(j).choices[0].message.content || '' }
    }
    const r = await fetch(upstream + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify({ model, messages: conv, stream: false }),
    })
    if (!r.ok) return { model, ok: false, text: '', error: `HTTP ${r.status}: ${(await r.text()).slice(0, 300)}` }
    const j = await r.json()
    return { model, ok: true, text: (((j.choices || [])[0] || {}).message || {}).content || '' }
  } catch (e) { return { model, ok: false, text: '', error: (e && e.message) || String(e) } }
}

// 干净对话：去掉 tools / tool_calls / tool 角色（带这些但无 tools 定义会让上游 400），只留 system/user/assistant 文本
function cleanConversation(messages) {
  const out = []
  for (const m of messages || []) {
    if (!m || m.role === 'tool') continue
    const c = typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.map(p => (p && p.text) || '').join('') : '')
    if (m.role === 'assistant') { if (c) out.push({ role: 'assistant', content: c }); continue }
    if (m.role === 'system' || m.role === 'user') out.push({ role: m.role, content: c })
  }
  return out
}

// 本地合成一条 Responses 流（文本一次性吐出）——评委结果无论走哪种上游协议，回吐格式都统一且稳定
function emitSyntheticResponse(res, text, model, wantStream) {
  if (wantStream) {
    const respId = rid('resp_'), msgId = rid('msg_')
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    sse(res, 'response.created', { response: baseResponse(respId, 'in_progress', model) })
    sse(res, 'response.output_item.added', { output_index: 0, item: { id: msgId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } })
    sse(res, 'response.output_text.delta', { item_id: msgId, output_index: 0, content_index: 0, delta: text })
    const item = { id: msgId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }
    sse(res, 'response.output_item.done', { output_index: 0, item })
    sse(res, 'response.completed', { response: baseResponse(respId, 'completed', model, [item], { input_tokens: 0, output_tokens: 0, total_tokens: 0 }) })
    res.end()
  } else {
    const out = chatToResponses({ model, choices: [{ message: { content: text } }] }, model)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(out))
  }
}

// Fusion 结果用 anthropic messages 格式合成回吐（供 Claude Code 走 /messages 用）
function emitSyntheticAnthropic(res, text, model, wantStream) {
  if (wantStream) {
    const msgId = rid('msg_')
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    anthSse(res, 'message_start', { message: { id: msgId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })
    anthSse(res, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    anthSse(res, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text } })
    anthSse(res, 'content_block_stop', { index: 0 })
    anthSse(res, 'message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } })
    anthSse(res, 'message_stop', {})
    res.end()
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ id: rid('msg_'), type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }))
  }
}

async function handleFusion(res, parsed, chatBody, upstream, auth, wantStream, hooks, emit) {
  emit = emit || emitSyntheticResponse   // 默认 Responses 格式（Codex）；Claude 传 emitSyntheticAnthropic
  const models = await getModels()
  const { panel, judge } = pickFusionPanel(models)
  if (!panel.length || !judge) throw new Error('fusion: 面板模型不可用（模型表为空或拉取失败）')

  const conv = cleanConversation(chatBody.messages)
  // ① 面板并行作答（按各自协议调用，保留真实失败原因）
  const answers = await Promise.all(panel.map(m => callModelOnce(upstream, auth, m, conv)))
  const good = answers.filter(a => a.ok && a.text)
  if (!good.length) {
    // 全失败：把每个面板模型的真实报错带出去，而不是笼统一句"面板全部失败"
    const detail = answers.map(a => `${a.model}: ${a.error || '空回答'}`).join(' | ')
    throw new Error('面板全部失败 → ' + detail)
  }

  // ②③ 评委综合——重建为一次干净的纯文本请求（system + 一条 user），不带任何工具字段
  const sys = conv.find(m => m.role === 'system')
  const lastUser = [...conv].reverse().find(m => m.role === 'user')
  const task = lastUser ? lastUser.content : ''
  const panelBlock = good.map((a, i) => `【回答${String.fromCharCode(65 + i)}】\n${a.text}`).join('\n\n---\n\n')
  const judgeMessages = []
  if (sys) judgeMessages.push({ role: 'system', content: sys.content })
  judgeMessages.push({
    role: 'user',
    content: `我的请求是：\n${task}\n\n下面是多个模型对它的独立回答。请先分析它们的共识、矛盾、独到见解与盲点，再综合出一个质量超过任何单个回答的**最终回答**。只输出最终回答本身，不要复述分析、不要提到"回答A/B"。\n\n${panelBlock}`,
  })

  // 评委也按协议调用（Opus 是 -ab 直连 → 走 messages）。结果用本地合成流回吐，不依赖上游 SSE 格式。
  const jr = await callModelOnce(upstream, auth, judge, judgeMessages)
  if (!jr.ok || !jr.text) {
    // 评委挂了：降级返回质量最好的单个面板答案（fail-soft），并在末尾标注，而不是整体 502
    const fallback = good[0].text + `\n\n_（注：融合评委「${judge}」调用失败，已返回单模型答案。评委报错：${jr.error || '空回答'}）_`
    return emit(res, fallback, 'fusion', wantStream)
  }
  let finalText = jr.text
  if (hooks && hooks.restoreFull) finalText = hooks.restoreFull(finalText)
  emit(res, finalText, 'fusion', wantStream)
}

// 透传（models 列表等）
async function passthrough(req, res, body, upstream, auth, path) {
  try {
    const r = await fetch(upstream + path, {
      method: req.method,
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
    })
    const text = await r.text()
    res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/json' })
    res.end(text)
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'upstream unreachable: ' + (e && e.message) } }))
  }
}

// VS Code 客户端（Continue 等）走原生 OpenAI /v1/chat/completions。
// 与裸 passthrough 的区别：① 流式真透传（不缓冲，否则聊天要等全部生成完才显示）；
// ② 智能路由可选（直接对 chat body 选模型）；③ 安全脱敏可选（出站 messages 脱敏 / 入站增量还原）。
async function handleChat(req, res, body, upstream, auth, options) {
  options = options || {}
  let parsed
  try { parsed = JSON.parse(body.toString('utf8')) } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ error: { message: 'invalid JSON body' } }))
  }
  const wantStream = !!parsed.stream

  // 智能路由：对 chat messages 自主选模型（忽略客户端所选）
  if (options.smartRouting) {
    try {
      const models = await getModels()
      const d = router.decide(parsed.messages || [], parsed.model, models, { learner: options.learner })
      if (d.model) parsed.model = d.model
    } catch {}
  }

  // 安全网关·出站：把 messages 里的密钥/PII 脱敏（可逆占位符），响应回来再按 store 还原
  let store = null
  if (options.security && Array.isArray(parsed.messages)) {
    try {
      store = security.makeStore()
      redactMessages(parsed.messages, store)
    } catch { store = null }
  }
  const restore = store ? (s => security.restore(s, store)) : null

  let upstreamRes
  try {
    upstreamRes = await fetch(upstream + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth, Accept: wantStream ? 'text/event-stream' : 'application/json' },
      body: JSON.stringify(parsed),
    })
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ error: { message: 'upstream unreachable: ' + (e && e.message) } }))
  }

  // 非流式：缓冲整体，安全开启时还原响应文本
  if (!wantStream || !upstreamRes.body) {
    const txt = await upstreamRes.text()
    let out = txt
    if (restore && upstreamRes.ok) {
      try {
        const j = JSON.parse(txt)
        for (const ch of (j.choices || [])) {
          if (ch.message && typeof ch.message.content === 'string') ch.message.content = restore(ch.message.content)
        }
        out = JSON.stringify(j)
      } catch {}
    }
    res.writeHead(upstreamRes.status, { 'Content-Type': upstreamRes.headers.get('content-type') || 'application/json' })
    return res.end(out)
  }

  // 流式：逐块转发。安全开启时对 delta.content 做还原（跨 chunk 按行缓冲）
  res.writeHead(upstreamRes.status, {
    'Content-Type': upstreamRes.headers.get('content-type') || 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache', Connection: 'keep-alive',
  })
  if (!restore) {
    try { for await (const part of upstreamRes.body) res.write(part) } catch {}
    return res.end()
  }
  const decoder = new TextDecoder()
  let buf = ''
  function rewriteLine(line) {
    const t = line.trim()
    if (!t.startsWith('data:')) return line
    const payload = t.slice(5).trim()
    if (payload === '[DONE]') return line
    try {
      const ev = JSON.parse(payload)
      let touched = false
      for (const ch of (ev.choices || [])) {
        if (ch.delta && typeof ch.delta.content === 'string') { ch.delta.content = restore(ch.delta.content); touched = true }
      }
      if (touched) return 'data: ' + JSON.stringify(ev)
    } catch {}
    return line
  }
  try {
    for await (const part of upstreamRes.body) {
      buf += decoder.decode(part, { stream: true })
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        res.write(rewriteLine(line) + '\n')
      }
    }
    if (buf) res.write(rewriteLine(buf))
  } catch {}
  res.end()
}


// Claude Code 走代理：/v1/messages 直通 OnlyRouter（同协议，不翻译），但保留流式真透传 + 入站投毒扫描。
// 与 passthrough 的区别：流式逐块转发（不缓冲），安全开启时对文本增量跑 scanInbound。
async function handleMessages(req, res, body, upstream, auth, options) {
  options = options || {}
  let parsed = {}
  try { parsed = JSON.parse(body.toString('utf8')) } catch {}
  const wantStream = !!parsed.stream
  const requested = parsed.model

  // 目标模型：智能路由则全模型候选自主选；否则用工具配置/请求里的模型。
  let target = requested
  let routeDifficulty = null
  if (options.smartRouting) {
    try {
      const models = await getModels()
      // 复用 Codex 那套 chat 消息难度判断：把 anthropic 请求临时翻成 chat 取 messages
      const chatView = anthropicReqToChat(parsed)
      const d = router.decide(chatView.messages, requested, models)
      if (d.model) target = d.model
      routeDifficulty = d.difficulty
      if (options.onEvent) options.onEvent({ type: 'route', tool: 'claude', to: target, reason: d.reason })
    } catch (e) { /* fail-open：路由出错则用 requested */ }
  } else if (options.model) {
    target = options.model
  }

  const scan = options.security ? (s => security.scanInbound(s)) : null
  const hooks = scan ? { onText: s => scan(s).text, flush: () => '', restoreFull: s => scan(s).text } : null

  // ── Fusion：Claude Code 也支持（面板+评委逻辑复用，结果用 anthropic 格式合成回吐）──
  if (isFusion(target)) {
    try { return await handleFusion(res, parsed, anthropicReqToChat(parsed), upstream, auth, wantStream, hooks, emitSyntheticAnthropic) }
    catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'fusion 失败：' + (e && e.message) } }))
    }
  }

  // ── 分流 ──
  // ① 目标是 Claude -ab（anthropic 原生）→ 纯 messages 透传（含流式真透传 + 安全扫描），零翻译。
  // ② 目标是 gpt 等 chat-only → 跨家族翻译：anthropic 请求→chat，chat 响应→anthropic。
  const native = isAnthropicNative(target)
  if (native) {
    // 若智能路由换了模型，需把目标模型写回请求体再透传
    const outBody = (target && target !== requested) ? Buffer.from(JSON.stringify(Object.assign({}, parsed, { model: target }))) : body
    return passthroughMessages(req, res, outBody, upstream, auth, wantStream, scan)
  }

  // 跨家族：翻成 chat completions 转发
  const chatBody = anthropicReqToChat(Object.assign({}, parsed, { model: target }))
  let upstreamRes
  try {
    upstreamRes = await fetch(upstream + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth, Accept: wantStream ? 'text/event-stream' : 'application/json' },
      body: JSON.stringify(chatBody),
    })
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: '上游不可达: ' + (e && e.message) } }))
  }
  if (!upstreamRes.ok) {
    const errText = await upstreamRes.text()
    res.writeHead(upstreamRes.status, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'upstream ' + upstreamRes.status + ': ' + errText.slice(0, 500) } }))
  }
  if (wantStream) {
    await streamChatToAnthropic(upstreamRes, res, target, hooks)
  } else {
    const chat = await upstreamRes.json()
    const anth = chatRespToAnthropic(chat, target)
    if (scan) for (const b of anth.content) if (b.type === 'text') b.text = scan(b.text).text
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(anth))
  }
}

// Claude -ab 纯透传：messages → messages（流式真透传 + 安全扫描），抽出复用
async function passthroughMessages(req, res, body, upstream, auth, wantStream, scan) {
  let upstreamRes
  try {
    upstreamRes = await fetch(upstream + '/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth, 'anthropic-version': req.headers['anthropic-version'] || '2023-06-01' },
      body,
    })
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ error: { message: 'upstream unreachable: ' + (e && e.message) } }))
  }

  if (!wantStream || !upstreamRes.body) {
    const txt = await upstreamRes.text()
    let out = txt
    if (scan && upstreamRes.ok) {
      try { const j = JSON.parse(txt); if (Array.isArray(j.content)) { for (const b of j.content) if (b && b.type === 'text' && typeof b.text === 'string') b.text = scan(b.text).text; out = JSON.stringify(j) } } catch {}
    }
    res.writeHead(upstreamRes.status, { 'Content-Type': upstreamRes.headers.get('content-type') || 'application/json' })
    return res.end(out)
  }

  res.writeHead(upstreamRes.status, {
    'Content-Type': upstreamRes.headers.get('content-type') || 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache', Connection: 'keep-alive',
  })
  if (!scan) {
    try { for await (const part of upstreamRes.body) res.write(part) } catch {}
    return res.end()
  }
  const decoder = new TextDecoder()
  let buf = ''
  function rewriteLine(line) {
    const t = line.trim()
    if (!t.startsWith('data:')) return line
    try {
      const ev = JSON.parse(t.slice(5).trim())
      if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta' && typeof ev.delta.text === 'string') {
        ev.delta.text = scan(ev.delta.text).text
        return 'data: ' + JSON.stringify(ev)
      }
    } catch {}
    return line
  }
  try {
    for await (const part of upstreamRes.body) {
      buf += decoder.decode(part, { stream: true })
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        res.write(rewriteLine(line) + '\n')
      }
    }
    if (buf) res.write(rewriteLine(buf))
  } catch {}
  res.end()
}

// ─── 启动 ─────────────────────────────────────────────────────────────────
// 返回 Promise<{ port, server, close }>。preferredPort 被占用则向后探测。
function startGateway(opts = {}) {
  const upstream = (opts.upstream || DEFAULT_UPSTREAM).replace(/\/+$/, '')
  const preferred = opts.port || 8788

  // 两个模式开关由 main 进程的 config 实时提供（智能路由 / 安全网关，互不排斥）
  const getOptions = typeof opts.getOptions === 'function' ? opts.getOptions : () => ({})
  // 网关接管鉴权：main 进程持有的 API Key 实时提供给网关，转发时注入 Authorization。
  // 这样客户端（Codex）的环境变量值不再重要——换 Key 只需更新 config，无需重开终端。
  const getKey = typeof opts.getKey === 'function' ? opts.getKey : () => ''

  const server = http.createServer(async (req, res) => {
    const url = req.url || ''
    // 优先用网关持有的 Key（实时读 config）；取不到再回退透传客户端请求头里的 Authorization。
    let gwKey = ''
    try { gwKey = getKey() || '' } catch {}
    const auth = gwKey ? 'Bearer ' + gwKey : (req.headers['authorization'] || '')
    let body = Buffer.alloc(0)
    if (!['GET', 'HEAD'].includes(req.method)) {
      try { body = await readBody(req) }
      catch (e) {
        const tooLarge = e && e.code === 'PAYLOAD_TOO_LARGE'
        res.writeHead(tooLarge ? 413 : 400, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: { message: tooLarge ? '请求体过大（上限 50MB）' : '读取请求体失败' } }))
      }
    }

    if (req.method === 'POST' && /\/responses$/.test(url.split('?')[0])) {
      let options = {}
      try { options = getOptions('codex') || {} } catch {}
      return handleResponses(req, res, body, upstream, auth, options)
    }
    // Claude Code：/v1/messages → 按目标模型分流（Claude -ab 透传 / 跨家族翻译），不经 Responses 翻译
    if (req.method === 'POST' && /\/messages$/.test(url.split('?')[0])) {
      let options = {}
      try { options = getOptions('claude') || {} } catch {}
      return handleMessages(req, res, body, upstream, auth, options)
    }
    // VS Code（Continue 等）：/v1/chat/completions → 智能路由 + 安全脱敏 + 流式真透传
    if (req.method === 'POST' && /\/chat\/completions$/.test(url.split('?')[0])) {
      let options = {}
      try { options = getOptions('vscode') || {} } catch {}
      return handleChat(req, res, body, upstream, auth, options)
    }
    // /v1/models 等：原样透传
    const m = url.match(/\/v1(\/.*)$/)
    if (m) return passthrough(req, res, body, upstream, auth, m[1])
    if (url === '/health' || url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      // service 签名：让重启的新实例能认出「占用端口的是不是自家上一份代理」，从而复用而非漂移端口
      return res.end(JSON.stringify({ ok: true, upstream, service: 'onlyrouter-switch-gateway' }))
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'not found: ' + url } }))
  })

  // 探活：preferred 端口若已被占，先问问占用者是不是自家上一份代理。
  // 是 → 复用该端口（reused:true，不再 listen），避免端口漂移导致 config.toml 失效。
  // 否 → 让出，向后探测新端口。
  async function probeSelf(p) {
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 800)
      const r = await fetch(`http://127.0.0.1:${p}/health`, { signal: ctrl.signal })
      clearTimeout(t)
      if (!r.ok) return false
      const j = await r.json().catch(() => ({}))
      return j && j.service === 'onlyrouter-switch-gateway'
    } catch { return false }
  }

  return new Promise(async (resolve, reject) => {
    // 先探活：端口已被自家旧实例占用则直接复用，不起新 server
    if (await probeSelf(preferred)) {
      return resolve({ port: preferred, server: null, reused: true, close: () => {} })
    }
    let port = preferred
    let attempts = 0
    function tryListen() {
      server.once('error', err => {
        if (err.code === 'EADDRINUSE' && attempts < 20) {
          attempts++
          port++
          setTimeout(tryListen, 0)
        } else {
          reject(err)
        }
      })
      server.listen(port, '127.0.0.1', () => {
        resolve({ port, server, reused: false, close: () => server.close() })
      })
    }
    tryListen()
  })
}

module.exports = { startGateway, responsesToChat, chatToResponses }
