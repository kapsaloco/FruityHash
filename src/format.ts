export function formatBytes(decimal: string): string {
  const bytes = BigInt(decimal);
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];
  let scale = 1n, unit = 0;
  while (bytes >= scale * 1024n && unit < units.length - 1) { scale *= 1024n; unit++; }
  const tenths = (bytes * 10n + scale / 2n) / scale;
  return `${tenths / 10n}${unit > 0 && tenths % 10n ? `.${tenths % 10n}` : ''} ${units[unit]}`;
}
export function progressPercent(processed: string, total: string, complete = false): number {
  if (complete) return 100;
  const size = BigInt(total);
  return size === 0n ? 0 : Number((BigInt(processed) * 100n / size) > 99n ? 99n : BigInt(processed) * 100n / size);
}
export function seconds(milliseconds: number): string { return `${(milliseconds / 1000).toFixed(1)} s`; }

/** Remove Windows canonical-path notation only for human-readable display. */
export function displayPath(path: string): string {
  if (path.startsWith('\\\\?\\UNC\\')) return '\\\\' + path.slice(8);
  if (/^\\\\\?\\[a-z]:\\/i.test(path)) return path.slice(4);
  return path;
}
