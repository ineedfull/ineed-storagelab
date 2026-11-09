import { ref, computed, watch } from "vue";

// Each dialog owns a captured connection/bucket and invalidates late responses on close.
export function createObjectVersions(runtime, context, onRestored = () => {}) {
  const key = ref(context.key ?? ""),
    entries = ref([]),
    selected = ref(null),
    info = ref(null),
    nextPage = ref(),
    versioning = ref("unknown"),
    loaded = ref(false),
    loading = ref(false),
    inspecting = ref(false),
    working = ref(false),
    error = ref(""),
    notice = ref(""),
    overwrite = ref(false);
  let generation = 0,
    detailGeneration = 0;
  const busy = computed(
    () => loading.value || inspecting.value || working.value,
  );
  const payload = () => ({
    connectionId: context.connectionId,
    bucket: context.bucket,
    key: key.value,
  });
  function reset() {
    generation++;
    detailGeneration++;
    entries.value = [];
    selected.value = null;
    info.value = null;
    nextPage.value = undefined;
    versioning.value = "unknown";
    loaded.value = false;
    loading.value = inspecting.value = working.value = false;
    error.value = notice.value = "";
    overwrite.value = false;
  }
  const stop = watch(key, reset, { flush: "sync" });
  async function load(page, preserveNotice = false) {
    if (working.value || !key.value.length) return;
    const id = ++generation;
    detailGeneration++;
    entries.value = [];
    selected.value = info.value = null;
    loaded.value = false;
    nextPage.value = undefined;
    versioning.value = "unknown";
    error.value = "";
    if (!preserveNotice) notice.value = "";
    loading.value = true;
    inspecting.value = false;
    try {
      const r = await runtime.invoke("listObjectVersions", {
        ...payload(),
        ...page,
      });
      if (id !== generation) return;
      entries.value = r.entries;
      nextPage.value = r.nextPage;
      versioning.value = r.versioning;
      loaded.value = true;
    } catch (e) {
      if (id === generation) error.value = `${e.code}: ${e.message}`;
    } finally {
      if (id === generation) loading.value = false;
    }
  }
  async function inspect(entry) {
    if (working.value || entry.deleteMarker || !entry.versionId) return;
    const id = generation,
      detailId = ++detailGeneration;
    selected.value = entry;
    info.value = null;
    error.value = "";
    inspecting.value = true;
    try {
      const r = await runtime.invoke("headObjectVersion", {
        ...payload(),
        versionId: entry.versionId,
      });
      if (id === generation && detailId === detailGeneration) info.value = r;
    } catch (e) {
      if (id === generation && detailId === detailGeneration)
        error.value = `${e.code}: ${e.message}`;
    } finally {
      if (id === generation && detailId === detailGeneration)
        inspecting.value = false;
    }
  }
  async function run(method) {
    if (
      busy.value ||
      !selected.value ||
      selected.value.deleteMarker ||
      !info.value
    )
      return;
    const id = generation;
    const p = {
      ...payload(),
      versionId: selected.value.versionId,
      ...(method === "downloadObjectVersion"
        ? { overwrite: overwrite.value }
        : {}),
    };
    working.value = true;
    error.value = notice.value = "";
    let restored = false;
    try {
      const r = await runtime.invoke(method, p);
      if (id !== generation) return;
      if (method === "downloadObjectVersion")
        notice.value = r.cancelled
          ? "已取消下载选择"
          : "指定版本下载已加入任务中心";
      else if (r.cancelled) notice.value = "已取消恢复";
      else {
        notice.value = `已恢复为新版本 ${r.versionId ?? "（服务未返回ID）"}。${r.warning ?? ""}`;
        restored = true;
      }
    } catch (e) {
      if (id === generation) error.value = `${e.code}: ${e.message}`;
    } finally {
      if (id === generation) working.value = false;
    }
    if (restored && id === generation) {
      onRestored(p);
      await load(undefined, true);
    }
  }
  return {
    key,
    entries,
    selected,
    info,
    nextPage,
    versioning,
    loaded,
    loading,
    inspecting,
    working,
    busy,
    error,
    notice,
    overwrite,
    load,
    inspect,
    run,
    dispose() {
      stop();
      reset();
    },
  };
}
