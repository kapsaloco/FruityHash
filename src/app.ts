import { algorithms, algorithmLabels, userMessage, type Algorithm, type Comparison, type DesktopPlatform, type DigestResult, type HashEvent, type SelectedFile } from './platform/contract';
import { displayPath, formatBytes, progressPercent, seconds } from './format';
import { FRUITY_UI_LABEL } from './styles/fruity/version';
import projectLicense from '../LICENSE?raw';

type Phase = 'idle' | 'ready' | 'starting' | 'hashing' | 'canceling' | 'canceled' | 'failed' | 'succeeded';
interface Operation { id?: string; sequence: number; cancelRequested: boolean; cancelSent: boolean; settled: boolean; terminal: boolean }
function element<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }

export async function mountApp(platform: DesktopPlatform): Promise<() => void> {
  element('ui-version').textContent = FRUITY_UI_LABEL;
  element('status-text').textContent = `FruityUI ${FRUITY_UI_LABEL}`;
  const abort = new AbortController();
  const { signal } = abort;
  const on = <K extends keyof HTMLElementEventMap>(node: HTMLElement, name: K, fn: (event: HTMLElementEventMap[K]) => void) => node.addEventListener(name, fn, { signal });
  let initialized = false, disposed = false, mutation = false, dragging = false;
  let phase: Phase = 'idle';
  let selected: SelectedFile | null = null, queuedSelection: SelectedFile | null = null;
  let operation: Operation | null = null;
  let results: DigestResult[] = [], completedJob: string | null = null;
  let processed = '0', total = '0', elapsed = 0;
  let comparisonRevision = 0;
  let comparisonTimer: ReturnType<typeof setTimeout> | undefined;
  let lastAnnouncement = 0, lastAnnouncedPercent = 0;
  let closeAfterJob = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const copyTimers = new Map<HTMLButtonElement, ReturnType<typeof setTimeout>>();
  const closeDialog = element<HTMLDialogElement>('close-dialog');
  const helpDialog = element<HTMLDialogElement>('help-dialog');
  const expected = element<HTMLTextAreaElement>('expected-checksum');
  const allAlgorithms = element<HTMLInputElement>('all-algorithms');
  const inputs = Array.from(element('algorithms').querySelectorAll<HTMLInputElement>('input[value]'));
  const resultRows = new Map<Algorithm, { row: HTMLElement; text: HTMLElement; button: HTMLButtonElement }>();
  const running = () => Boolean(operation && (!operation.terminal || !operation.settled));
  const selectedAlgorithms = () => inputs.filter(input => input.checked).map(input => input.value as Algorithm);
  const announce = (message: string) => { if (!disposed) element('announcements').textContent = message; };
  const error = (value: unknown) => { element('app-error').textContent = userMessage(value); element('app-error').hidden = false; };
  const clearError = () => { element('app-error').hidden = true; element('app-error').textContent = ''; };
  const neutralComparison = (message = '') => {
    comparisonRevision++;
    clearTimeout(comparisonTimer);
    element('comparison').dataset.state = 'waiting';
    element('comparison-message').textContent = message;
    element('comparison-detail').textContent = '';
    element('detected-algorithm').textContent = '';
    expected.removeAttribute('aria-invalid');
  };
  const clearResults = () => {
    copyTimers.forEach(clearTimeout); copyTimers.clear();
    resultRows.forEach(item => { item.button.textContent = 'Copy'; });
    element('copy-all').textContent = 'Copy all';
    results = []; completedJob = null; neutralComparison(expected.value ? 'Waiting for calculation.' : undefined); };
  const flushSelection = () => { if (queuedSelection && !running() && !mutation) { const file = queuedSelection; queuedSelection = null; acceptSelection(file); } };

  function render() {
    const busy = running();
    const unavailable = !initialized || !platform.available || mutation || busy;
    element('app').dataset.state = phase;
    element('selected-file').hidden = !selected;
    element('dropzone').hidden = Boolean(selected);
    element('dropzone').dataset.state = dragging && !busy ? 'dragging' : 'empty';
    element('drop-title').textContent = dragging ? busy ? 'A calculation is already running.' : 'Drop to choose a file' : 'Drop a file here';
    element('drop-help').textContent = dragging && busy ? 'Cancel before choosing another file.' : '';
    element('drop-help').hidden = !(dragging && busy);
    element<HTMLButtonElement>('choose-file').disabled = unavailable;
    element<HTMLButtonElement>('change-file').disabled = unavailable;
    element<HTMLButtonElement>('clear-file').disabled = unavailable;
    element<HTMLFieldSetElement>('algorithms').disabled = mutation || busy;
    allAlgorithms.checked = inputs.every(input => input.checked);
    allAlgorithms.indeterminate = !allAlgorithms.checked && inputs.some(input => input.checked);
    const calculate = element<HTMLButtonElement>('calculate');
    calculate.disabled = !initialized || !platform.available || mutation || (operation?.terminal === true && !operation.settled) || phase === 'canceling' || (!busy && (!selected || selectedAlgorithms().length === 0));
    calculate.textContent = phase === 'canceling' ? 'Canceling…' : busy ? 'Cancel' : inputValue() ? 'Calculate and compare' : 'Calculate hashes';
    calculate.classList.toggle('fr-button--primary', !busy);
    const descriptions: Record<Phase, [string, string]> = {
      idle: ['Ready', ''],
      ready: ['Ready', ''],
      starting: ['Opening file…', ''],
      hashing: [processed === total ? 'Finalizing…' : 'Calculating…', ''],
      canceling: ['Canceling…', ''],
      canceled: ['Calculation canceled.', 'No results were kept.'],
      failed: ['Calculation failed.', 'No results were kept.'],
      succeeded: ['', ''],
    };
    element('operation-title').textContent = descriptions[phase][0];
    element('operation-title').hidden = !descriptions[phase][0] || phase === 'idle' || phase === 'ready';
    element('operation-help').textContent = descriptions[phase][1];
    element('operation-help').hidden = !element('operation-help').textContent;
    element('operation').setAttribute('aria-busy', String(busy));
    const showProgress = ['starting', 'hashing', 'canceling', 'succeeded'].includes(phase);
    element('progress-area').hidden = !showProgress;
    const meter = element('hash-progress');
    meter.dataset.state = phase === 'starting' ? 'indeterminate' : phase === 'hashing' ? 'active' : phase === 'succeeded' ? 'complete' : 'paused';
    const percent = progressPercent(processed, total, phase === 'succeeded');
    meter.style.setProperty('--fr-progress-value', `${percent}%`);
    if (phase === 'starting') meter.removeAttribute('aria-valuenow');
    else meter.setAttribute('aria-valuenow', String(percent));
    element('progress-detail').textContent = phase === 'starting' ? 'Opening file…' : `${formatBytes(processed)} of ${formatBytes(total)} · ${seconds(elapsed)}`;
    element('progress-percent').textContent = phase === 'starting' ? '' : `${percent}%`;
    const pending = busy && !operation?.terminal;
    const hasResults = results.length > 0;
    element('results-empty').hidden = hasResults || pending;
    element('results-list').hidden = !hasResults && !pending;
    element('results-empty-title').textContent = ['canceled', 'failed'].includes(phase) ? 'No results were kept.' : 'No checksums yet';
    element('results-empty-help').textContent = '';
    for (const algorithm of algorithms) {
      const item = resultRows.get(algorithm)!;
      const result = results.find(digest => digest.algorithm === algorithm);
      item.row.hidden = !result && !(pending && selectedAlgorithms().includes(algorithm));
      item.row.dataset.pending = String(!result);
      const value = result?.hex ?? (phase === 'starting' ? 'Waiting to calculate…' : phase === 'canceling' ? 'Canceling…' : 'Calculating…');
      if (item.text.textContent !== value) item.text.textContent = value;
      item.button.disabled = !result || !completedJob || mutation;
    }
    element<HTMLButtonElement>('copy-all').disabled = !hasResults || !completedJob || mutation;
  }

  function acceptSelection(file: SelectedFile) {
    dragging = false;
    if (running() || mutation) { queuedSelection = file; return; }
    selected = file;
    phase = 'ready';
    clearError(); clearResults();
    element('filename').textContent = file.displayName;
    element('filesize').textContent = formatBytes(file.sizeBytes);
    element('exact-size').textContent = `${BigInt(file.sizeBytes).toLocaleString()} bytes`;
    element<HTMLDetailsElement>('file-details').open = false;
    element('filepath').textContent = '';
    render(); announce(`Selected ${file.displayName}. Ready to calculate.`);
  }
  async function chooseFile() {
    if (!platform.available || !initialized || running() || mutation) return;
    mutation = true; dragging = false; clearError(); render();
    try {
      const file = await platform.chooseFile();
      mutation = false;
      if (file) { acceptSelection(file); expected.focus(); }
    } catch (value) { error(value); }
    finally { mutation = false; render(); flushSelection(); }
  }
  async function clearFile() {
    if (!selected || running() || mutation) return;
    mutation = true; render();
    try {
      await platform.clearSelection(selected.selectionId);
      selected = null; operation = null; phase = 'idle'; clearResults(); expected.value = ''; neutralComparison(); clearError();
      element<HTMLDetailsElement>('file-details').open = false;
      announce('File cleared.');
    } catch (value) { error(value); }
    finally { mutation = false; render(); flushSelection(); if (!selected) element('choose-file').focus(); }
  }
  async function sendCancel(op: Operation) {
    if (!op.id || op.cancelSent || op.terminal) return;
    op.cancelSent = true;
    try { await platform.cancelHash(op.id); }
    catch (value) {
      if (operation !== op || op.terminal) return;
      op.cancelSent = false; op.cancelRequested = false; phase = 'hashing'; error(value); render();
    }
  }
  function cancel() {
    if (!operation || operation.terminal || operation.cancelRequested) return;
    operation.cancelRequested = true; phase = 'canceling'; render(); announce('Canceling calculation.');
    void sendCancel(operation);
  }
  async function exit(force = false) {
    try { await platform.exit(force); }
    catch (value) { error(value); closeAfterJob = false; element<HTMLButtonElement>('stop-close').disabled = false; }
  }
  function onHashEvent(op: Operation, event: HashEvent) {
    if (disposed || operation !== op || op.terminal || (op.id && op.id !== event.jobId) || event.sequence <= op.sequence) return;
    op.id = event.jobId; op.sequence = event.sequence;
    if (event.type === 'started') {
      total = event.totalBytes;
      if (!op.cancelRequested) phase = 'hashing';
      else void sendCancel(op);
    } else if (event.type === 'progress') {
      processed = event.processedBytes; total = event.totalBytes; elapsed = event.elapsedMs;
      const percent = progressPercent(processed, total);
      if (percent >= lastAnnouncedPercent + 10 && performance.now() - lastAnnouncement >= 2000) {
        announce(`Calculating, ${percent} percent.`); lastAnnouncement = performance.now(); lastAnnouncedPercent = percent;
      }
    } else {
      op.terminal = true;
      if (event.type === 'completed') {
        phase = 'succeeded'; processed = event.processedBytes; total = event.processedBytes; elapsed = event.elapsedMs;
        results = event.results; completedJob = event.jobId;
        announce('Calculation complete. Your checksums are ready.');
        void compare(true);
      } else {
        clearResults(); phase = event.type === 'canceled' ? 'canceled' : 'failed';
        if (event.type === 'failed') error(event.error);
        announce(event.type === 'canceled' ? 'Calculation canceled. No results were kept.' : 'Calculation failed. No results were kept.');
      }
      if (closeAfterJob) void exit();
    }
    if (op.terminal) selectExpectedAlgorithm();
    render(); flushSelection();
  }
  async function start() {
    if (running()) { cancel(); return; }
    if (!selected || mutation || !platform.available || selectedAlgorithms().length === 0) return;
    clearError(); clearResults(); processed = '0'; total = selected.sizeBytes; elapsed = 0;
    phase = 'starting'; dragging = false;
    lastAnnouncement = performance.now(); lastAnnouncedPercent = 0;
    const op: Operation = { sequence: 0, cancelRequested: false, cancelSent: false, terminal: false, settled: false };
    operation = op; render(); announce('Calculation started.');
    try {
      const id = await platform.startHash(selected.selectionId, selectedAlgorithms(), event => onHashEvent(op, event));
      if (op.id && op.id !== id) throw new Error('The calculation response could not be reconciled. Please restart the app.');
      op.id = id;
      if (op.cancelRequested) await sendCancel(op);
    } catch (value) {
      if (!op.terminal) { op.terminal = true; phase = 'failed'; clearResults(); error(value); announce('Could not start the calculation.'); }
      if (closeAfterJob) void exit();
    } finally {
      op.settled = true; selectExpectedAlgorithm(); render(); flushSelection();
      if (closeAfterJob && op.terminal) void exit();
    }
  }

  function inputValue() { return expected.value.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, ''); }
  function detectedAlgorithm(): Algorithm | undefined {
    const value = inputValue();
    if (!/^[0-9a-f]+$/i.test(value)) return undefined;
    return ({ 32: 'md5', 40: 'sha1', 64: 'sha256', 128: 'sha512' } as Record<number, Algorithm>)[value.length];
  }
  function selectExpectedAlgorithm() {
    // Preserve other choices, including All, and never change an active job.
    const algorithm = detectedAlgorithm();
    if (algorithm && !running() && !mutation) {
      inputs.find(input => input.value === algorithm)!.checked = true;
    }
  }
  async function compare(validate: boolean) {
    const revision = ++comparisonRevision;
    const value = inputValue();
    const algorithm = detectedAlgorithm();
    element('comparison').dataset.state = 'waiting'; expected.removeAttribute('aria-invalid');
    element('comparison-detail').textContent = '';
    element('detected-algorithm').textContent = algorithm ? algorithmLabels[algorithm] : '';
    if (!value) { element('comparison-message').textContent = ''; return; }
    if (!algorithm) {
      element('comparison-message').textContent = validate ? 'Enter a hexadecimal MD5, SHA-1, SHA-256 or SHA-512 checksum.' : 'Finish entering your expected checksum.';
      if (validate) { element('comparison').dataset.state = 'invalid'; expected.setAttribute('aria-invalid', 'true'); }
      return;
    }
    if (!completedJob) { element('comparison-message').textContent = 'Waiting for calculation.'; return; }
    const job = completedJob;
    element('comparison-message').textContent = 'Comparing…';
    try {
      const verdict: Comparison = await platform.compare(job, expected.value);
      if (disposed || revision !== comparisonRevision || completedJob !== job) return;
      const messages = {
        match: 'A perfect match!', mismatch: 'These checksums don’t match',
        invalid: 'Enter a hexadecimal MD5, SHA-1, SHA-256 or SHA-512 checksum.',
        not_calculated: `${algorithmLabels[algorithm]} was not calculated. Select it and calculate again.`,
      };
      element('comparison').dataset.state = verdict.verdict;
      element('comparison-message').textContent = messages[verdict.verdict];
      element('comparison-detail').textContent = verdict.verdict === 'match'
        ? 'Every character matches the checksum you supplied.'
        : verdict.verdict === 'mismatch' ? 'Double-check the expected checksum and try again with the correct file.' : '';
      if (verdict.verdict === 'invalid') expected.setAttribute('aria-invalid', 'true');
      announce(messages[verdict.verdict]);
    } catch (value) {
      if (revision !== comparisonRevision || completedJob !== job) return;
      element('comparison-message').textContent = userMessage(value);
    }
  }
  async function copy(button: HTMLButtonElement, algorithm?: Algorithm) {
    if (!completedJob || button.getAttribute('aria-busy') === 'true') return;
    const original = algorithm ? 'Copy' : 'Copy all';
    const job = completedJob;
    clearTimeout(copyTimers.get(button));
    button.setAttribute('aria-busy', 'true');
    try {
      await platform.copyResults(job, algorithm);
      if (disposed || job !== completedJob) return;
      button.textContent = 'Copied'; announce(algorithm ? `${algorithmLabels[algorithm]} copied.` : 'All checksums copied.');
      copyTimers.set(button, setTimeout(() => { button.textContent = original; }, 1500));
    } catch { if (disposed || job !== completedJob) return; announce('Could not copy. Select the checksum and copy it manually.'); error({message: 'Could not copy. Select the checksum and copy it manually.'}); }
    finally { button.removeAttribute('aria-busy'); }
  }

  element('results-list').replaceChildren();
  for (const algorithm of algorithms) {
    const row = (element<HTMLTemplateElement>('result-template').content.firstElementChild!.cloneNode(true)) as HTMLElement;
    row.dataset.algorithm = algorithm;
    row.querySelector('.fh-result-name')!.textContent = algorithmLabels[algorithm];
    const legacy = row.querySelector<HTMLElement>('.fr-badge--subtle')!; legacy.hidden = !['md5', 'sha1'].includes(algorithm);
    const button = row.querySelector<HTMLButtonElement>('button')!;
    button.setAttribute('aria-label', `Copy ${algorithmLabels[algorithm]}`);
    on(button, 'click', () => { void copy(button, algorithm); });
    resultRows.set(algorithm, { row, text: row.querySelector('.fh-result-digest')!, button });
    element('results-list').append(row);
  }
  on(element('choose-file'), 'click', () => { void chooseFile(); });
  on(element('change-file'), 'click', () => { void chooseFile(); });
  on(element('clear-file'), 'click', () => { void clearFile(); });
  on(element('calculate'), 'click', () => { void start(); });
  on(element('algorithms'), 'change', event => {
    if (event.target === allAlgorithms) {
      inputs.forEach(input => { input.checked = allAlgorithms.checked; });
    }
    render();
  });
  on(expected, 'input', () => {
    selectExpectedAlgorithm();
    render();
    neutralComparison(expected.value ? 'Waiting for comparison…' : undefined);
    comparisonTimer = setTimeout(() => { void compare(false); }, 150);
  });
  on(expected, 'blur', () => { clearTimeout(comparisonTimer); void compare(true); });
  on(element('copy-all'), 'click', () => { void copy(element('copy-all')); });
  on(element('file-details'), 'toggle', () => {
    if (!element<HTMLDetailsElement>('file-details').open || !selected) return;
    const id = selected.selectionId;
    element('filepath').textContent = 'Loading details…';
    void platform.details(id).then(details => { if (selected?.selectionId === id) element('filepath').textContent = displayPath(details.pathDisplay); })
      .catch(value => { if (selected?.selectionId === id) element('filepath').textContent = userMessage(value); });
  });
  on(element('help'), 'click', () => { if (!helpDialog.open) helpDialog.showModal(); });
  on(helpDialog, 'close', () => element('help').focus());
  on(element('license-disclosure'), 'toggle', async () => {
    const notices = element<HTMLTextAreaElement>('license-notices');
    if (element<HTMLDetailsElement>('license-disclosure').open && !notices.value) {
      notices.value = 'Loading licenses...';
      try {
        const { default: thirdPartyNotices } = await import('../THIRD_PARTY_NOTICES.txt?raw');
        notices.value = `${projectLicense}\n\n${thirdPartyNotices}`;
      } catch {
        notices.value = 'Licenses could not be loaded. See LICENSE and THIRD_PARTY_NOTICES.txt in the app distribution.';
      }
    }
  });
  function requestClose() {
    if (!running()) { void exit(); return; }
    if (!closeDialog.open) {
      clearTimeout(closeTimer);
      element<HTMLButtonElement>('stop-close').disabled = false;
      element('force-close').hidden = true;
      element('close-wait').hidden = true;
      element('keep-calculating').textContent = 'Keep calculating';
      closeDialog.showModal();
    }
  }
  on(element('keep-calculating'), 'click', () => { closeAfterJob = false; clearTimeout(closeTimer); closeDialog.close(); element('calculate').focus(); });
  on(closeDialog, 'cancel', () => { closeAfterJob = false; clearTimeout(closeTimer); });
  on(element('stop-close'), 'click', () => {
    closeAfterJob = true;
    element('keep-calculating').textContent = 'Keep open';
    element<HTMLButtonElement>('stop-close').disabled = true;
    cancel();
    closeTimer = setTimeout(() => { element('force-close').hidden = false; element('close-wait').hidden = false; }, 2000);
    if (!running()) void exit();
  });
  on(element('force-close'), 'click', () => { void exit(true); });
  on(element('window-close'), 'click', () => { void platform.close().catch(error); });
  on(element('minimize'), 'click', () => { void platform.minimize().catch(error); });
  // Mouse events provide the click count; pointerdown.detail can be zero.
  on(element('window-drag'), 'mousedown', event => { if (event.button === 0 && event.detail === 1) { event.preventDefault(); void platform.startDragging().catch(error); } });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o' && !helpDialog.open && !closeDialog.open) { event.preventDefault(); void chooseFile(); }
    if (event.key === 'Escape' && running() && !mutation && !helpDialog.open && !closeDialog.open) { event.preventDefault(); cancel(); }
  }, { signal });
  window.addEventListener('blur', () => { dragging = false; render(); }, { signal });
  element('browser-notice').hidden = platform.available;
  render();
  let cleanupPlatform = () => {};
  try {
    const info = await platform.init({
      selection: acceptSelection,
      selectionError(value) { dragging = false; error(value); render(); },
      dragging(value) { dragging = value; render(); },
      closeRequested: requestClose,
    });
    cleanupPlatform = info.dispose;
    document.documentElement.dataset.platform = info.platform;
    element('window-titlebar').hidden = info.platform !== 'windows';
    element('app-version').textContent = `v${info.version.replace(/\.0$/, '')}`;
    initialized = true;
  } catch (value) { error(value); }
  render();
  return () => {
    disposed = true; abort.abort(); cleanupPlatform(); clearTimeout(comparisonTimer); clearTimeout(closeTimer);
    copyTimers.forEach(clearTimeout);
  };
}
