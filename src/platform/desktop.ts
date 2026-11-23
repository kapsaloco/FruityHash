import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import { currentMonitor, getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import type { AppError, DesktopPlatform, HashEvent, SelectedFile } from './contract';
import { version } from '../../package.json';

export async function showAppWindow(): Promise<void> {
  if (!isTauri()) return;
  const window = getCurrentWindow();
  try {
    const [monitor, inner, outer, scale] = await Promise.all([
      currentMonitor(), window.innerSize(), window.outerSize(), window.scaleFactor(),
    ]);
    const content = document.querySelector<HTMLElement>('#app')!;
    const titlebar = document.querySelector<HTMLElement>('#window-titlebar')!;
    const contentHeight = Math.ceil(content.getBoundingClientRect().height + titlebar.getBoundingClientRect().height) + 8;
    // Monitor and native frame measurements are physical pixels; HTML is logical.
    // Leave a little room around the window and preserve scrolling on small screens.
    const frameHeight = outer.height - inner.height;
    const availableHeight = monitor
      ? Math.max(1, Math.floor((monitor.workArea.size.height - frameHeight) / scale) - 24)
      : inner.height / scale;
    await window.setSize(new LogicalSize(inner.width / scale, Math.min(contentHeight, availableHeight)));
    await window.center();
  } catch (error) {
    // A sizing failure must not prevent the already initialized app from opening.
    console.warn('Could not fit the startup window to its content.', error);
  }
  await window.show();
}

export const desktop: DesktopPlatform = {
  available: isTauri(),
  async init(callbacks) {
    if (!isTauri()) return { platform: 'other', version, dispose() {} };
    const window = getCurrentWindow();
    const dispose: (() => void)[] = [];
    try {
      dispose.push(await window.listen<SelectedFile>('selection-changed', e => callbacks.selection(e.payload)));
      dispose.push(await window.listen<AppError>('selection-error', e => callbacks.selectionError(e.payload)));
      dispose.push(await window.listen('close-requested', () => callbacks.closeRequested()));
      dispose.push(await window.onDragDropEvent(e => callbacks.dragging(e.payload.type === 'enter' || e.payload.type === 'over')));
      dispose.push(await window.onFocusChanged(e => { if (!e.payload) callbacks.dragging(false); }));
      const info = await invoke<{ platform: 'macos' | 'windows' | 'other'; version: string }>('platform_info');
      return { ...info, dispose: () => dispose.forEach(fn => fn()) };
    } catch (error) { dispose.forEach(fn => fn()); throw error; }
  },
  chooseFile: () => invoke('choose_file'),
  clearSelection: selectionId => invoke('clear_selection', { selectionId }),
  details: selectionId => invoke('get_selection_details', { selectionId }),
  startHash(selectionId, algorithms, onEvent) {
    const channel = new Channel<HashEvent>();
    channel.onmessage = onEvent; // ready before invoke: tiny files can finish before its reply
    return invoke<string>('start_hash', { selectionId, algorithms, onEvent: channel });
  },
  cancelHash: jobId => invoke('cancel_hash', { jobId }),
  compare: (jobId, expected) => invoke('compare_checksum', { jobId, expected }),
  copyResults: (jobId, algorithm) => invoke('copy_results', { jobId, algorithm: algorithm ?? null }),
  close: () => getCurrentWindow().close(),
  exit: force => invoke('exit_app', { force }),
  minimize: () => getCurrentWindow().minimize(),
  startDragging: () => getCurrentWindow().startDragging(),
};
