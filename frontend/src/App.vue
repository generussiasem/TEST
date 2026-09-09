<script setup>
import { computed } from "vue";
import { useRoute } from "vue-router";
import { auth } from "./store.js";
import AppLayout from "./components/AppLayout.vue";

const route = useRoute();
const bare = computed(() => route.meta.public || !auth.token);
</script>

<template>
  <RouterView v-if="bare" />
  <AppLayout v-else>
    <RouterView />
  </AppLayout>
</template>
