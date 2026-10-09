/**
 * 预加载脚本：向渲染进程暴露最小的桌面能力。
 *
 * 只暴露具名方法，不把 ipcRenderer 交给页面。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,

  /** 弹打开对话框 → { path, content } | null */
  openFile: () => ipcRenderer.invoke('file:open'),

  /** 保存；filePath 为空时弹另存为 → { path } | null */
  saveFile: (content, filePath) => ipcRenderer.invoke('file:save', { content, filePath }),

  /** 最近打开的文件路径列表 */
  recentFiles: () => ipcRenderer.invoke('file:recent'),
  clearRecent: () => ipcRenderer.invoke('file:clear-recent'),

  /** 弹选图对话框（可多选）→ 绝对路径数组；取消时为空数组 */
  pickImages: () => ipcRenderer.invoke('image:pick'),

  /** 读系统剪贴板文本 → string；读不到时为空串 */
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),

  /** 写系统剪贴板文本 */
  writeClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),

  /** 设置窗口标题 */
  setTitle: (title) => ipcRenderer.invoke('title:set', title),

  /** 上报「有未保存改动」，关窗前据此决定要不要提示 */
  setDirty: (v) => ipcRenderer.send('dirty:set', Boolean(v)),

  /**
   * 订阅「菜单或最近文件打开了某个文件」。
   * @param cb 回调，参数为 { path, content }
   * @returns 取消订阅的函数
   */
  onOpenFile: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('open-file', handler);
    return () => ipcRenderer.off('open-file', handler);
  },

  /**
   * 订阅菜单命令。
   * @param cb 回调，参数为命令标识
   * @returns 取消订阅的函数
   */
  onMenuCommand: (cb) => {
    const handler = (_e, id) => cb(id);
    ipcRenderer.on('menu', handler);
    return () => ipcRenderer.off('menu', handler);
  },
});
