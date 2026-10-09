/**
 * 平台适配层：抹平桌面版与网页版在「取文件 / 取剪贴板」上的差异。
 *
 * 上层（菜单、命令、编辑逻辑）只调这里的统一函数，不关心自己跑在哪。
 * 桌面版走 preload 暴露的 `window.desktop`；网页版走浏览器 API。
 */

/** 是否运行在桌面壳里 */
export const isDesktop = (): boolean =>
  typeof window !== 'undefined' && Boolean(window.desktop);

/** 图片文件扩展名（网页版 file input 的 accept 用） */
const IMAGE_ACCEPT = '.png,.jpg,.jpeg,.bmp,.svg,.tiff,.tif,.webp,.gif';

/**
 * 把本地图片路径转成编辑器里可插入的地址。
 *
 * 桌面版走 `jinmo-file://` 自定义协议 —— 直接写绝对路径浏览器不认；
 * 网页版拿到的是 File 对象，没有落盘路径，只能返回文件名（占位）。
 *
 * @param absPath 桌面版的绝对路径
 * @returns 可写进 `![]()` 的地址
 */
export const toImageSrc = (absPath: string): string =>
  isDesktop() ? `jinmo-file://local/?p=${encodeURIComponent(absPath)}` : absPath;

/**
 * 让用户选图片。
 *
 * 桌面版弹原生对话框；网页版临时创建一个 `<input type=file>` 并等它返回。
 * 两条路都返回地址数组，取消时为空数组。
 *
 * @returns 可直接写进 `![]()` 的地址列表
 */
export async function pickImages(): Promise<string[]> {
  if (isDesktop()) {
    const paths = await window.desktop!.pickImages();
    return paths.map(toImageSrc);
  }
  return new Promise<string[]>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = IMAGE_ACCEPT;
    input.multiple = true;
    input.style.display = 'none';
    // 用户直接关掉选择框时 change 不触发 —— 靠取消标记兜底，否则 Promise 永远悬着
    let settled = false;
    const done = (v: string[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(v);
    };
    input.addEventListener('cancel', () => done([]));
    input.addEventListener('change', () => {
      const urls = [...(input.files ?? [])].map((f) => f.name);
      done(urls);
    });
    document.body.appendChild(input);
    input.click();
  });
}

/**
 * 读系统剪贴板文本。
 *
 * 桌面版由主进程读（渲染进程的 `navigator.clipboard` 在 Electron 里默认被拒）；
 * 网页版走 `navigator.clipboard.readText()`，失败时返回空串由上层提示。
 *
 * @returns 剪贴板文本；读不到时为空串
 */
export async function readClipboard(): Promise<string> {
  if (isDesktop()) return window.desktop!.readClipboard();
  try {
    return await navigator.clipboard.readText();
  } catch {
    return '';
  }
}

/**
 * 写系统剪贴板文本。
 *
 * `navigator.clipboard.writeText` 在 Electron 里同样受限，走主进程更稳。
 *
 * @param text 要写入的文本
 * @returns 是否写入成功
 */
export async function writeClipboard(text: string): Promise<boolean> {
  if (isDesktop()) return window.desktop!.writeClipboard(text);
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
