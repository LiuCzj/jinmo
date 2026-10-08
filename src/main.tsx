import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

/**
 * 应用入口。
 *
 * 刻意不套 React.StrictMode：StrictMode 会在开发模式下双调用 effect，
 * 而编辑器大量依赖 useLayoutEffect 量光标位置，双调用会让测量结果抖动。
 */
const el = document.getElementById('root');
if (!el) throw new Error('找不到挂载点 #root');

createRoot(el).render(<App />);
