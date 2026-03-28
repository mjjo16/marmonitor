/**
 * Size-limited Map with LRU-like eviction.
 * When the map exceeds maxSize, the oldest (least recently set) entry is removed.
 * Re-setting an existing key refreshes its position (moves to newest).
 */
export class BoundedMap<K, V> extends Map<K, V> {
  private readonly maxSize: number;

  constructor(maxSize: number) {
    super();
    this.maxSize = maxSize;
  }

  override set(key: K, value: V): this {
    // Re-set: delete first to refresh insertion order
    if (this.has(key)) {
      this.delete(key);
    } else if (this.size >= this.maxSize) {
      // Evict oldest (first inserted) entry
      const oldest = this.keys().next().value;
      if (oldest !== undefined) this.delete(oldest);
    }
    return super.set(key, value);
  }
}
