<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from 'aws-blocks';
  import { StatusMessage } from '@aws-blocks/blocks/ui';
  import { mountNode } from '$lib/mountNode';

  type Todo = Awaited<ReturnType<typeof api.listTodos>>[number];
  type SortBy = Parameters<typeof api.listTodos>[0];

  const PRIORITIES = [
    { value: 1, label: '🔴 High' },
    { value: 2, label: '🟡 Medium' },
    { value: 3, label: '🟢 Low' }
  ];
  const DEFAULT_PRIORITY = 2;
  const SORTS: { value: SortBy; label: string }[] = [
    { value: undefined, label: 'Default' },
    { value: 'priority', label: 'Priority' },
    { value: 'title', label: 'Title' }
  ];

  const FIELD =
    'rounded border border-bb-border bg-bb-surface px-3 py-2 text-sm text-bb-text focus:border-bb-accent focus:outline-2 focus:outline-offset-1 focus:outline-bb-focus-ring';
  const BUTTON =
    'cursor-pointer rounded border border-bb-border bg-bb-surface px-4 py-2 text-sm hover:border-bb-accent';
  const BUTTON_PRIMARY =
    'cursor-pointer rounded border border-bb-accent bg-bb-accent px-4 py-2 text-sm text-bb-accent-text hover:border-bb-accent-hover hover:bg-bb-accent-hover';

  // Mounted with mountNode rather than rendered by Svelte, so the live region
  // stays mounted across redraws — that is what screen readers announce.
  const status = StatusMessage({ testId: 'todo-status' });

  let todos = $state<Todo[]>([]);
  let sortBy = $state<SortBy>();
  let newTitle = $state('');
  let newPriority = $state(DEFAULT_PRIORITY);
  const remaining = $derived(todos.filter((t) => !t.completed).length);

  async function run(action: () => Promise<unknown>, failure: string): Promise<boolean> {
    try {
      await action();
      status.set('idle');
      return true;
    } catch (e) {
      status.set('error', `${failure}: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  async function load() {
    await run(async () => {
      todos = await api.listTodos(sortBy);
    }, 'Could not load todos');
  }

  async function addTodo(event: SubmitEvent) {
    event.preventDefault();
    const title = newTitle.trim();
    if (!title) return;
    if (!(await run(() => api.createTodo(title, newPriority), 'Could not add todo'))) return;
    newTitle = '';
    await load();
  }

  function setSort(next: SortBy) {
    sortBy = next;
    load();
  }

  async function toggle(todoId: string) {
    try { await api.toggleTodo(todoId); } catch { /* conflict — just reload */ }
    await load();
  }

  async function setPriority(todoId: string, priority: number) {
    try { await api.updatePriority(todoId, priority); } catch { /* conflict */ }
    await load();
  }

  async function remove(todoId: string) {
    if (!(await run(() => api.deleteTodo(todoId), 'Could not delete todo'))) return;
    await load();
  }

  onMount(() => {
    let mounted = true;
    let unsubscribe = () => {};

    // Realtime: listen for changes from other tabs/users
    (async () => {
      try {
        const channel = await api.subscribeTodos();
        const sub = channel.subscribe(() => load());
        unsubscribe = () => sub.unsubscribe();
        if (!mounted) unsubscribe();
        await sub.established;
      } catch { /* realtime not available in local dev */ }
    })();

    load();
    return () => {
      mounted = false;
      unsubscribe();
    };
  });
</script>

<h2 class="mb-3 text-2xl font-bold">Todos</h2>

<!-- A form, so Enter adds the todo without firing while an IME is composing. -->
<form class="mb-3 flex flex-wrap items-center gap-2" onsubmit={addTodo}>
  <input
    type="text"
    placeholder="What needs to be done?"
    aria-label="New todo"
    class={[FIELD, 'min-w-50 flex-1']}
    bind:value={newTitle}
  />
  <select aria-label="Priority" class={FIELD} bind:value={newPriority}>
    {#each PRIORITIES as p (p.value)}
      <option value={p.value}>{p.label}</option>
    {/each}
  </select>
  <button type="submit" class={BUTTON_PRIMARY}>Add</button>
</form>

<div class="mb-3 flex flex-wrap items-center gap-2 text-sm text-bb-muted">
  Sort:
  {#each SORTS as s (s.label)}
    <button
      type="button"
      class={[BUTTON, sortBy === s.value && 'font-bold']}
      aria-pressed={sortBy === s.value}
      onclick={() => setSort(s.value)}
    >
      {s.label}
    </button>
  {/each}
</div>

<ul>
  {#each todos as t (t.todoId)}
    <li class={['my-2.5 flex items-center gap-2', t.completed && 'line-through opacity-50']}>
      <input
        type="checkbox"
        aria-label="Completed"
        checked={t.completed}
        onchange={() => toggle(t.todoId)}
      />
      <span class="flex-1">{t.title}</span>
      <select
        aria-label="Priority"
        class={FIELD}
        value={t.priority}
        onchange={(e) => setPriority(t.todoId, Number(e.currentTarget.value))}
      >
        {#each PRIORITIES as p (p.value)}
          <option value={p.value}>{p.label}</option>
        {/each}
      </select>
      <button type="button" aria-label="Delete" class={BUTTON} onclick={() => remove(t.todoId)}>×</button>
    </li>
  {/each}
</ul>

<p class="text-sm text-bb-muted">{remaining} remaining</p>
<div {@attach mountNode(() => status.element)}></div>
