import { flushSync } from 'svelte';
import { describe, expect, it } from 'vitest';
import { createCounter } from '$lib/test-support/counter.svelte';

describe('rune module support', () => {
  it('updates $derived state after $state changes', () => {
    const counter = createCounter();
    counter.increment();
    expect(counter.count).toBe(1);
    expect(counter.doubled).toBe(2);
  });

  it('runs $effect on the client after flushSync', () => {
    const seen: number[] = [];
    const counter = createCounter();
    const cleanup = $effect.root(() => {
      $effect(() => {
        seen.push(counter.count);
      });
    });
    flushSync();
    counter.increment();
    flushSync();
    cleanup();
    expect(seen).toEqual([0, 1]);
  });
});
