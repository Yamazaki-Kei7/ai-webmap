/** Smallest rune module; exists only so the unit-test setup can prove `.svelte.ts` support. */
export function createCounter() {
  let count = $state(0);
  const doubled = $derived(count * 2);
  return {
    get count() {
      return count;
    },
    get doubled() {
      return doubled;
    },
    increment() {
      count += 1;
    }
  };
}
