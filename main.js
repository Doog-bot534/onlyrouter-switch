const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { exec, execFile, spawn } = require('child_process')
const { startGateway } = require('./gateway')

// 本地翻译网关：Codex(Responses) → OnlyRouter(Chat) 双向翻译，解决 DeepSeek 等 chat-only 上游 404。
// 实际端口在启动时确定（占用则后移），写 config.toml 时取用。
let gatewayPort = null
let gatewayHandle = null
let gatewayStarting = null
async function ensureGateway() {
  if (gatewayHandle) return gatewayPort
  if (gatewayStarting) return gatewayStarting   // 去重：启动期间的并发调用复用同一次启动
  gatewayStarting = (async () => {
    try {
      gatewayHandle = await startGateway({
        upstream: 'https://onlyrouter.ai/v1', port: 8788,
        // 按工具读取各自的开关与模型（codex 走 /responses，claude 走 /messages）。
        // getOptions(tool) 由网关在三条路径分别调用，传入 'codex' / 'claude' / 'vscode'。
        getOptions: (tool) => {
          const known = (tool === 'claude' || tool === 'vscode') ? tool : 'codex'
          const t = toolConfig(loadConfig(), known)
          return { security: !!t.securityMode, smartRouting: !!t.smartMode, model: t.model }
        },
        // 网关接管鉴权：实时把已保存的 API Key 提供给网关注入请求头。
        // 客户端（Codex）只要环境变量「存在」即可，值不再重要——换 Key 不必重开终端。
        getKey: () => (loadConfig().key) || '',
      })
      gatewayPort = gatewayHandle.port
      // 持久化最终端口：供配置写入与「配置过期」自愈复用；探活复用旧实例时端口稳定不漂移
      try { saveConfig({ ...loadConfig(), gatewayPort }) } catch {}
      console.log('[gateway] ' + (gatewayHandle.reused ? 'reusing existing instance on' : 'listening on') + ' 127.0.0.1:' + gatewayPort)
    } catch (e) {
      console.error('[gateway] failed to start:', e && e.message)
    }
    gatewayStarting = null
    return gatewayPort
  })()
  return gatewayStarting
}

// ─── 下载源（国内免 VPN）────────────────────────────────────────
// Codex 桌面 App 安装包直链。⚠️ 默认指向 OpenAI 官方 CDN（国内需 VPN），
// 上线前请替换成你托管在国内的直链（阿里云 OSS / jsDelivr 等）。
const DOWNLOADS = {
  codexAppMacArm:   'https://persistent.oaistatic.com/codex-app-prod/Codex.dmg',
  codexAppMacIntel: 'https://persistent.oaistatic.com/codex-app-prod/Codex-latest-x64.dmg',
  codexAppWin:      '', // Codex App Windows 安装包直链（待补）
  nodejs:           'https://nodejs.cn/download/', // Node.js 中文站（国内可访问）
}
// CLI 走国内 npm 镜像，完全不需要 VPN
const NPM_REGISTRY = 'https://registry.npmmirror.com'

// ─── 持久化存储 ────────────────────────────────────────────────
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json')

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }
  catch { return {} }
}
function saveConfig(data) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2))
}

// 按工具取配置（codex/claude 各自的 model + smartMode + securityMode）。
// 向后兼容：旧版是扁平 { model, smartMode, securityMode } 全局共用——若没有分组字段则回退到扁平值。
function toolConfig(cfg, tool) {
  cfg = cfg || {}
  const sub = cfg[tool]
  if (sub && typeof sub === 'object') return sub
  // 迁移回退：用旧的扁平字段作两工具的同值默认
  return { model: cfg.model, smartMode: !!cfg.smartMode, securityMode: !!cfg.securityMode }
}

// ─── 窗口 ───────────────────────────────────────────────────────
let mainWindow = null
let tray = null

function createWindow() {
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); return mainWindow }
  const win = new BrowserWindow({
    width: 660,
    height: 740,
    minWidth: 460,
    minHeight: 560,
    resizable: true,
    maximizable: true,
    fullscreenable: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#09090b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))

  // 关窗不退：隐藏到托盘，让本地代理在后台继续跑，codex/claude 随时可用。
  // 仅托盘「退出」(app.isQuitting=true) 时才真正关闭。
  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault()
      win.hide()
      if (process.platform === 'darwin' && app.dock) app.dock.hide()  // mac：藏 dock 图标，纯托盘驻留
      // 首次隐藏提示一次（小白不知道关窗≠退出）
      const c = loadConfig()
      if (!c.trayHintShown) {
        try { win.webContents.send('tray-hint') } catch {}
        saveConfig({ ...loadConfig(), trayHintShown: true })
      }
    }
  })
  mainWindow = win
  return win
}

