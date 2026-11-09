<script setup lang="ts">
defineProps<{ title?: string; flush?: boolean }>();
</script>

<template>
  <section class="card glass">
    <header v-if="title || $slots.action" class="card-head">
      <span class="label">{{ title }}</span>
      <slot name="action" />
    </header>
    <div class="card-body" :class="{ flush }">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.card { display: flex; flex-direction: column; min-height: 0; }
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 14px 16px 8px;
}
.card-body { padding: 0 16px 16px; display: flex; flex-direction: column; gap: 12px; min-height: 0; }
.card-body.flush { padding: 0; }
</style>
