export const algorithms = ['md5', 'sha1', 'sha256', 'sha512'] as const;
export type Algorithm = typeof algorithms[number];
export const algorithmLabels: Record<Algorithm, string> = { md5: 'MD5', sha1: 'SHA-1', sha256: 'SHA-256', sha512: 'SHA-512' };
export interface SelectedFile { selectionId: string; displayName: string; sizeBytes: string }
export interface DigestResult { algorithm: Algorithm; hex: string }
export interface AppError { code: string; message: string; retryable: boolean }
export interface Comparison { algorithm: Algorithm | null; verdict: 'match' | 'mismatch' | 'invalid' | 'not_calculated' }
interface JobEvent { jobId: string; sequence: number }
export type HashEvent = JobEvent & (
  | { type: 'started'; totalBytes: string }
  | { type: 'progress'; processedBytes: string; totalBytes: string; elapsedMs: number }
  | { type: 'completed'; processedBytes: string; elapsedMs: number; results: DigestResult[] }
  | { type: 'canceled' }
  | { type: 'failed'; error: AppError }
);
export interface PlatformCallbacks {
  selection(file: SelectedFile): void;
  selectionError(error: AppError): void;
  dragging(active: boolean): void;
  closeRequested(): void;
}
export interface DesktopPlatform {
  readonly available: boolean;
  init(callbacks: PlatformCallbacks): Promise<{ platform: 'macos' | 'windows' | 'other'; version: string; dispose(): void }>;
  chooseFile(): Promise<SelectedFile | null>;
  clearSelection(id: string): Promise<void>;
  details(id: string): Promise<{ pathDisplay: string }>;
  startHash(id: string, selected: Algorithm[], onEvent: (event: HashEvent) => void): Promise<string>;
  cancelHash(id: string): Promise<'requested' | 'already_finished'>;
  compare(id: string, expected: string): Promise<Comparison>;
  copyResults(id: string, algorithm?: Algorithm): Promise<void>;
  close(): Promise<void>;
  exit(force: boolean): Promise<void>;
  minimize(): Promise<void>;
  startDragging(): Promise<void>;
}
export function userMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') return error.message;
  return 'Something went wrong. Please try again.';
}