function showMainWindow() {
  if (process.platform === 'darwin' && app.dock) app.dock.show()
  if (mainWindow) { mainWindow.show(); mainWindow.focus() }
  else createWindow()
}

// 托盘图标：macOS 用模板图（仅 alpha 定义形状，系统自动染成黑/白以贴合菜单栏）。
// 文件名带 Template 后缀 + @2x，nativeImage 会自动识别模板并加载 Retina 版本。
function buildTray() {
  if (tray) return
  const isMac = process.platform === 'darwin'
  const iconName = isMac ? 'trayTemplate.png' : 'icon.png'
  let img = nativeImage.createFromPath(path.join(__dirname, 'assets', iconName))
  if (isMac) {
    img.setTemplateImage(true)            // 显式标记，确保系统自动跟随浅色/深色菜单栏染色
  } else if (!img.isEmpty()) {
    img = img.resize({ width: 18, height: 18 })
  }
  try { tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img) } catch { return }
  tray.setToolTip('OnlyRouter Switch')
  refreshTrayMenu()
  tray.on('click', () => showMainWindow())   // win/linux 单击唤起
}

function refreshTrayMenu() {
  if (!tray) return
  const openAtLogin = !!app.getLoginItemSettings().openAtLogin
  const portLabel = gatewayPort ? `本地代理：运行中 :${gatewayPort}` : '本地代理：未启动'
  const menu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => showMainWindow() },
    { label: portLabel, enabled: false },
    { type: 'separator' },
    { label: '开机自动启动', type: 'checkbox', checked: openAtLogin, click: (item) => setAutoLaunch(item.checked) },
    { type: 'separator' },
    { label: '退出 OnlyRouter Switch', click: () => { app.isQuitting = true; app.quit() } },
  ])
  tray.setContextMenu(menu)
}

function setAutoLaunch(enabled) {
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true })
    saveConfig({ ...loadConfig(), openAtLogin: enabled })
  } catch (e) { console.error('[autolaunch]', e && e.message) }
  refreshTrayMenu()
}

// ─── 单实例锁：第二次启动只唤起已有窗口，避免双代理抢端口 ──
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow())

  app.whenReady().then(() => {
    ensureGateway().then(() => refreshTrayMenu())
    buildTray()
    createWindow()
    // 首次启动：默认开启开机自启（小白无感常驻）；用户可在托盘关掉。仅设置一次。
    const c = loadConfig()
    if (c.openAtLogin === undefined) setAutoLaunch(true)
  })

  // 关窗不退（所有平台都靠托盘驻留）；真正退出只经托盘「退出」
  app.on('window-all-closed', () => { /* 不退出：保活后台代理 */ })
  app.on('activate', () => showMainWindow())
  app.on('before-quit', () => { app.isQuitting = true; try { gatewayHandle && gatewayHandle.close() } catch {} })
}

