<script setup>
import { ref, onMounted, onBeforeUnmount } from "vue";
import { X } from "lucide-vue-next";
const props = defineProps({ title: String, panel: String, busy: Boolean });
const emit = defineEmits(["close"]);
const box = ref();
let previous;
function requestClose() {
  if (!props.busy) emit("close");
}
function key(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    requestClose();
  }
  if (e.key === "Tab") {
    const els = [
      ...box.value.querySelectorAll(
        'button,input,select,textarea,a[href],[tabindex]:not([tabindex="-1"])',
      ),
    ].filter((x) => !x.matches(":disabled") && x.getClientRects().length);
    if (!els.length) {
      e.preventDefault();
      box.value.focus();
      return;
    }
    const first = els[0],
      last = els.at(-1);
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  }
}
onMounted(() => {
  previous = document.activeElement;
  box.value.querySelector("input,select,button")?.focus();
  document.addEventListener("keydown", key);
});
onBeforeUnmount(() => {
  document.removeEventListener("keydown", key);
  previous?.focus();
});
</script>
<template>
  <div class="overlay">
    <section
      class="dialog desktop-dialog"
      :class="panel ? `${panel}-panel` : ''"
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      :aria-label="title"
      ref="box"
    >
      <header>
        <h2>{{ title }}</h2>
        <button
          type="button"
          class="icon-button"
          :disabled="busy"
          @click="requestClose"
          aria-label="关闭弹窗"
          title="关闭"
        >
          <X :size="18" />
        </button>
      </header>
      <slot />
      <footer v-if="$slots.footer" class="dialog-footer">
        <slot name="footer" />
      </footer>
    </section>
  </div>
</template>
