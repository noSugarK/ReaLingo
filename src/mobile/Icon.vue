<script setup lang="ts">
withDefaults(defineProps<{ name: "mic" | "settings" | "swap"; size?: number }>(), { size: 20 });
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <g v-if="name === 'mic'">
      <rect x="9" y="2" width="6" height="13" rx="3" />
      <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
    </g>
    <g v-else-if="name === 'settings'">
      <path d="m9 3-1 3-3 .5-2 3L5 12l-2 2.5 2 3 3 .5 1 3h6l1-3 3-.5 2-3L19 12l2-2.5-2-3-3-.5-1-3Z" />
      <circle cx="12" cy="12" r="3" />
    </g>
    <path v-else d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4" />
  </svg>
</template>
