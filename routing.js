// ─────────────────────────────────────────────────────────────────────────
// OnlyRouter Switch · 智能路由 + 模态路由
//
// 决策顺序（已定）：① 能力门槛硬判（难任务→前沿模型，不比价）
//                  ② 简单任务才进缓存经济性比较（留缓存模型 vs 换便宜模型冷启动）
//                  ③ 迟滞：会话内钉死 model，避免反复横跳击穿 prompt 缓存
// 价格全锚 onlyrouter.ai/api/models 标价。
// 模态路由：保守识别"生成图/视频"意图，改道对应模型。
// ─────────────────────────────────────────────────────────────────────────

const crypto = require('crypto')

// Fusion 虚拟模型名（本地网关拦截做融合）；智能路由难任务档会选它
const FUSION_MODEL = 'onlyrouter-fusion'

// ─── 价格取数（每 MTok，单位与 models API 一致）────────────────────────────
function inPrice(m) { return num(m && m.input_price) }
function outPrice(m) { return num(m && m.output_price) }
function cacheRead(m) { const v = num(m && m.cache_read_price); return v != null ? v : inPrice(m) }
function cacheWrite(m) { const v = num(m && m.cache_write_price); return v != null ? v : inPrice(m) }
function num(v) { return v == null || isNaN(v) ? null : Number(v) }

// 留在已缓存模型一轮的成本（前缀走缓存读价）
function stayCost(m, prefixTok, newTok, outTok) {
  const cr = cacheRead(m), ip = inPrice(m), op = outPrice(m)
  if (cr == null || ip == null || op == null) return Infinity
  return (prefixTok * cr + newTok * ip + outTok * op) / 1e6
}
// 换到便宜模型（冷启动，全量按 miss/输入价）一轮的成本
function switchCost(m, prefixTok, newTok, outTok) {
  const ip = inPrice(m), op = outPrice(m)
  if (ip == null || op == null) return Infinity
  return ((prefixTok + newTok) * ip + outTok * op) / 1e6
}

// ─── 模态识别（保守：必须有"生成/画/做" + "图/视频"，避免"读取图片文件"误判）──────
const IMAGE_INTENT = /(?:生成|画|绘制|做|制作|来)[^。.!?\n]{0,12}?(?:图片|图像|插画|海报|封面|图标|logo|icon|图)|(?:generate|create|draw|make|render)\s+(?:an?\s+|me\s+)?(?:image|picture|illustration|poster|logo|icon)|text[\s-]?to[\s-]?image/i
const VIDEO_INTENT = /(?:生成|做|制作|剪)[^。.!?\n]{0,12}?(?:视频|短片|动画|影片)|(?:generate|create|make)\s+(?:an?\s+)?(?:video|animation|clip)|text[\s-]?to[\s-]?video/i
// 抑制：明显是在处理已有文件而非生成
const NEGATE = /(?:读取|加载|解析|打开|读入|分析|load|read|parse|open|upload)\s+\S*(?:图|image|video|视频|文件|file)/i

function detectModality(text) {
  if (typeof text !== 'string' || !text) return 'text'
  if (NEGATE.test(text)) return 'text'
  if (VIDEO_INTENT.test(text)) return 'video'
  if (IMAGE_INTENT.test(text)) return 'image'
  return 'text'
}

// ─── 能力评分（按模型家族，越高越强）──────────────────────────────────────
// 用途：价格相近时选能力更强的做"上位替代"（如 DeepSeek V4 与 GPT-5.5 价差不多则用 5.5）。
// 评分按**编码能力**排（本产品服务 Codex/Claude Code 等编码工具）——Opus 4.8 编码 > GPT-5.5。
// 可维护启发式表，新模型按家族归档；找不到给中位默认分。
const CAP_TABLE = [
  [/claude.*opus|opus-?4/i, 100], [/gpt-?5\.5/i, 96], [/gpt-?5(?!\.)/i, 90],
  [/claude.*sonnet|sonnet-?4/i, 92], [/gemini.*(2\.5.*pro|3)/i, 86],
  [/deepseek.*v4.*pro/i, 82], [/kimi.*k2|qwen3?-?max|glm-?4\.6/i, 80],
  [/deepseek.*(v4|reasoner)/i, 72], [/claude.*haiku/i, 70],
  [/minimax|qwen3|glm-?4/i, 66], [/gpt-?5.*mini|deepseek.*flash/i, 64],
]
function capabilityScore(name) {
  const n = name || ''
  for (const [re, s] of CAP_TABLE) if (re.test(n)) return s
  return 60
}

