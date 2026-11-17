/** Spec 08 § 4.3: what a secret's value becomes in everything Fornax prints or keeps from a setup. */
export const MASK = '***';
/** A line longer than this goes out without waiting for its end (masked; its last characters wait). */
export const MAX_HELD = 64 * 1024;

/** Every occurrence of every value masked; the longest first, so a value inside another is not half-masked. */
export function maskAll(text: string, values: readonly string[]): string {
  let out = text;
  for (const v of [...values].sort((a, b) => b.length - a.length)) if (v) out = out.split(v).join(MASK);
  return out;
}

/** Holds output until its line ends, so a value split between two chunks is still masked. */
export class Redactor {
  private held = '';
  /** A value not complete yet starts within the last (longest value - 1) characters. */
  private readonly keep: number;

  constructor(
    private readonly values: readonly string[],
    private readonly emit: (text: string) => void,
  ) {
    this.keep = Math.max(0, ...values.map((v) => v.length - 1));
  }

  push(text: string): void {
    if (!this.values.length) {
      this.emit(text);
      return;
    }
    this.held += text;
    const end = this.held.lastIndexOf('\n');
    if (end >= 0) {
      this.emit(maskAll(this.held.slice(0, end + 1), this.values));
      this.held = this.held.slice(end + 1);
    }
    if (this.held.length > MAX_HELD) {
      const masked = maskAll(this.held, this.values);
      const cut = masked.length - this.keep;
      this.emit(masked.slice(0, cut));
      this.held = masked.slice(cut);
    }
  }

  flush(): void {
    if (this.held) this.emit(maskAll(this.held, this.values));
    this.held = '';
  }
}
