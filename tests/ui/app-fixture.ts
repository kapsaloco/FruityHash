import { mountApp } from '../../src/app';
import type { Algorithm, DesktopPlatform, HashEvent, PlatformCallbacks, SelectedFile } from '../../src/platform/contract';
const hex: Record<Algorithm, string> = {
  md5: '900150983cd24fb0d6963f7d28e17f72', sha1: 'a9993e364706816aba3e25717850c26c9cd0d89d',
  sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  sha512: 'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
};
let callbacks: PlatformCallbacks;
let onEvent: (event: HashEvent) => void;
let resolveStart: (id: string) => void;
let sequence = 0, job = 0;
let selectedAlgorithms: Algorithm[] = [];
let finishedResults: Algorithm[] = [];
let fileNumber = 0;
const controls = {
  name: 'Summer archive — photographs.zip', size: '536870912', cancelPicker: false, fast: false,
  canceled: [] as string[], copied: [] as (Algorithm | 'all')[], exits: [] as boolean[],
  startPending: false, failCopy: false, compareDelay: 0,
  drags: 0,
  send(type: string, extra: Record<string, unknown> = {}) {
    onEvent({ type, jobId: `job-${job}`, sequence: ++sequence, ...extra } as HashEvent);
  },
  progress(processed = '268435456') { controls.send('progress', {processedBytes: processed, totalBytes: controls.size, elapsedMs: 2100}); },
  complete() {
    finishedResults = [...selectedAlgorithms];
    controls.send('completed', {processedBytes: controls.size, elapsedMs: 4500, results: selectedAlgorithms.map(algorithm => ({algorithm, hex:hex[algorithm]}))});
  },
  resolve() { controls.startPending = false; resolveStart(`job-${job}`); },
  cancelComplete() { controls.send('canceled'); },
  fail() { controls.send('failed', {error:{code:'FILE_CHANGED',message:'The file changed during calculation. Try again with a stable copy.',retryable:true}}); },
  drop() { callbacks.selection(makeFile()); },
  drag(value: boolean) { callbacks.dragging(value); },
  close() { callbacks.closeRequested(); },
};
function makeFile(): SelectedFile { return { selectionId: `selection-${++fileNumber}`, displayName: controls.name, sizeBytes: controls.size }; }
const platform: DesktopPlatform = {
  available: true,
  async init(value) { callbacks = value; return {platform: 'windows', version:'1.0.0', dispose(){}}; },
  async chooseFile() { return controls.cancelPicker ? null : makeFile(); },
  async clearSelection() {},
  async details() { return { pathDisplay: '/Example files/' + controls.name }; },
  async startHash(_selection, algorithms, callback) {
    selectedAlgorithms = algorithms; finishedResults = []; onEvent = callback; sequence = 0; job++;
    const pending = new Promise<string>(resolve => { resolveStart = resolve; });
    controls.startPending = true;
    if (controls.fast) { controls.send('started',{totalBytes:controls.size}); controls.complete(); controls.resolve(); }
    return pending;
  },
  async cancelHash(id) { controls.canceled.push(id); return 'requested'; },
  async compare(_id, expected) {
    const value = expected.trim().toLowerCase();
    const algorithm = ({32:'md5',40:'sha1',64:'sha256',128:'sha512'} as Record<number,Algorithm>)[value.length];
    const result = {algorithm, verdict: !finishedResults.includes(algorithm) ? 'not_calculated' : value===hex[algorithm] ? 'match' : 'mismatch'} as const;
    if (controls.compareDelay) await new Promise(resolve=>setTimeout(resolve,controls.compareDelay));
    return result;
  },
  async copyResults(_id, algorithm) { if(controls.failCopy) throw new Error('clipboard failed'); controls.copied.push(algorithm ?? 'all'); },
  async close() { callbacks.closeRequested(); },
  async exit(force) { controls.exits.push(force); },
  async minimize() {}, async startDragging() { controls.drags++; },
};
Object.assign(window, { fixture: controls });
void mountApp(platform);