// ─── 工具函数 ───────────────────────────────────────────────────
// 安全校验：模型名只允许已知字符集（字母/数字/. _ - /），防止写 config.toml 时引号/换行注入额外配置项。
function isValidModelName(m) {
  return typeof m === 'string' && m.length > 0 && m.length <= 100 && /^[A-Za-z0-9._\/-]+$/.test(m)
}
// API Key 形态校验：sk- 开头，仅安全字符，限长，防止后续拼进 shell/setx 时注入。
function isValidKey(k) {
  return typeof k === 'string' && /^sk-[A-Za-z0-9._-]{8,200}$/.test(k)
}
// 环境变量值转义（写 shell rc 用）：用单引号包裹并转义内部单引号，杜绝 $()/`` 等命令替换与换行注入。
function shQuote(v) {
  return "'" + String(v).replace(/'/g, "'\\''") + "'"
}

function getShellRC() {
  const shell = process.env.SHELL || '/bin/zsh'
  if (shell.includes('zsh')) return path.join(os.homedir(), '.zshrc')
  if (shell.includes('bash')) return path.join(os.homedir(), '.bash_profile')
  return path.join(os.homedir(), '.profile')
}

function setEnvVarMac(name, value) {
  const rcFile = getShellRC()
  let content = ''
  let existed = false
  if (fs.existsSync(rcFile)) {
    content = fs.readFileSync(rcFile, 'utf8')
    existed = content.split('\n').some(line => line.trim().startsWith(`export ${name}=`))
    content = content.split('\n').filter(line =>
      !line.trim().startsWith(`export ${name}=`)).join('\n')
    if (!content.endsWith('\n')) content += '\n'
  }
  // 单引号包裹并转义，杜绝 value 内的 "、$()、`` 、换行污染 shell rc（命令/配置注入）
  content += `export ${name}=${shQuote(value)}\n`
  fs.writeFileSync(rcFile, content)
  return existed
}
function setEnvVarWin(name, value) {
  // 不经 shell：execFile 直接传参数数组给 setx，避免 value 内引号/&|^ 等污染命令行。
  // setx 失败再回退 PowerShell（同样用 execFile + 参数数组，值里单引号翻倍转义）。
  const existed = !!process.env[name]
  return new Promise((resolve, reject) => {
    execFile('setx', [name, value], (err) => {
      if (!err) return resolve(existed)
      const ps = `[Environment]::SetEnvironmentVariable('${name}','${String(value).replace(/'/g, "''")}','User')`
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], (e2, o2, s2) => {
        if (e2) reject(new Error(((s2 || e2.message || '') + '').trim() || '环境变量设置失败'))
        else resolve(existed)
      })
    })
  })
}
// 返回 true=该变量之前已存在（仅刷新值，网关接管鉴权后已开终端无需重启）；false=首次创建（需重开终端一次）
async function setEnvVar(name, value) {
  if (process.platform === 'win32') return await setEnvVarWin(name, value)
  return setEnvVarMac(name, value)
}

