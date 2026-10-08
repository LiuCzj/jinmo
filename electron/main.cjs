/**
 * Electron 主进程：窗口、原生菜单、文件读写、最近文件、窗口状态。
 *
 * 使用 CommonJS 而非 TypeScript：这是独立于渲染层的薄壳，省掉一套编译步骤。
 */

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

// 被当作普通 Node 运行时 require('electron') 只会拿到二进制路径，这里给出明确提示
if (!ipcMain) {
  console.error('必须以 Electron 启动，且不要设置 ELECTRON_RUN_AS_NODE。');
  process.exit(1);
}

// 数据目录（窗口状态、最近文件、Chromium 缓存）：默认跟随系统；
// 设置 JINMO_DATA_DIR 可指到其他盘。必须在 app ready 之前调用。
if (process.env.JINMO_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.JINMO_DATA_DIR));
}

/** 开发模式加载 Vite 开发服务器，否则加载单文件构建产物 */
const DEV = process.argv.includes('--dev');
const SELFTEST = process.argv.includes('--selftest');
const DEV_URL = 'http://localhost:5173';
const PROD_HTML = path.join(__dirname, '..', 'dist', 'markdown-editor.html');

// 自检常在无 GPU 的环境里跑，关掉硬件加速并放宽沙箱，否则 GPU 进程崩溃会拖垮整个应用
if (SELFTEST) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('in-process-gpu');
}

const RECENT_MAX = 10;
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
const recentFile = () => path.join(app.getPath('userData'), 'recent-files.json');

/** @type {BrowserWindow | null} */
let win = null;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch {
    // 写入失败不影响使用，忽略
  }
}

/** 读取窗口状态；数值越界或缺失时回退到默认值 */
function loadWindowState() {
  const s = readJson(stateFile(), {});
  const hasSize = Number.isFinite(s.width) && Number.isFinite(s.height);
  return {
    width: hasSize ? Math.max(640, s.width) : 1100,
    height: hasSize ? Math.max(480, s.height) : 820,
    x: Number.isFinite(s.x) ? s.x : undefined,
    y: Number.isFinite(s.y) ? s.y : undefined,
    maximized: Boolean(s.maximized),
  };
}

/** 记录窗口位置、尺寸与最大化状态 */
function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  const maximized = win.isMaximized();
  const bounds = maximized ? win.getNormalBounds() : win.getBounds();
  writeJson(stateFile(), { ...bounds, maximized });
}

function loadRecent() {
  const list = readJson(recentFile(), []);
  return Array.isArray(list) ? list.filter((p) => typeof p === 'string') : [];
}

/** 把路径插到最近列表最前面 */
function pushRecent(filePath) {
  const next = [filePath, ...loadRecent().filter((p) => p !== filePath)].slice(0, RECENT_MAX);
  writeJson(recentFile(), next);
  return next;
}

/** 读文件，失败时弹错误框并返回 null */
function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    dialog.showErrorBox('打开失败', `${filePath}\n\n${err.message}`);
    return null;
  }
}

/** 把文件送进渲染进程，并更新最近列表与窗口标题 */
function deliverFile(filePath) {
  const content = readFileSafe(filePath);
  if (content === null) return false;
  pushRecent(filePath);
  buildMenu();
  win?.webContents.send('open-file', { path: filePath, content });
  win?.setTitle(`${path.basename(filePath)} — jinmo`);
  return true;
}

/** 菜单里发给渲染进程的命令 */
const send = (id) => () => win?.webContents.send('menu', id);

