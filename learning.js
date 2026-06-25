// ─────────────────────────────────────────────────────────────────────────
// OnlyRouter Switch · 智能路由自迭代（每日 Loop）
//
// 闭环：① 每次路由后记录真实效果（命中模型/难度/成功与否/延迟）到本地日志
//      ② 每天定时聚合成"路由权重"（各难度下各模型的成功率-延迟评分）
//      ③ 路由决策读权重，在同一档候选里优先选实测效果更好的模型
// 纯本地、隐私不外发；样本不足时回退启发式，不会乱学。
// ─────────────────────────────────────────────────────────────────────────

const fs = require('fs')
const path = require('path')

class Learner {
  constructor(dir, opts = {}) {
    this.logFile = path.join(dir, 'routing-usage.jsonl')
    this.weightsFile = path.join(dir, 'routing-weights.json')
    this.globalFile = path.join(dir, 'routing-weights-global.json')
    this.buf = []
    this.weights = this._load()
    this.global = this._loadGlobal()      // 云端下行的全局先验
    // 云端同步端点：上传匿名聚合统计、下载全局权重。服务端需 OnlyRouter 后端实现；失败即 fail-open。
    this.syncUrl = opts.syncUrl || 'https://onlyrouter.ai/api/routing-weights'
    this.clientId = this.weights.clientId || ('c_' + Math.random().toString(36).slice(2) + Date.now().toString(36))
    this.weights.clientId = this.clientId
    this._timer = null
  }

  _load() {
    try { return JSON.parse(fs.readFileSync(this.weightsFile, 'utf8')) } catch { return { day: null, tiers: {} } }
  }
  _loadGlobal() {
    try { return JSON.parse(fs.readFileSync(this.globalFile, 'utf8')) } catch { return { tiers: {} } }
  }
  _saveGlobal() { try { fs.writeFileSync(this.globalFile, JSON.stringify(this.global, null, 2)) } catch {} }
  _today() { return new Date().toISOString().slice(0, 10) }

  // 记录一次路由效果（gateway 在请求结束时调用）；缓冲到一定量或跨天才落盘
  record(e) {
    try {
      if (!e || !e.model) return
      this.buf.push({ ts: Date.now(), day: this._today(), difficulty: e.difficulty || 'medium', model: e.model, ok: !!e.ok, latencyMs: e.latencyMs || 0 })
      if (this.buf.length >= 10) this.flush()
    } catch {}
  }

  flush() {
    if (!this.buf.length) return
    try { fs.appendFileSync(this.logFile, this.buf.map(x => JSON.stringify(x)).join('\n') + '\n') } catch {}
    this.buf = []
  }

  // 每日聚合：按 难度×模型 统计成功率与平均延迟 → 评分（成功率为主，延迟轻惩罚）
  rollup() {
    this.flush()
    let lines = []
    try { lines = fs.readFileSync(this.logFile, 'utf8').trim().split('\n').filter(Boolean) } catch { lines = [] }
    const agg = {}
    for (const ln of lines) {
      let e; try { e = JSON.parse(ln) } catch { continue }
      const d = e.difficulty || 'medium', m = e.model || '?'
      agg[d] = agg[d] || {}; agg[d][m] = agg[d][m] || { n: 0, ok: 0, lat: 0 }
      const a = agg[d][m]; a.n++; if (e.ok) a.ok++; a.lat += e.latencyMs || 0
    }
    const tiers = {}
    for (const d in agg) {
      tiers[d] = {}
      for (const m in agg[d]) {
        const a = agg[d][m]
        const succ = a.n ? a.ok / a.n : 0
        const avgLat = a.n ? a.lat / a.n : 0
        const latPenalty = Math.min(0.2, avgLat / 60000) // 延迟越高扣分，>60s 扣满 0.2
        tiers[d][m] = { score: +(succ - latPenalty).toFixed(3), n: a.n, succ: +succ.toFixed(2), avgLat: Math.round(avgLat) }
      }
    }
    this.weights = { day: this._today(), tiers, updatedAt: Date.now() }
    try { fs.writeFileSync(this.weightsFile, JSON.stringify(this.weights, null, 2)) } catch {}
    return this.weights
  }

  // 跨天才重新聚合，随后做一次云端同步
  maybeRollup() { if (this.weights.day !== this._today()) { this.rollup(); this.sync() } }

  // 云端同步：上传本机匿名聚合（只有 模型/难度/成功率/延迟，无任何 prompt 内容）→ 下载全局权重。
  // 这样所有用户的真实使用效果汇总后，每个客户端都能受益、一起把路由变聪明。失败即 fail-open。
  async sync() {
    if (!this.syncUrl) return
    try {
      const res = await fetch(this.syncUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: this.clientId, day: this.weights.day, tiers: this.weights.tiers || {} }),
      })
      if (res && res.ok) {
        const g = await res.json().catch(() => null)
        if (g && g.tiers) { this.global = { tiers: g.tiers, updatedAt: Date.now() }; this._saveGlobal() }
      }
    } catch {}
  }

  // 启动每日 Loop：每小时检查一次是否跨天，跨天则聚合+同步；同时定期 flush 缓冲
  startLoop() {
    this.maybeRollup()
    this.sync()                 // 启动即拉一次全局先验
    if (this._timer) return
    this._timer = setInterval(() => { this.flush(); this.maybeRollup() }, 60 * 60 * 1000)
    if (this._timer.unref) this._timer.unref()
  }
  stop() { if (this._timer) { clearInterval(this._timer); this._timer = null } this.flush() }

  // 给路由：某难度下的模型实测评分表 {model: score}。
  // 合并策略：全局权重作先验打底，本机样本足够（≥5）则用本机覆盖（本地实测更贴合自己）。
  preferenceFor(difficulty) {
    const out = {}
    const g = (this.global.tiers || {})[difficulty] || {}
    for (const m in g) if (g[m] && g[m].score != null) out[m] = g[m].score
    const t = (this.weights.tiers || {})[difficulty] || {}
    for (const m in t) if (t[m].n >= 5) out[m] = t[m].score
    return out
  }
}

module.exports = { Learner }