// 在用户 login shell 里跑命令（继承 PATH，能找到 node/npm）
function loginShellSpawn(cmd) {
  if (process.platform === 'win32') return spawn('cmd', ['/c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] })
  const userShell = process.env.SHELL || '/bin/zsh'
  // -i(交互)让 shell 读 .zshrc，才能拿到 nvm / ~/.local/bin 等写在那里的 PATH，否则 npm/node 可能找不到
  return spawn(userShell, ['-il', '-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] })
}

// ─── IPC：配置/模型 ─────────────────────────────────────────────
ipcMain.handle('get-config', () => loadConfig())
ipcMain.handle('save-config', (_, data) => { saveConfig({ ...loadConfig(), ...data }); return true })
ipcMain.handle('get-platform', () => process.platform)

// 代理状态：供主界面显示「运行中 :端口」+ 一键自愈（重新探活/重写配置端口）
ipcMain.handle('proxy-status', async () => {
  const port = await ensureGateway()
  let healthy = false
  if (port) { try { const r = await fetch(`http://127.0.0.1:${port}/health`); healthy = r.ok } catch {} }
  return { port, healthy }
})

// 开机自启：读/写。写入后刷新托盘菜单勾选态。
ipcMain.handle('get-autolaunch', () => ({ openAtLogin: !!app.getLoginItemSettings().openAtLogin }))
ipcMain.handle('set-autolaunch', (_, enabled) => { setAutoLaunch(!!enabled); return { success: true } })

const mapModel = m => ({
  name: m.name, display_name: m.display_name,
  model_type: m.model_type || 'text',
  input_price: m.input_price != null ? parseFloat(m.input_price) : null,
  output_price: m.output_price != null ? parseFloat(m.output_price) : null,
  // 缓存价：智能路由的缓存经济性比较要用；国产模型 cache_write_price 常为 null，下游兜底
  cache_write_price: m.cache_write_price != null ? parseFloat(m.cache_write_price) : null,
  cache_read_price: m.cache_read_price != null ? parseFloat(m.cache_read_price) : null,
  context_window: m.context_window,
  max_output_tokens: m.max_output_tokens || null,
  // 图像/视频模型字段：生成面板与模态路由用
  pricing: m.pricing || null,
  image_output: m.image_output || null,
})

// 拉取并缓存全量模型表（含 text/image/video），供智能路由与生成面板共用
let modelsCache = { at: 0, all: [] }
async function fetchAllModels() {
  if (Date.now() - modelsCache.at < 60000 && modelsCache.all.length) return modelsCache.all
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 6000)
  const res = await fetch('https://onlyrouter.ai/api/models', { signal: ctrl.signal })
  clearTimeout(timer)
  const data = await res.json()
  const raw = Array.isArray(data) ? data : (data.data || [])
  const all = raw.filter(m => m.is_active).map(mapModel)
  if (all.length) modelsCache = { at: Date.now(), all }
  return all
}

ipcMain.handle('fetch-models', async () => {
  try {
    const all = await fetchAllModels()
    const models = all.filter(m => m.model_type === 'text')
    if (models.length === 0) throw new Error('empty')
    return { ok: true, source: 'live', models }
  } catch (e) {
    try {
      const fb = JSON.parse(fs.readFileSync(path.join(__dirname, 'renderer', 'models-fallback.json'), 'utf8'))
      return { ok: true, source: 'cache', models: fb }
    } catch {
      return { ok: false, error: e.message, models: [] }
    }
  }
})

// 生成面板用：返回全量（text/image/video）
ipcMain.handle('fetch-models-all', async () => {
  try {
    const all = await fetchAllModels()
    if (!all.length) throw new Error('empty')
    return { ok: true, models: all }
  } catch (e) {
    return { ok: false, error: e.message, models: [] }
  }
})

// 生成面板：经主进程发鉴权 API 请求（无 CORS）。返回完整状态与原始错误，便于小白复制报错。
const API_BASE = 'https://onlyrouter.ai/v1'
ipcMain.handle('api-call', async (_, { method, path, body }) => {
  try {
    // 路径白名单：只允许打到 OnlyRouter 的 /v1/* 端点，且方法限于读/生成类，防渲染层被污染后乱发请求
    if (typeof path !== 'string' || !path.startsWith('/v1/') || path.includes('..')) {
      return { ok: false, status: 0, error: '请求路径不合法' }
    }
    const allowed = ['GET', 'POST']
    const m = (method || 'GET').toUpperCase()
    if (!allowed.includes(m)) return { ok: false, status: 0, error: '请求方法不允许' }
    const key = (loadConfig().key) || ''
    if (!key) return { ok: false, status: 0, error: '未配置 API Key，请先在上方填写并验证 Key。' }
    const r = await fetch(API_BASE + path, {
      method: m,
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await r.text()
    let json; try { json = JSON.parse(text) } catch { json = { raw: text } }
    if (!r.ok) {
      const msg = (json && json.error && (json.error.message || json.error)) || text || ('HTTP ' + r.status)
      return { ok: false, status: r.status, error: String(msg).slice(0, 1000), json }
    }
    return { ok: true, status: r.status, json }
  } catch (e) {
    return { ok: false, status: 0, error: '网络错误：' + (e && e.message) }
  }
})

// 视频/文件取流：跟随 302 到 CDN，回签名直链（不经函数传字节）；上游直接回二进制则转 data URL 兜底
ipcMain.handle('api-grab', async (_, { path }) => {
  try {
    const key = (loadConfig().key) || ''
    if (!path || !path.startsWith('/v1/') || path.includes('..')) return { ok: false, error: '路径不合法' }
    let url = 'https://onlyrouter.ai' + path
    let hops = 0
    while (hops < 5) {
      const r = await fetch(url, { headers: { Authorization: 'Bearer ' + key, Accept: '*/*' }, redirect: 'manual' })
      const loc = r.headers.get('location')
      if ([301, 302, 303, 307, 308].includes(r.status) && loc) {
        if (/^https?:\/\//i.test(loc)) return { ok: true, url: loc }   // CDN 签名直链
        url = 'https://onlyrouter.ai' + loc; hops++; continue
      }
      if (!r.ok) return { ok: false, error: 'HTTP ' + r.status + '：' + (await r.text()).slice(0, 300) }
      const ct = r.headers.get('content-type') || ''
      if (/json|text\/html/.test(ct)) return { ok: false, error: '上游返回非媒体内容：' + (await r.text()).slice(0, 200) }
      const buf = Buffer.from(await r.arrayBuffer())
      return { ok: true, url: 'data:' + (ct || 'video/mp4') + ';base64,' + buf.toString('base64') }
    }
    return { ok: false, error: '重定向次数过多' }
  } catch (e) {
    return { ok: false, error: '取流失败：' + (e && e.message) }
  }
})

ipcMain.handle('validate-key', async (_, key) => {
  if (!key || !key.startsWith('sk-')) return { valid: false, reason: '格式错误，应以 sk- 开头' }
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    const res = await fetch('https://onlyrouter.ai/v1/models', {
      headers: { Authorization: 'Bearer ' + key }, signal: ctrl.signal,
    })
    clearTimeout(timer)
    if (res.status === 200) return { valid: true }
    if (res.status === 401 || res.status === 403) return { valid: false, reason: 'Key 无效或已被禁用' }
    return { valid: false, reason: '服务返回 ' + res.status }
  } catch {
    return { valid: false, reason: '无法连接服务器，请检查网络', offline: true }
  }
})

// ─── 安装状态检测 ───────────────────────────────────────────────
function codexAppPaths() {
  if (process.platform === 'darwin') {
    return ['/Applications/Codex.app', path.join(os.homedir(), 'Applications/Codex.app')]
  }
  return [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'codex', 'Codex.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Codex', 'Codex.exe'),
    'C:\\Program Files\\Codex\\Codex.exe',
  ]
}

function whichCli(bin) {
  return new Promise(resolve => {
    if (process.platform === 'win32') {
      return exec(`where ${bin}`, (err, stdout) => resolve(!err && stdout.trim().length > 0))
    }
    // 交互式登录 shell(-ilc):会读 .zshrc，才能拿到写在那里的 PATH/别名/函数。
    // 非交互登录 shell(-lc)只读 .zprofile/.zlogin，会漏掉 nvm、~/.local/bin、claude 本地安装等。
    // command -v 还能识别别名与 shell 函数（部分安装方式用别名暴露 claude）。
    const shell = process.env.SHELL || '/bin/zsh'
    exec(`${shell} -ilc 'command -v ${bin}'`, (err, stdout) => {
      if (!err && stdout.trim().length > 0) return resolve(true)
      // 兜底：直接查常见安装路径（shell 探测失败也能命中）
      const home = os.homedir()
      const candidates = [
        path.join(home, '.local/bin', bin),
        path.join(home, '.claude/local', bin),
        '/usr/local/bin/' + bin,
        '/opt/homebrew/bin/' + bin,
        path.join(home, '.npm-global/bin', bin),
      ]
      resolve(candidates.some(p => fs.existsSync(p)))
    })
  })
}

ipcMain.handle('check-install', async (_, tool) => {
  if (tool === 'codex-app') {
    return { installed: codexAppPaths().some(p => fs.existsSync(p)) }
  }
  if (tool === 'node') {
    return { installed: await whichCli('node') }
  }
  if (tool === 'vscode') {
    // 装了 Continue 扩展即算「可一键配置」；否则看 VS Code 本体是否装（提示先装扩展）
    return { installed: hasContinueExt(), editor: hasVSCode(), ext: hasContinueExt() }
  }
  const bin = tool === 'codex-cli' ? 'codex' : 'claude'
  return { installed: await whichCli(bin) }
})

// VS Code 本体是否安装（app 路径 或 code CLI 落点）
function hasVSCode() {
  const home = os.homedir()
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Visual Studio Code.app', path.join(home, 'Applications/Visual Studio Code.app')]
    : process.platform === 'win32'
      ? [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
         'C:\\Program Files\\Microsoft VS Code\\Code.exe']
      : ['/usr/bin/code', '/usr/local/bin/code', '/snap/bin/code']
  return candidates.some(p => fs.existsSync(p))
}
// Continue 扩展是否安装（扩展解压在 ~/.vscode/extensions/continue.continue-*）
function hasContinueExt() {
  try {
    const extDir = path.join(os.homedir(), '.vscode', 'extensions')
    return fs.readdirSync(extDir).some(n => n.toLowerCase().startsWith('continue.continue'))
  } catch { return false }
}

// ─── 打开已安装的工具 ───────────────────────────────────────────
ipcMain.handle('open-tool', (_, tool) => {
  try {
    if (tool === 'codex-app') {
      if (process.platform === 'darwin') spawn('open', ['-a', 'Codex'])
      else {
        const exe = codexAppPaths().find(p => fs.existsSync(p))
        if (exe) spawn(exe, [], { detached: true })
      }
      return { success: true }
    }
    // CLI：开终端并自动运行
    const cli = tool === 'codex-cli' ? 'codex' : 'claude'
    if (process.platform === 'darwin') {
      spawn('osascript', ['-e', `tell application "Terminal"\nactivate\ndo script "${cli}"\nend tell`])
    } else if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', 'cmd', '/k', cli], { detached: true })
    } else {
      spawn('x-terminal-emulator', ['-e', cli], { detached: true })
    }
    return { success: true }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

// ─── 帮我重启终端 ───────────────────────────────────────────────
// 配置成功后，刚写入的环境变量(~/.zshrc / 用户环境变量)只对**新开**的终端生效。
// 这里直接开一个**全新**终端窗口，新窗口会重读 rc 文件拿到新变量，省去用户手动操作。
// 注：无法热刷新用户已经开着的旧窗口（OS 限制），只能开新的。
ipcMain.handle('restart-terminal', (_, { cli } = {}) => {
  try {
    if (process.platform === 'darwin') {
      // 开新 Terminal 窗口（do script 不带命令=只开窗口并重读 .zshrc）；带 cli 则顺带运行
      const script = cli
        ? `tell application "Terminal"\nactivate\ndo script "${cli}"\nend tell`
        : `tell application "Terminal"\nactivate\ndo script ""\nend tell`
      spawn('osascript', ['-e', script])
    } else if (process.platform === 'win32') {
      // 开新 cmd 窗口（start 会让它继承最新用户环境变量）；带 cli 则用 /k 保留窗口并运行
      if (cli) spawn('cmd', ['/c', 'start', 'cmd', '/k', cli], { detached: true })
      else spawn('cmd', ['/c', 'start', 'cmd'], { detached: true })
    } else {
      spawn('x-terminal-emulator', cli ? ['-e', cli] : [], { detached: true })
    }
    return { success: true }
  } catch (e) {
    return { success: false, error: (e && e.message) || String(e) }
  }
})

// ─── 帮我重启 Codex App ─────────────────────────────────────────
// App（GUI）不像 CLI 那样开新窗口就行——它是常驻进程，得先退出再重新打开才会重读配置。
// 退出有延迟，等一下再 open，避免「还没退干净就启动」导致旧进程被复用。
ipcMain.handle('restart-app', () => {
  try {
    if (process.platform === 'darwin') {
      // 先优雅退出 Codex，再延时重新打开；quit 失败（没在跑）也无所谓，直接 open
      const script = `try
  tell application "Codex" to quit
end try
delay 1
do shell script "open -a Codex"`
      spawn('osascript', ['-e', script])
    } else {
      const exe = codexAppPaths().find(p => fs.existsSync(p))
      // Windows：先杀掉再重启（taskkill 找不到进程会报错，忽略即可）
      execFile('taskkill', ['/IM', 'Codex.exe', '/F'], () => {
        setTimeout(() => { if (exe) spawn(exe, [], { detached: true }) }, 1000)
      })
    }
    return { success: true }
  } catch (e) {
    return { success: false, error: (e && e.message) || String(e) }
  }
})

// ─── 配置写入 ───────────────────────────────────────────────────
// Codex App 与 CLI 共用 ~/.codex/config.toml
ipcMain.handle('write-codex-config', async (_, { model, key }) => {
  // 入参校验：拒绝非法 model/key（防 TOML 注入 + shell 注入）
  if (!isValidModelName(model)) return { success: false, error: '模型名不合法（只允许字母数字和 . _ - /）' }
  if (!isValidKey(key)) return { success: false, error: 'API Key 格式不合法（应以 sk- 开头）' }
  const configDir = path.join(os.homedir(), '.codex')
  const configPath = path.join(configDir, 'config.toml')
  // base_url 指向本地翻译网关；网关把 responses 翻成 chat 转发上游，DeepSeek 等 chat-only 模型才不再 404。
  // 网关未起来时退回直连 onlyrouter（非 chat-only 模型仍可用），保证不至于完全不可用。
  const port = await ensureGateway()
  const baseUrl = port ? `http://127.0.0.1:${port}/v1` : 'https://onlyrouter.ai/v1'
  // 沙箱策略改保守默认（不再写死 never + danger-full-access）：
  //   approval_policy=on-request → 需要时才向用户请求授权；sandbox_mode=workspace-write → 仅当前工作区可写。
  //   这样 Codex 不会在用户机器上无审批执行高权限文件/命令操作。model 已经过白名单校验，可安全内插。
  const config = `model = "${model}"
model_provider = "onlyrouter"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[model_providers.onlyrouter]
name = "OnlyRouter"
base_url = "${baseUrl}"
env_key = "ONLYROUTER_API_KEY"
wire_api = "responses"
`
  try {
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(configPath, config)
  } catch (e) {
    return { success: false, error: '写入 config.toml 失败：' + (e && e.message) }
  }
  // 环境变量单独兜底：写文件成功但 setx/rc 失败时，给出明确提示而不是整体静默失败。
  // envExisted=true 表示变量之前已存在，网关接管鉴权后已开终端会用最新 Key，无需重启；
  // false=首次创建变量，Codex 客户端要求该变量存在才肯发请求，需重开终端一次。
  let envExisted = false
  try {
    envExisted = await setEnvVar('ONLYROUTER_API_KEY', key)
  } catch (e) {
    return { success: true, configPath, envOk: false, error: '配置已写入，但设置环境变量失败：' + (e && e.message) }
  }
  return { success: true, configPath, envOk: true, needRestart: !envExisted }
})

ipcMain.handle('read-codex-model', () => {
  try {
    const content = fs.readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8')
    const match = content.match(/^model\s*=\s*"([^"]+)"/m)
    // 已改用本地网关后 base_url 不再含 onlyrouter.ai，故按 provider 名判定是否已配置
    const configured = /model_provider\s*=\s*"onlyrouter"/.test(content) || content.includes('onlyrouter.ai')
    return { model: match ? match[1] : null, configured }
  } catch {
    return { model: null, configured: false }
  }
})

// Claude Code CLI：写 ~/.claude/settings.json 的 env 块（最可靠）
ipcMain.handle('write-claude-config', async (_, { key, model }) => {
  // 入参校验（key 必合法；model 可空，传了则需合法）——settings.json 是 JSON.stringify 落盘，
  // 本身无注入风险，但仍校验以防把脏值写进用户配置。
  if (!isValidKey(key)) return { success: false, error: 'API Key 格式不合法（应以 sk- 开头）' }
  if (model != null && model !== '' && !isValidModelName(model)) return { success: false, error: '模型名不合法' }
  const dir = path.join(os.homedir(), '.claude')
  const file = path.join(dir, 'settings.json')
  let cfg = {}
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
  // base_url 指向本地代理：Claude Code 会向 <base>/v1/messages 发请求，网关同协议直通上游，
  // 并让智能路由/安全网关也覆盖 Claude Code。网关未起来时退回直连 onlyrouter，保证不至于完全不可用。
  const port = await ensureGateway()
  const baseUrl = port ? `http://127.0.0.1:${port}` : 'https://onlyrouter.ai'
  cfg.env = {
    ...(cfg.env || {}),
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: key,
  }
  if (model) cfg.env.ANTHROPIC_MODEL = model
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2))
  return { success: true }
})

ipcMain.handle('check-claude-configured', () => {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'))
    const url = cfg.env && cfg.env.ANTHROPIC_BASE_URL
    // 已配置 = base_url 指向本地代理(127.0.0.1)或 onlyrouter（兼容旧版直连配置）
    return { configured: !!(url && (url.includes('127.0.0.1') || url.includes('onlyrouter'))) }
  } catch {
    return { configured: false }
  }
})

// VS Code（Continue 扩展）：写 ~/.continue/config.yaml 的 models 块。
// Continue 用 OpenAI 兼容 provider，apiBase 指向本地网关，走 /v1/chat/completions
// → 网关 handleChat 做智能路由/安全/流式。apiKey 内联真 Key（Continue 要求非空），
//   网关仍会用 config.json 的最新 Key 注入鉴权，故换 Key 不必重写本文件也能生效。
// 配置即时生效（Continue 监听文件变更，最多重载窗口），无需重启。
ipcMain.handle('write-vscode-config', async (_, { key, model }) => {
  if (!isValidKey(key)) return { success: false, error: 'API Key 格式不合法（应以 sk- 开头）' }
  if (model != null && model !== '' && !isValidModelName(model)) return { success: false, error: '模型名不合法' }
  const dir = path.join(os.homedir(), '.continue')
  const file = path.join(dir, 'config.yaml')
  const port = await ensureGateway()
  const baseUrl = port ? `http://127.0.0.1:${port}/v1` : 'https://onlyrouter.ai/v1'
  const m = model || 'gpt-5.5'
  // 纯文本 YAML：model/key 已白名单校验，安全内插。roles 覆盖聊天/补全/编辑/应用。
  const yaml = `name: OnlyRouter
version: 1.0.0
schema: v1
models:
  - name: OnlyRouter (${m})
    provider: openai
    model: ${m}
    apiBase: ${baseUrl}
    apiKey: ${key}
    roles:
      - chat
      - edit
      - apply
`
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, yaml)
  } catch (e) {
    return { success: false, error: '写入 config.yaml 失败：' + (e && e.message) }
  }
  return { success: true, configPath: file }
})

