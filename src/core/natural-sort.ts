const collator = new Intl.Collator("en", { numeric: true });

/** Orders `frame_9999` before `frame_10000`, unlike a plain string sort. */
export function compareNatural(a: string, b: string): number {
  return collator.compare(a, b);
}
