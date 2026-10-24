<script lang="ts">
  import type { CurationCategory, CurationGroup } from '@tv/shared';
  import type { PickerState } from '$lib/curation/picker';
  import VirtualList from './VirtualList.svelte';

  type Props = {
    style: 'tagged' | 'mixed' | 'untagged';
    groups: CurationGroup[];
    picker: PickerState;
    /** Bumped on every change so the template re-reads the picker. */
    rev: number;
    onchange: () => void;
  };

  let { style, groups, picker, rev, onchange }: Props = $props();

  const ROW = 48;
  const VIRTUAL_FROM = 40; // groups longer than this render through VirtualList
  const STICKY = 72; // search bar height to leave clear when jumping

  let open = $state<Record<string, boolean>>({});
  let query = $state('');
  let listHost: HTMLDivElement | undefined = $state();

  const hasUntagged = $derived(picker.untagged.length > 0);
  const NO_TAG = '\u0000no-tag'; // never a real tag; keys the "No tag" row's open state only

  function vis(remoteId: string): boolean {
    void rev;
    return picker.isVisible(remoteId);
  }
  function groupOf(tag: string) {
    void rev;
    return picker.groupState(tag);
  }
  function keptIn(g: CurationGroup): number {
    void rev;
    return g.categories.filter((c) => picker.isVisible(c.remoteId)).length;
  }
  const keptUntagged = $derived.by(() => {
    void rev;
    return picker.untagged.filter((c) => picker.isVisible(c.remoteId)).length;
  });
  const matches = $derived.by(() => {
    void rev;
    return picker.filter(query);
  });
  const strip = $derived(query.trim() === '' ? picker.azIndex() : []);

  const changed = (fn: () => void) => () => {
    fn();
    onchange();
  };

  function indeterminate(node: HTMLInputElement, on: boolean) {
    node.indeterminate = on;
    return {
      update(next: boolean) {
        node.indeterminate = next;
      },
    };
  }

  function jump(index: number) {
    if (!listHost) return;
    const top = window.scrollY + listHost.getBoundingClientRect().top + index * ROW - STICKY;
    window.scrollTo({ top: Math.max(0, top) });
  }
</script>

