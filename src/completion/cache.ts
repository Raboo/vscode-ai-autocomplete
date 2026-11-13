interface Entry {
  uri: string;
  prefix: string;
  suffix: string;
  text: string;
}

/** Remembers recent suggestions and reuses them as the user types or backspaces. */
export class SuggestionCache {
  private entries: Entry[] = []; // oldest first

  constructor(private readonly max = 50) {}

  add(uri: string, prefix: string, suffix: string, text: string): void {
    this.entries = this.entries.filter(
      (e) => !(e.uri === uri && e.prefix === prefix && e.suffix === suffix),
    );
    this.entries.push({ uri, prefix, suffix, text });
    while (this.entries.length > this.max) this.entries.shift();
  }

  find(uri: string, prefix: string, suffix: string): string | undefined {
    const same = this.entries
      .filter((e) => e.uri === uri && e.suffix === suffix)
      .reverse();

    for (const e of same) if (e.prefix === prefix) return e.text;

    for (const e of same) {
      if (prefix.length <= e.prefix.length || !prefix.startsWith(e.prefix))
        continue;
      const typed = prefix.slice(e.prefix.length);
      if (e.text.startsWith(typed) && e.text.length > typed.length) {
        return e.text.slice(typed.length);
      }
    }

    for (const e of same) {
      if (prefix.length >= e.prefix.length || !e.prefix.startsWith(prefix))
        continue;
      const deleted = e.prefix.slice(prefix.length);
      if (!deleted.includes("\n")) return deleted + e.text;
    }
    return undefined;
  }
}