// ─── 难度分级（启发式）─────────────────────────────────────────────────────
const HARD_RE = /architect|重构|refactor|算法|algorithm|trade[\s-]?off|为什么|why\b|design\s+a|设计一|并发|concurren|security|安全漏洞|race condition|分布式|distributed/i
const SIMPLE_RE = /改个|改一下|修改|rename|重命名|typo|错别字|格式化|format|加个?注释|comment|加一行|删除这|fix the typo|小改|微调/i

function classifyDifficulty(text, tokens) {
  const t = text || ''
  if (tokens > 8000) return 'hard'        // 长上下文，保前沿模型
  if (HARD_RE.test(t)) return 'hard'
  if (tokens < 500 && SIMPLE_RE.test(t)) return 'simple'
  return 'medium'
}

// ─── 会话粘性 + 迟滞 ───────────────────────────────────────────────────────
// 会话键：稳定前缀（system + 首条用户消息）哈希，模仿 OpenRouter session stickiness。
function sessionKey(messages) {
  const sys = (messages.find(m => m.role === 'system') || {}).content || ''
  const u = (messages.find(m => m.role === 'user') || {}).content || ''
  const s = (typeof sys === 'string' ? sys : JSON.stringify(sys)) + '\u0000' + (typeof u === 'string' ? u : JSON.stringify(u))
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16)
}

class Router {
  constructor() { this.sessions = new Map() } // key → { model, turns }

  // 估算前缀 token：除最后一条用户消息外的全部内容长度 / 4
  estimateTokens(messages) {
    let prefix = 0, last = 0
    for (let i = 0; i < messages.length; i++) {
      const c = messages[i].content
      const len = (typeof c === 'string' ? c.length : JSON.stringify(c || '').length)
      if (i === messages.length - 1) last = len; else prefix += len
    }
    return { prefixTok: Math.ceil(prefix / 4), newTok: Math.ceil(last / 4) }
  }

  // 全自主分配：完全由路由按任务难度选模型，**不参考用户所选的 requested**（仅在无模型表时回退）。
  // 三档：simple→省模型 / medium→强模型 / hard→Fusion 融合款。同价位选能力更强的（上位替代）。
  // 会话内迟滞：不降级、难度升级才升档（保 prompt 缓存）。opts.learner 提供实测效果，同档内优选。
  decide(messages, requested, models, opts = {}) {
    const textModels = models.filter(m => (m.model_type || 'text') === 'text' && m.input_price != null)
    if (!textModels.length) {
      return { model: requested, reason: `无可用模型表，沿用 ${requested}`, switched: false, difficulty: 'medium' }
    }
    const cap = m => capabilityScore(m.name)
    const strongList = [...textModels].sort((a, b) => cap(b) - cap(a) || a.input_price - b.input_price)
    const minP = Math.min(...textModels.map(m => m.input_price))
    const band = textModels.filter(m => m.input_price <= Math.max(minP * 1.5, minP + 0.05))
      .sort((a, b) => cap(b) - cap(a) || a.input_price - b.input_price)

    const key = sessionKey(messages)
    const sess = this.sessions.get(key)
    const lastUser = [...messages].reverse().find(m => m.role === 'user')
    const text = lastUser ? (typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content)) : ''
    const { prefixTok, newTok } = this.estimateTokens(messages)
    const difficulty = classifyDifficulty(text, prefixTok + newTok)

    // 自迭代：同档候选里，挑实测评分最高的（样本足够时）
    const pref = (opts.learner && opts.learner.preferenceFor) ? opts.learner.preferenceFor(difficulty) : {}
    const bestLearned = cands => {
      let best = null, bs = -1
      for (const m of cands) { const s = pref[m.name]; if (s != null && s > bs) { bs = s; best = m.name } }
      return best
    }

    // 注：Fusion 太慢，智能路由不自动调用——难任务用最强单模型保持快；Fusion 仅手动选择。
    let tier, base
    if (difficulty === 'hard') { tier = 2; base = strongList[0].name }
    else if (difficulty === 'medium') { tier = 1; base = bestLearned(strongList.slice(0, 3)) || strongList[0].name }
    else { tier = 0; base = bestLearned(band) || band[0].name }

    let chosen = base, reason = `智能分配(${difficulty})→${base}` + (pref[base] != null ? '（含实测优选）' : '')
    if (sess && sess.tier != null && sess.tier >= tier && sess.model) {
      chosen = sess.model; tier = sess.tier; reason = `会话粘性→沿用 ${sess.model}`   // 不降级，保缓存
    }
    this.sessions.set(key, { model: chosen, tier, turns: (sess ? sess.turns : 0) + 1 })
    return { model: chosen, reason, switched: chosen !== requested, key, difficulty }
  }
}

module.exports = { Router, detectModality, classifyDifficulty, stayCost, switchCost, sessionKey }
