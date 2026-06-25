// ─────────────────────────────────────────────────────────────────────────
// OnlyRouter Switch · 安全网关中间件
//
// 出站：把 prompt 里的密钥/PII 脱敏成可逆占位符 __OR_<类>_<hash8>__，发上游前替换；
//       响应回来按占位符还原（流式跨 chunk 安全缓冲）。
// 入站：对模型/上游返回内容做 L1 投毒检测——剥离隐藏 Unicode、识别外泄链接与危险命令。
//
// 设计取舍（编码场景）：高精度优先，宁可漏掉软 PII 也尽量不误伤代码——
// 只脱高置信度密钥 + 强格式证件号 + 显式 password=xxx 上下文，并对已知非密模式豁免。
// 占位符不用拟真假值（参考 rdx ADR-002）：假值会让模型误操作且难以无歧义还原。
// ─────────────────────────────────────────────────────────────────────────

const crypto = require('crypto')

// ─── 误脱敏豁免：这些一定不是要保护的密钥/PII（rdx 的 tricky_false_positives 思路）────
const EXEMPT = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // UUID
  /^[0-9a-f]{32}$/i,                  // MD5
  /^[0-9a-f]{40}$/i,                  // SHA1
  /^[0-9a-f]{64}$/i,                  // SHA256
  /^#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/, // 颜色码
  /AKIAIOSFODNN7EXAMPLE/,             // AWS 官方示例 key
]
const EXEMPT_SUBSTR = ['example', 'placeholder', 'your-', 'xxxx', 'dummy', 'sample', '<', '>', 'test_pass', 'changeme']

function isExempt(v) {
  if (!v) return true
  if (EXEMPT.some(re => re.test(v))) return true
  const low = v.toLowerCase()
  if (EXEMPT_SUBSTR.some(s => low.includes(s))) return true
  return false
}

// 身份证 18 位校验码
function validCnId(v) {
  if (!/^\d{17}[\dXx]$/.test(v)) return false
  const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
  const c = '10X98765432'
  let s = 0
  for (let i = 0; i < 17; i++) s += parseInt(v[i], 10) * w[i]
  return c[s % 11] === v[17].toUpperCase()
}

// 银行卡 Luhn
function luhn(v) {
  if (!/^\d{13,19}$/.test(v)) return false
  let sum = 0, alt = false
  for (let i = v.length - 1; i >= 0; i--) {
    let d = parseInt(v[i], 10)
    if (alt) { d *= 2; if (d > 9) d -= 9 }
    sum += d; alt = !alt
  }
  return sum % 10 === 0
}

