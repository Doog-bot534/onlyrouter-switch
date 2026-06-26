const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,

  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (data) => ipcRenderer.invoke('save-config', data),
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  getVersion: () => ipcRenderer.invoke('get-version'),

  fetchModels: () => ipcRenderer.invoke('fetch-models'),
  fetchModelsAll: () => ipcRenderer.invoke('fetch-models-all'),
  validateKey: (key) => ipcRenderer.invoke('validate-key', key),

  // 生成面板：经主进程发鉴权请求（绕开 CORS），api-grab 跟随 302 取视频签名直链
  apiCall: (method, path, body) => ipcRenderer.invoke('api-call', { method, path, body }),
  apiGrab: (path) => ipcRenderer.invoke('api-grab', { path }),
  openTool: (tool) => ipcRenderer.invoke('open-tool', tool),

  // 配置成功后：帮用户开一个新终端窗口（新窗口会重读环境变量），cli 可选（codex/claude）
  restartTerminal: (cli) => ipcRenderer.invoke('restart-terminal', { cli }),
  // 重启 Codex App（GUI 常驻进程：退出再打开才会重读配置）
  restartApp: () => ipcRenderer.invoke('restart-app'),

  // 代理状态 + 开机自启
  proxyStatus: () => ipcRenderer.invoke('proxy-status'),
  getAutoLaunch: () => ipcRenderer.invoke('get-autolaunch'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('set-autolaunch', enabled),
  // 首次关窗最小化到托盘的一次性提示
  onTrayHint: (cb) => { ipcRenderer.removeAllListeners('tray-hint'); ipcRenderer.on('tray-hint', () => cb()) },

  checkInstall: (tool) => ipcRenderer.invoke('check-install', tool),

  writeCodexConfig: (model, key) => ipcRenderer.invoke('write-codex-config', { model, key }),
  readCodexModel: () => ipcRenderer.invoke('read-codex-model'),

  writeClaudeConfig: (key, model) => ipcRenderer.invoke('write-claude-config', { key, model }),
  checkClaudeConfigured: () => ipcRenderer.invoke('check-claude-configured'),

  writeVscodeConfig: (key, model) => ipcRenderer.invoke('write-vscode-config', { key, model }),

  openUrl: (url) => ipcRenderer.invoke('open-url', url),
  openNodejs: () => ipcRenderer.invoke('open-nodejs'),

  runInstall: (tool) => ipcRenderer.send('run-install', { tool }),
  installApp: (target) => ipcRenderer.send('install-app', { target }),
  onInstallOutput: (cb) => {
    ipcRenderer.removeAllListeners('install-output')
    ipcRenderer.on('install-output', (_, data) => cb(data))
  },
  onInstallDone: (cb) => {
    ipcRenderer.removeAllListeners('install-done')
    ipcRenderer.on('install-done', (_, data) => cb(data))
  },
})