function buildMenu() {
  const recent = loadRecent();
  const recentItems = recent.length
    ? [
        ...recent.map((p) => ({
          label: path.basename(p),
          toolTip: p,
          click: () => deliverFile(p),
        })),
        { type: 'separator' },
        {
          label: '清除列表',
          click: () => {
            writeJson(recentFile(), []);
            buildMenu();
          },
        },
      ]
    : [{ label: '（暂无）', enabled: false }];

  const template = [
    {
      label: '文件',
      submenu: [
        { label: '新建', accelerator: 'CmdOrCtrl+N', click: send('new') },
        { label: '打开…', accelerator: 'CmdOrCtrl+O', click: () => pickAndOpen() },
        { label: '最近打开', submenu: recentItems },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: send('save') },
        { label: '另存为…', accelerator: 'CmdOrCtrl+Shift+S', click: send('save-as') },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', accelerator: 'CmdOrCtrl+Z', click: send('undo') },
        { label: '重做', accelerator: 'CmdOrCtrl+Shift+Z', click: send('redo') },
        { type: 'separator' },
        { label: '剪切', accelerator: 'CmdOrCtrl+X', role: 'cut' },
        { label: '复制', accelerator: 'CmdOrCtrl+C', role: 'copy' },
        { label: '粘贴', accelerator: 'CmdOrCtrl+V', role: 'paste' },
        { type: 'separator' },
        { label: '全选', accelerator: 'CmdOrCtrl+A', click: send('select-all') },
        { type: 'separator' },
        { label: '查找', accelerator: 'CmdOrCtrl+F', click: send('find') },
        { label: '替换', accelerator: 'CmdOrCtrl+H', click: send('replace') },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '源码模式', accelerator: 'CmdOrCtrl+/', click: send('toggle-source') },
        { type: 'separator' },
        { label: '专注模式', accelerator: 'F8', click: send('toggle-focus') },
        { label: '打字机模式', accelerator: 'F9', click: send('toggle-typewriter') },
        { type: 'separator' },
        { label: '放大', accelerator: 'CmdOrCtrl+Plus', role: 'zoomIn' },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', role: 'zoomOut' },
        { label: '重置缩放', accelerator: 'CmdOrCtrl+0', role: 'resetZoom' },
        { type: 'separator' },
        { label: '开发者工具', accelerator: 'F12', role: 'toggleDevTools' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '关于', click: showAbout },
        { label: '项目主页', click: () => shell.openExternal('https://github.com/') },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function pickAndOpen() {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '打开 Markdown 文件',
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdx', 'txt'] },
      { name: '所有文件', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (!canceled && filePaths[0]) deliverFile(filePaths[0]);
}

function showAbout() {
  const detail = `版本 ${app.getVersion()}\nElectron ${process.versions.electron}\nChromium ${process.versions.chrome}`;
  dialog.showMessageBox(win, {
    type: 'info',
    title: '关于',
    message: 'jinmo',
    detail,
    buttons: ['好'],
  });
}

function createWindow() {
  const state = loadWindowState();
  win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 640,
    minHeight: 480,
    title: 'jinmo',
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (state.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());

  // 记录窗口状态
  win.on('resize', saveWindowState);
  win.on('move', saveWindowState);
  win.on('maximize', saveWindowState);
  win.on('unmaximize', saveWindowState);
  win.on('close', saveWindowState);
  win.on('closed', () => {
    win = null;
  });

  if (DEV) {
    win.loadURL(DEV_URL);
  } else {
    win.loadFile(PROD_HTML);
  }

  // 自检：启动后截图存到 temp/ 再退出，用于无人值守验证
  if (SELFTEST) {
    win.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 2500));
      const image = await win.capturePage();
      const out = path.join(__dirname, '..', 'temp', 'desktop-selftest.png');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, image.toPNG());
      console.log('SELFTEST_OK ' + out);
      app.quit();
    });
  }

  buildMenu();
}

// ── 渲染进程调用 ──────────────────────────────────────────

ipcMain.handle('file:open', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '打开 Markdown 文件',
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdx', 'txt'] },
      { name: '所有文件', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (canceled || !filePaths[0]) return null;
  const content = readFileSafe(filePaths[0]);
  if (content === null) return null;
  pushRecent(filePaths[0]);
  buildMenu();
  return { path: filePaths[0], content };
});

ipcMain.handle('file:save', async (_e, { content, filePath }) => {
  let target = filePath;
  if (!target) {
    const { canceled, filePath: chosen } = await dialog.showSaveDialog(win, {
      title: '保存 Markdown 文件',
      defaultPath: 'untitled.md',
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (canceled || !chosen) return null;
    target = chosen;
  }
  try {
    fs.writeFileSync(target, content, 'utf8');
  } catch (err) {
    dialog.showErrorBox('保存失败', `${target}\n\n${err.message}`);
    return null;
  }
  pushRecent(target);
  buildMenu();
  win?.setTitle(`${path.basename(target)} — jinmo`);
  return { path: target };
});

ipcMain.handle('file:recent', () => loadRecent());
ipcMain.handle('file:clear-recent', () => {
  writeJson(recentFile(), []);
  buildMenu();
  return [];
});
ipcMain.handle('title:set', (_e, title) => win?.setTitle(title));

// ── 生命周期 ──────────────────────────────────────────────

app.whenReady().then(createWindow);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
