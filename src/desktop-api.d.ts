/**
 * 桌面壳（Electron preload）暴露给渲染进程的接口。
 *
 * 网页版没有这个对象，所有调用都要先判空。
 */

export interface DesktopApi {
  isDesktop: true;
  /** 弹打开对话框 */
  openFile(): Promise<{ path: string; content: string } | null>;
  /** 保存；filePath 为空时弹另存为 */
  saveFile(content: string, filePath: string | null): Promise<{ path: string } | null>;
  recentFiles(): Promise<string[]>;
  clearRecent(): Promise<string[]>;
  /** 弹选图对话框（可多选）；取消时返回空数组 */
  pickImages(): Promise<string[]>;
  /** 读系统剪贴板文本；读不到时返回空串 */
  readClipboard(): Promise<string>;
  /** 写系统剪贴板文本 */
  writeClipboard(text: string): Promise<boolean>;
  setTitle(title: string): Promise<void>;
  /** 上报「有未保存改动」，桌面壳关窗前据此提示保存 */
  setDirty(v: boolean): void;
  /**
   * 通知桌面壳「本次保存流程已结束」。
   *
   * @param saved 是否真的写盘成功（取消另存为、写盘失败都传 false）
   *
   * 关窗时主进程发 `save` 命令后会等这个信号，而不是靠轮询或超时猜。
   */
  notifySaveSettled(saved: boolean): void;
  /** 菜单或最近文件打开了某个文件；返回取消订阅函数 */
  onOpenFile(cb: (payload: { path: string; content: string }) => void): () => void;
  /** 菜单命令；返回取消订阅函数 */
  onMenuCommand(cb: (id: string) => void): () => void;
}

declare global {
  interface Window {
    desktop?: DesktopApi;
  }
}