ipcMain.handle('open-url', (_, url) => { shell.openExternal(url) })

// ─── 安装 CLI（npm + 国内镜像，App 后台代劳）────────────────────
ipcMain.on('run-install', (event, { tool }) => {
  const pkg = { 'codex-cli': '@openai/codex', 'claude': '@anthropic-ai/claude-code' }[tool]
  if (!pkg) { event.sender.send('install-done', { code: 1, error: '未知工具' }); return }

  const cmd = `npm install -g ${pkg} --registry=${NPM_REGISTRY}`
  const child = loginShellSpawn(cmd)
  child.stdout.on('data', d => event.sender.send('install-output', d.toString()))
  child.stderr.on('data', d => event.sender.send('install-output', d.toString()))
  child.on('close', code => event.sender.send('install-done', { code, success: code === 0, tool }))
  child.on('error', err => event.sender.send('install-done', { code: 1, error: err.message, tool }))
})

// ─── 安装 Codex App（后台下载安装包 → 自动安装，零终端）─────────
// 安全：全程用 execFile + 参数数组（不拼 shell），并严格校验 .app 名称，
// 防止安装包来源被替换/app 名称异常导致命令注入或误删。
function execFileP(cmd, args) {
  return new Promise((resolve, reject) => execFile(cmd, args, (err, stdout, stderr) => err ? reject(err) : resolve(stdout)))
}
function installDmg(dmgPath) {
  return new Promise((resolve, reject) => {
    execFile('hdiutil', ['attach', '-nobrowse', '-noverify', dmgPath], async (err, stdout) => {
      if (err) return reject(new Error('挂载安装包失败'))
      const m = stdout.match(/(\/Volumes\/[^\n]+?)\s*$/m) || stdout.match(/(\/Volumes\/.+)/)
      const vol = m ? m[1].trim() : null
      if (!vol) return reject(new Error('未找到安装卷'))
      let appName
      try { appName = fs.readdirSync(vol).find(f => f.endsWith('.app')) } catch {}
      // 严格校验：必须是单段 .app 名（不含 / 或 .. 等路径穿越/注入字符）
      const safeName = appName && /^[A-Za-z0-9 ._-]+\.app$/.test(appName) && !appName.includes('..')
      if (!safeName) { try { await execFileP('hdiutil', ['detach', vol]) } catch {}; return reject(new Error('安装包内未找到合法应用')) }
      const dstApp = `/Applications/${appName}`
      try {
        await execFileP('rm', ['-rf', dstApp])
        await execFileP('cp', ['-R', `${vol}/${appName}`, '/Applications/'])
        try { await execFileP('xattr', ['-dr', 'com.apple.quarantine', dstApp]) } catch {}
        resolve()
      } catch (e) {
        reject(new Error('复制到应用程序失败（可能需要权限）'))
      } finally {
        try { await execFileP('hdiutil', ['detach', vol]) } catch {}
      }
    })
  })
}

