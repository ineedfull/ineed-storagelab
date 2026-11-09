<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { CircleAlert, CircleCheck, TriangleAlert, X } from "lucide-vue-next";
const props = defineProps({
  modelValue: { type: String, default: "" },
  variant: { type: String, default: "success" },
  revision: { type: Number, default: 0 },
});
const emit = defineEmits(["update:modelValue"]);
const hovered = ref(false),
  focused = ref(false);
const visible = ref(document.visibilityState !== "hidden");
const paused = computed(() => hovered.value || focused.value || !visible.value);
let timer;
function dismiss() {
  clearTimeout(timer);
  emit("update:modelValue", "");
}
function restartTimer() {
  clearTimeout(timer);
  if (props.modelValue && props.variant === "success" && !paused.value)
    timer = setTimeout(dismiss, 6000);
}
function visibilityChanged() {
  visible.value = document.visibilityState !== "hidden";
}
watch(
  () => [props.modelValue, props.variant, props.revision, paused.value],
  restartTimer,
  { immediate: true },
);
watch(
  () => props.modelValue,
  (message) => {
    if (!message) {
      hovered.value = false;
      focused.value = false;
    }
  },
);
onMounted(() =>
  document.addEventListener("visibilitychange", visibilityChanged),
);
onBeforeUnmount(() => {
  clearTimeout(timer);
  document.removeEventListener("visibilitychange", visibilityChanged);
});
</script>
<template>
  <div
    v-if="modelValue"
    class="feedback-banner"
    :class="variant"
    :role="variant === 'error' ? 'alert' : 'status'"
    aria-atomic="true"
    @mouseenter="hovered = true"
    @mouseleave="hovered = false"
    @focusin="focused = true"
    @focusout="focused = $event.currentTarget.contains($event.relatedTarget)"
  >
    <component
      :is="
        variant === 'error'
          ? CircleAlert
          : variant === 'warning'
            ? TriangleAlert
            : CircleCheck
      "
      class="feedback-icon"
      aria-hidden="true"
    />
    <span class="feedback-text">{{ modelValue }}</span>
    <button
      class="icon-button"
      type="button"
      :aria-label="variant === 'error' ? '关闭错误' : '关闭提示'"
      :title="variant === 'error' ? '关闭错误' : '关闭提示'"
      @click="dismiss"
    >
      <X :size="16" aria-hidden="true" />
    </button>
  </div>
</template>
