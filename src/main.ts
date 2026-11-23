import { mountApp } from './app';
import { desktop, showAppWindow } from './platform/desktop';
import { prepareFirstFrame } from './startup';

void mountApp(desktop).then(async dispose => {
  if (import.meta.hot) import.meta.hot.dispose(dispose);
  await prepareFirstFrame();
  await showAppWindow();
});
