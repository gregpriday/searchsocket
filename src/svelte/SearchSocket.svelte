<script lang="ts">
  import { serializeMetaValue, validateMetaKey } from "../utils/structured-meta";
  import type { MetaValue } from "../utils/structured-meta";

  interface Props {
    weight?: number;
    noindex?: boolean;
    tags?: string[];
    meta?: Record<string, MetaValue>;
  }

  let { weight, noindex, tags, meta }: Props = $props();

  const metaEntries = $derived(
    meta
      ? Object.entries(meta).filter(([key]) => validateMetaKey(key))
      : []
  );
</script>

<svelte:head>
  {#if weight !== undefined}
    <meta name="searchsocket-weight" content={String(weight)} />
  {/if}
  {#if noindex}
    <meta name="searchsocket:noindex" content="true" />
  {/if}
  {#if tags && tags.length > 0}
    <meta name="searchsocket:tags" content={tags.join(",")} data-type="string[]" />
  {/if}
  {#each metaEntries as [key, value]}
    {@const serialized = serializeMetaValue(value)}
    <meta name={`searchsocket:${key}`} content={serialized.content} data-type={serialized.dataType} />
  {/each}
</svelte:head>