// ─── 检测规则：cat 类别、re 正则、group 捕获组(只替换值)、validate 二次校验 ──────────
const PATTERNS = [
  { cat: 'ANTHROPIC_KEY', re: /sk-ant-[A-Za-z0-9_\-]{20,}/g },
  { cat: 'OPENAI_KEY', re: /sk-proj-[A-Za-z0-9_\-]{20,}/g },
  { cat: 'OPENAI_KEY', re: /sk-[A-Za-z0-9]{20,}/g },
  { cat: 'AWS_AKID', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { cat: 'GITHUB_TOKEN', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { cat: 'SLACK_TOKEN', re: /\bxox[baprs]-[A-Za-z0-9\-]{10,}\b/g },
  { cat: 'GOOGLE_KEY', re: /\bAIza[0-9A-Za-z_\-]{35}\b/g },
  { cat: 'JWT', re: /\beyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g },
  { cat: 'SECRET', re: /(?:password|passwd|pwd|secret|api[_-]?key|token)\s*[:=]\s*["']?([^\s"'`,;)]{6,})/gi, group: 1 },
  { cat: 'EMAIL', re: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g },
  { cat: 'CN_PHONE', re: /\b1[3-9]\d{9}\b/g },
  { cat: 'CN_ID', re: /\b\d{17}[\dXx]\b/g, validate: validCnId },
  { cat: 'BANK_CARD', re: /\b\d{13,19}\b/g, validate: luhn },
]

function makeStore() { return { p2v: new Map(), v2p: new Map() } }

function placeholderFor(cat, value, store) {
  const hit = store.v2p.get(value)
  if (hit) return hit
  const h = crypto.createHash('sha256').update(value).digest('hex').slice(0, 8)
  const ph = `__OR_${cat}_${h}__`
  store.p2v.set(ph, value)
  store.v2p.set(value, ph)
  return ph
}

// 脱敏一段文本，返回 {text, count}；store 累积占位符↔原值映射供还原
function redact(text, store) {
  if (typeof text !== 'string' || !text) return { text, count: 0 }
  let out = text, count = 0
  for (const p of PATTERNS) {
    out = out.replace(p.re, (match, ...groups) => {
      const value = p.group ? groups[p.group - 1] : match
      if (!value || isExempt(value)) return match
      if (p.validate && !p.validate(value)) return match
      const ph = placeholderFor(p.cat, value, store)
      count++
      return p.group ? match.replace(value, ph) : ph
    })
  }
  return { text: out, count }
}

// 一次性还原（非流式）
function restore(text, store) {
  if (typeof text !== 'string' || !text) return text
  return text.replace(/__OR_[A-Z_]+_[a-f0-9]{8}__/g, ph => store.p2v.get(ph) || ph)
}

// 流式还原：跨 chunk 缓冲未闭合的占位符（参考 rdx stream.py，修正其 tool_use 不回写问题——
// 本类对任何文本流通用，工具调用 arguments 也走同一条）
const PH_RE = /^__OR_[A-Z_]+_[a-f0-9]{8}__/
class StreamRestorer {
  constructor(store) { this.store = store; this.buf = '' }
  feed(chunk) {
    this.buf += chunk == null ? '' : String(chunk)
    let out = ''
    while (true) {
      const start = this.buf.indexOf('__OR_')
      if (start === -1) { out += this.buf; this.buf = ''; break }
      out += this.buf.slice(0, start)
      const rest = this.buf.slice(start)
      const m = rest.match(PH_RE)
      if (m) {
        out += this.store.p2v.get(m[0]) || m[0]
        this.buf = rest.slice(m[0].length)
        continue
      }
      // 还没闭合：超过最大可能长度则判定不是占位符，吐一个字符继续；否则缓冲等下一 chunk
      if (rest.length > 48) { out += rest[0]; this.buf = rest.slice(1); continue }
      this.buf = rest
      break
    }
    return out
  }
  flush() { const o = this.buf; this.buf = ''; return o }
}

// ─── 入站投毒 L1 ─────────────────────────────────────────────────────────
// 隐藏字符：零宽(200B-200D)、LRM/RLM(200E-F)、双向控制(202A-E,2066-9)、词连接(2060-4)、BOM(FEFF)、
// Unicode Tag 块(U+E0000–E007F，代理对 DB40 DC00-DC7F)
const HIDDEN_RE = new RegExp('[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]|\\uDB40[\\uDC00-\\uDC7F]', 'g')
function stripHidden(text) {
  if (typeof text !== 'string') return { text, stripped: 0 }
  let n = 0
  const cleaned = text.replace(HIDDEN_RE, () => { n++; return '' })
  return { text: cleaned, stripped: n }
}

// 外泄链接：markdown 图片/链接指向外域且 query 形似编码数据
function findExfil(text) {
  const finds = []
  const reImg = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g
  let m
  while ((m = reImg.exec(text))) {
    const url = m[1]
    if (/[?&][^=]+=[A-Za-z0-9+/=_\-]{24,}/.test(url) || /data=|payload=|q=[A-Za-z0-9+/=]{16,}/i.test(url)) {
      finds.push({ type: 'exfil_image', detail: url.slice(0, 120) })
    }
  }
  return finds
}

// 危险命令
const DANGER = [
  { type: 'rm_rf', re: /\brm\s+-rf?\s+[~/.]/ },
  { type: 'curl_pipe_sh', re: /\bcurl\s+[^\n|]+\|\s*(?:sudo\s+)?(?:ba)?sh\b/ },
  { type: 'wget_pipe_sh', re: /\bwget\s+[^\n|]+\|\s*(?:ba)?sh\b/ },
  { type: 'chmod_777', re: /\bchmod\s+(?:-R\s+)?777\b/ },
]
function findDanger(text) {
  const finds = []
  for (const d of DANGER) if (d.re.test(text)) finds.push({ type: d.type })
  return finds
}

// 扫描一段响应文本：剥隐藏字符 + 收集 findings（默认不拦截，fail-open，交调用方决定）
function scanInbound(text) {
  const s = stripHidden(text)
  const findings = []
  if (s.stripped) findings.push({ type: 'hidden_chars', count: s.stripped })
  findings.push(...findExfil(s.text), ...findDanger(s.text))
  return { text: s.text, findings }
}

module.exports = {
  makeStore, redact, restore, StreamRestorer, scanInbound, stripHidden,
  isExempt, validCnId, luhn, // 导出供测试
}
