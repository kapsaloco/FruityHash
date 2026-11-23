import { describe, expect, it } from 'vitest';
import { displayPath, formatBytes, progressPercent } from './format';
describe('exact large-file display', () => {
  it('displays Windows canonical paths without changing normal or device paths', () => {
    expect(displayPath(String.raw`\\?\C:\Users\example\Downloads\sample.zip`)).toBe(String.raw`C:\Users\example\Downloads\sample.zip`);
    expect(displayPath(String.raw`\\?\UNC\server\share\file.zip`)).toBe(String.raw`\\server\share\file.zip`);
    for (const path of [String.raw`C:\file.zip`, '/Users/example/file.zip', String.raw`\\?\Volume{example}\file`]) {
      expect(displayPath(path)).toBe(path);
    }
  });
  it('formats empty, IEC and u64 sizes without unsafe integer conversion', () => {
    expect(formatBytes('0')).toBe('0 B');
    expect(formatBytes('1536')).toBe('1.5 KiB');
    expect(formatBytes('536870912')).toBe('512 MiB');
    expect(formatBytes('9007199254740993')).toBe('8 PiB');
    expect(formatBytes('18446744073709551615')).toBe('16 EiB');
  });
  it('reserves 100 percent for confirmed completion, including empty files', () => {
    expect(progressPercent('9007199254740993','18014398509481986')).toBe(50);
    expect(progressPercent('18446744073709551615','18446744073709551615')).toBe(99);
    expect(progressPercent('0','0')).toBe(0);
    expect(progressPercent('0','0',true)).toBe(100);
  });
});