ipcMain.on('install-app', async (event, { target }) => {
  try {
    let url, ext
    if (process.platform === 'darwin') {
      url = process.arch === 'arm64' ? DOWNLOADS.codexAppMacArm : DOWNLOADS.codexAppMacIntel
      ext = 'dmg'
    } else if (process.platform === 'win32') {
      url = DOWNLOADS.codexAppWin; ext = 'exe'
    }
    if (!url) {
      event.sender.send('install-done', { code: 1, error: '暂无当前平台的安装包，请联系管理员', tool: target })
      return
    }

    const dest = path.join(os.tmpdir(), `Codex-installer.${ext}`)
    event.sender.send('install-output', '开始下载 Codex 安装包…\n')

    const res = await fetch(url)
    if (!res.ok) throw new Error('下载失败 HTTP ' + res.status)
    const total = parseInt(res.headers.get('content-length') || '0', 10)
    const out = fs.createWriteStream(dest)
    let recv = 0, lastPct = -1
    const reader = res.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      out.write(Buffer.from(value))
      recv += value.length
      if (total) {
        const pct = Math.floor(recv / total * 100)
        if (pct !== lastPct && pct % 5 === 0) {
          lastPct = pct
          event.sender.send('install-output', `下载中… ${pct}%（${(recv / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)} MB）\n`)
        }
      }
    }
    out.end()
    await new Promise(r => out.on('finish', r))
    event.sender.send('install-output', '下载完成，正在安装…\n')

    if (process.platform === 'darwin') {
      await installDmg(dest)
      event.sender.send('install-output', '已安装到「应用程序」\n')
    } else {
      spawn(dest, [], { detached: true }) // 运行 Windows 安装程序
      event.sender.send('install-output', '已启动安装程序，请按提示完成\n')
    }
    event.sender.send('install-done', { code: 0, success: true, tool: target })
  } catch (e) {
    event.sender.send('install-done', { code: 1, error: e.message, tool: target })
  }
})

// 打开 Node.js 下载页（国内）
ipcMain.handle('open-nodejs', () => { shell.openExternal(DOWNLOADS.nodejs) })