{#snippet catRow(c: CurationCategory)}
  <label class="cat">
    <input type="checkbox" checked={vis(c.remoteId)} onchange={changed(() => picker.toggleCategory(c.remoteId))} />
    <span class="name">{c.displayName}{#if c.isNew} <span class="new">New</span>{/if}</span>
    <span class="count">{c.itemCount}</span>
  </label>
{/snippet}

{#snippet untaggedList()}
  <div class="search">
    <input
      type="search"
      bind:value={query}
      placeholder="Search categories"
      aria-label="Search categories"
      autocapitalize="off"
      autocorrect="off"
      spellcheck="false"
    />
    {#if query.trim() !== '' && matches.length > 0}
      <div class="bulk">
        <button type="button" onclick={changed(() => picker.keepMatches(query))}>Keep all {matches.length} matches</button>
        <button type="button" onclick={changed(() => picker.hideMatches(query))}>Hide all {matches.length}</button>
      </div>
    {/if}
  </div>
  {#if matches.length === 0}
    <p class="muted empty">No categories match.</p>
  {:else}
    <div class="listwrap" bind:this={listHost}>
      <div class="list inner">
        <VirtualList items={matches} rowHeight={ROW}>
          {#snippet row(c: CurationCategory)}
            {@render catRow(c)}
          {/snippet}
        </VirtualList>
      </div>
      {#if strip.length > 1}
        <nav class="az" aria-label="Jump to letter">
          {#each strip as s (s.letter)}
            <button type="button" onclick={() => jump(s.index)}>{s.letter}</button>
          {/each}
        </nav>
      {/if}
    </div>
  {/if}
{/snippet}

{#if style === 'untagged'}
  {@render untaggedList()}
{:else}
  <ul class="groups">
    {#each groups as g (g.tag)}
      {@const st = groupOf(g.tag)}
      <li class="group">
        <div class="ghead">
          <button
            type="button"
            class="expander"
            aria-expanded={open[g.tag] === true}
            onclick={() => (open[g.tag] = !open[g.tag])}
          >
            <span class="tag">{g.tag}</span>
            <span class="gtext">
              <span class="gname">{g.friendlyName ?? (g.hint.length ? g.hint.join(', ') : g.tag)}</span>
              <span class="muted gcount">{keptIn(g)} of {g.categories.length} kept</span>
            </span>
            <span class="chev" aria-hidden="true">{open[g.tag] ? '⌄' : '›'}</span>
          </button>
          <label class="switch">
            <input
              type="checkbox"
              checked={st === 'on'}
              use:indeterminate={st === 'some'}
              aria-label={`Keep ${g.friendlyName ?? g.tag}`}
              onchange={changed(() => picker.toggleGroup(g.tag))}
            />
            <span class="track" aria-hidden="true"><span class="knob"></span></span>
          </label>
        </div>
        {#if open[g.tag]}
          <div class="list inner">
            {#if g.categories.length > VIRTUAL_FROM}
              <VirtualList items={g.categories} rowHeight={ROW}>
                {#snippet row(c: CurationCategory)}
                  {@render catRow(c)}
                {/snippet}
              </VirtualList>
            {:else}
              {#each g.categories as c (c.remoteId)}
                <div class="fixed">{@render catRow(c)}</div>
              {/each}
            {/if}
          </div>
        {/if}
      </li>
    {/each}
    {#if hasUntagged}
      <li class="group">
        <div class="ghead">
          <button
            type="button"
            class="expander"
            aria-expanded={open[NO_TAG] === true}
            onclick={() => (open[NO_TAG] = !open[NO_TAG])}
          >
            <span class="tag none">No tag</span>
            <span class="gtext">
              <span class="gname">Everything without a tag</span>
              <span class="muted gcount">{keptUntagged} of {picker.untagged.length} kept</span>
            </span>
            <span class="chev" aria-hidden="true">{open[NO_TAG] ? '⌄' : '›'}</span>
          </button>
        </div>
        {#if open[NO_TAG]}
          {@render untaggedList()}
        {/if}
      </li>
    {/if}
  </ul>
{/if}

<style>
  .groups {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 10px;
  }
  .group {
    background: var(--surface);
    border-radius: 12px;
    overflow: clip;
  }
  .ghead {
    display: flex;
    align-items: center;
  }
  .expander {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 60px;
    padding: 8px 12px 8px 16px;
    background: none;
    border: 0;
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .tag {
    flex: none;
    min-width: 44px;
    padding: 4px 8px;
    border-radius: 8px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    font-weight: 700;
    font-size: 0.85rem;
    text-align: center;
  }
  .tag.none {
    color: var(--muted);
    font-weight: 600;
  }
  .gtext {
    flex: 1;
    min-width: 0;
    display: grid;
  }
  .gname {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .gcount {
    font-size: 0.85rem;
  }
  .chev {
    color: var(--muted);
  }
  .switch {
    flex: none;
    position: relative;
    display: grid;
    place-items: center;
    width: 72px;
    min-height: 60px;
    cursor: pointer;
  }
  .switch input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    cursor: pointer;
  }
  .track {
    position: relative;
    width: 50px;
    height: 30px;
    border-radius: 15px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    transition: background 0.15s;
  }
  .knob {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--muted);
    transition: transform 0.15s, background 0.15s;
  }
  input:checked + .track {
    background: color-mix(in srgb, var(--accent) 40%, var(--surface-2));
  }
  input:checked + .track .knob {
    transform: translateX(20px);
    background: var(--accent);
  }
  input:indeterminate + .track {
    background: color-mix(in srgb, var(--accent) 20%, var(--surface-2));
  }
  input:indeterminate + .track .knob {
    transform: translateX(10px);
    background: var(--accent);
  }
  input:focus-visible + .track,
  .cat input:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .inner {
    border-top: 1px solid var(--border);
    border-radius: 0;
    background: var(--surface);
  }
  .cat {
    display: flex;
    align-items: center;
    gap: 14px;
    height: 48px;
    padding: 0 16px;
    color: var(--text);
    font-size: 1rem;
    cursor: pointer;
  }
  .fixed {
    border-top: 1px solid var(--border);
  }
  .fixed:first-child {
    border-top: 0;
  }
  .cat input {
    flex: none;
    width: 24px;
    height: 24px;
    min-height: 0;
    padding: 0;
    accent-color: var(--accent);
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .new {
    margin-left: 6px;
    padding: 2px 6px;
    border-radius: 6px;
    background: var(--accent);
    color: #06101f;
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
  }
  .search {
    position: sticky;
    top: 0;
    z-index: 2;
    display: grid;
    gap: 8px;
    padding: 8px 0;
    background: var(--bg);
  }
  .search input {
    width: 100%;
  }
  .bulk {
    display: flex;
    gap: 8px;
  }
  .bulk button {
    flex: 1;
    min-height: 44px;
    border-radius: 12px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text);
    font: inherit;
    cursor: pointer;
  }
  .empty {
    padding: 16px;
  }
  .listwrap {
    position: relative;
  }
  .listwrap > .inner {
    margin-right: 28px;
    border-radius: 12px;
  }
  .az {
    position: fixed;
    right: 2px;
    top: 140px;
    bottom: calc(var(--tabbar-height) + 90px);
    z-index: 3;
    width: 28px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    overflow: hidden;
  }
  .az button {
    flex: 1 1 0;
    min-height: 0;
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent);
    font: inherit;
    font-size: 0.7rem;
    font-weight: 700;
    cursor: pointer;
  }
</style>
