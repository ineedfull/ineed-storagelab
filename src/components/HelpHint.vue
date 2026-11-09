<script setup>
import { ref, useId, onMounted, onBeforeUnmount } from "vue";
import { CircleHelp } from "lucide-vue-next";

const props = defineProps({
  label: { type: String, required: true },
  id: String,
});
const generatedId = useId();
const trigger = ref();
const panel = ref();
const expanded = ref(false);
let pinned = false;
let timer;

function position() {
  if (!panel.value?.matches(":popover-open")) return;
  const anchor = trigger.value.getBoundingClientRect();
  const box = panel.value.getBoundingClientRect();
  const left = Math.max(12, Math.min(anchor.left, innerWidth - box.width - 12));
  const below = anchor.bottom + 8;
  const top =
    below + box.height <= innerHeight - 12
      ? below
      : Math.max(12, anchor.top - box.height - 8);
  Object.assign(panel.value.style, { left: `${left}px`, top: `${top}px` });
}
function show() {
  clearTimeout(timer);
  panel.value.showPopover();
  expanded.value = true;
  position();
}
function hide() {
  clearTimeout(timer);
  panel.value?.hidePopover();
  expanded.value = false;
  pinned = false;
}
function enter() {
  show();
}
function leave() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (
      !pinned &&
      !trigger.value.matches(":hover") &&
      !panel.value.matches(":hover") &&
      document.activeElement !== trigger.value
    )
      hide();
  }, 160);
}
function toggle() {
  if (pinned) hide();
  else {
    pinned = true;
    show();
  }
}
function escape(event) {
  if (event.key !== "Escape" || !panel.value?.matches(":popover-open")) return;
  // Close help first, keeping a containing application dialog open.
  event.preventDefault();
  event.stopImmediatePropagation();
  hide();
}
function changed(event) {
  expanded.value = event.newState === "open";
  if (!expanded.value) pinned = false;
}
onMounted(() => {
  document.addEventListener("keydown", escape, true);
  window.addEventListener("resize", position);
  document.addEventListener("scroll", position, true);
});
onBeforeUnmount(() => {
  clearTimeout(timer);
  document.removeEventListener("keydown", escape, true);
  window.removeEventListener("resize", position);
  document.removeEventListener("scroll", position, true);
});
</script>

<template>
  <span class="help-hint">
    <button
      ref="trigger"
      type="button"
      class="help-trigger"
      :aria-label="label"
      :aria-describedby="props.id || generatedId"
      :aria-controls="props.id || generatedId"
      :aria-expanded="expanded"
      @mouseenter="enter"
      @mouseleave="leave"
      @focus="show"
      @blur="leave"
      @click="toggle"
    >
      <CircleHelp :size="16" aria-hidden="true" />
    </button>
    <span
      ref="panel"
      :id="props.id || generatedId"
      popover="auto"
      role="tooltip"
      :aria-label="label"
      class="help-popover"
      @toggle="changed"
      @mouseenter="enter"
      @mouseleave="leave"
      ><slot
    /></span>
  </span>
</template>
