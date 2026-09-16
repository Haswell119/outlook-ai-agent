import { embeddingCacheKey } from "../../domain/cacheKey.js";
import type { EmbeddingProvider } from "../../ports/llm.js";
import type { EmbeddingCacheRepository } from "../../ports/repositories.js";

/**
 * Embedding cache — re-indexing never re-embeds unchanged text.
 *
 * Keyed by (model, SHA-256 of the normalised chunk). A mailbox re-index, a
 * duplicated distribution email or a restarted worker therefore costs zero GPU
 * time for text already seen. What is missing is embedded in batches of
 * `batchSize` (default 64) instead of one HTTP call per chunk, which is where
 * most of the wall-clock time of an initial index goes.
 *
 * Wraps any `EmbeddingProvider`; the cache is best-effort — a cache failure
 * degrades to a direct call, it never fails the index.
 */
export class CachedEmbeddingProvider implements EmbeddingProvider {
  hits = 0;
  misses = 0;

  constructor(
    private readonly inner: EmbeddingProvider,
    private readonly repo: EmbeddingCacheRepository,
    private readonly opts: {
      batchSize: number;
      ttlDays: number;
      logger?: { warn: (obj: unknown, msg?: string) => void };
      onHit?: (n: number) => void;
      onMiss?: (n: number) => void;
    },
  ) {}

  get model(): string {
    return this.inner.model;
  }
  get dimensions(): number {
    return this.inner.dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const keys = texts.map((t) => embeddingCacheKey(this.inner.model, t));

    let cached = new Map<string, number[]>();
    try {
      cached = await this.repo.getMany(this.inner.model, Array.from(new Set(keys)));
    } catch (e) {
      this.opts.logger?.warn({ err: (e as Error).message }, "embedding cache read failed, embedding everything");
    }

    // Distinct missing texts only: the same chunk repeated in one call is embedded once.
    const missingIndexByKey = new Map<string, number>();
    const toEmbed: string[] = [];
    texts.forEach((text, i) => {
      const key = keys[i]!;
      if (cached.has(key) || missingIndexByKey.has(key)) return;
      missingIndexByKey.set(key, toEmbed.length);
      toEmbed.push(text);
    });

    const hits = texts.length - texts.filter((_, i) => !cached.has(keys[i]!)).length;
    this.hits += hits;
    this.misses += texts.length - hits;
    if (hits) this.opts.onHit?.(hits);
    if (texts.length - hits) this.opts.onMiss?.(texts.length - hits);

    let fresh: number[][] = [];
    if (toEmbed.length) {
      const size = Math.max(1, this.opts.batchSize);
      for (let i = 0; i < toEmbed.length; i += size) {
        const vectors = await this.inner.embed(toEmbed.slice(i, i + size));
        fresh = fresh.concat(vectors);
      }
      const expiresAt = new Date(Date.now() + this.opts.ttlDays * 86_400_000).toISOString();
      const entries = Array.from(missingIndexByKey.entries())
        .map(([key, idx]) => ({ key, embedding: fresh[idx] }))
        .filter((e): e is { key: string; embedding: number[] } => Array.isArray(e.embedding));
      try {
        await this.repo.putMany(this.inner.model, entries, expiresAt);
      } catch (e) {
        this.opts.logger?.warn({ err: (e as Error).message }, "embedding cache write failed (vectors still returned)");
      }
    }

    return keys.map((key, i) => {
      const hit = cached.get(key);
      if (hit) return hit;
      const idx = missingIndexByKey.get(key);
      const vector = idx === undefined ? undefined : fresh[idx];
      if (!vector) throw new Error(`embedding missing for input ${i}`);
      return vector;
    });
  }

  get stats(): { hits: number; misses: number } {
    return { hits: this.hits, misses: this.misses };
  }
}
