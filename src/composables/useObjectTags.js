import { ref, computed } from "vue";
import { validateObjectTags, sameObjectTags } from "../domain/object-tags.js";

// Each editor generation belongs to one connection/bucket/key selection.
export function createObjectTags(runtime, getTarget) {
  const draft = ref([]),
    original = ref([]),
    versionId = ref(),
    loaded = ref(false),
    busy = ref(false),
    error = ref(""),
    notice = ref("");
  let generation = 0;
  const dirty = computed(
    () => loaded.value && !sameObjectTags(draft.value, original.value),
  );
  const clone = (tags) => tags.map((t) => ({ key: t.key, value: t.value }));
  function reset() {
    generation++;
    draft.value = [];
    original.value = [];
    versionId.value = undefined;
    loaded.value = false;
    busy.value = false;
    error.value = "";
    notice.value = "";
  }
  async function load() {
    if (busy.value) return;
    const target = getTarget();
    if (!target) return;
    const version = ++generation;
    busy.value = true;
    error.value = "";
    notice.value = "";
    // A failed refresh cannot leave a previous snapshot enabled for saving.
    loaded.value = false;
    try {
      const result = await runtime.invoke("getObjectTags", target);
      if (version !== generation) return;
      original.value = clone(result.tags);
      draft.value = clone(result.tags);
      versionId.value = result.versionId;
      loaded.value = true;
    } catch (e) {
      if (version === generation) error.value = `${e.code}: ${e.message}`;
    } finally {
      if (version === generation) busy.value = false;
    }
  }
  function revert() {
    if (busy.value) return;
    draft.value = clone(original.value);
    error.value = "";
    notice.value = "";
  }
  async function save() {
    if (busy.value || !loaded.value || !dirty.value) return;
    const target = getTarget(),
      version = generation;
    if (!target) return;
    error.value = "";
    notice.value = "";
    try {
      const tags = validateObjectTags(draft.value);
      busy.value = true;
      const result = await runtime.invoke("saveObjectTags", {
        ...target,
        tags,
        originalTags: clone(original.value),
        ...(versionId.value !== undefined
          ? { versionId: versionId.value }
          : {}),
      });
      if (version !== generation) return;
      if (result.cancelled) {
        notice.value = "已取消保存标签";
        return;
      }
      original.value = clone(result.tags);
      draft.value = clone(result.tags);
      notice.value = "标签已保存";
    } catch (e) {
      if (version === generation) error.value = `${e.code}: ${e.message}`;
    } finally {
      if (version === generation) busy.value = false;
    }
  }
  return {
    draft,
    loaded,
    busy,
    dirty,
    versionId,
    error,
    notice,
    reset,
    load,
    save,
    revert,
  };
}
