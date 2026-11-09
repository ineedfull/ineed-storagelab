import { ref } from "vue";

/** A fixed object context and editable draft; results never leak to another selection. */
export function createObjectMutation(runtime, context, onChanged = () => {}) {
  const source = ref(null),
    targetKey = ref(context.key),
    overwrite = ref(false),
    contentType = ref(""),
    cacheControl = ref(""),
    rows = ref([]),
    loading = ref(false),
    working = ref(false),
    finished = ref(false),
    error = ref(""),
    notice = ref("");
  let generation = 0,
    disposed = false;
  const payload = () => ({
    connectionId: context.connectionId,
    bucket: context.bucket,
    key: context.key,
  });
  async function load() {
    if (working.value || disposed) return;
    const id = ++generation;
    source.value = null;
    error.value = notice.value = "";
    loading.value = true;
    finished.value = false;
    try {
      const result = await runtime.invoke("prepareObjectMutation", payload());
      if (disposed || id !== generation) return;
      source.value = result;
      contentType.value = result.contentType ?? "";
      cacheControl.value = result.cacheControl ?? "";
      rows.value = Object.entries(result.metadata ?? {}).map(
        ([key, value]) => ({ key, value }),
      );
    } catch (e) {
      if (!disposed && id === generation)
        error.value = `${e.code ?? "ERROR"}: ${e.message}`;
    } finally {
      if (!disposed && id === generation) loading.value = false;
    }
  }
  async function save() {
    if (
      disposed ||
      working.value ||
      loading.value ||
      finished.value ||
      !source.value ||
      context.readOnly
    )
      return;
    error.value = notice.value = "";
    const p = {
      ...payload(),
      kind: context.kind,
      original: JSON.parse(JSON.stringify(source.value)),
      overwrite: overwrite.value,
    };
    if (context.kind === "metadata") {
      const keys = rows.value.map((r) => r.key.toLowerCase());
      if (new Set(keys).size !== keys.length) {
        error.value = "元数据键不能重复（不区分大小写）。";
        return;
      }
      p.metadata = Object.fromEntries(rows.value.map((r) => [r.key, r.value]));
      p.contentType = contentType.value;
      p.cacheControl = cacheControl.value;
    } else {
      p.targetKey = targetKey.value;
    }
    const id = generation;
    working.value = true;
    try {
      const r = await runtime.invoke("executeObjectMutation", p);
      if (disposed || id !== generation) return;
      if (r.cancelled) {
        notice.value = "已取消操作，草稿保留。";
        return;
      }
      finished.value = true;
      notice.value = r.sourceDeletionUncertain
        ? "复制完成，源删除结果不明确，请核实源与目标。"
        : r.sourceRetained
          ? "复制完成，源对象保留。"
          : context.kind === "metadata"
            ? "元数据已更新。"
            : context.kind === "rename" && r.renamed
              ? "重命名已完成。"
              : "复制已完成。";
      if (r.warning) notice.value += " " + r.warning;
      onChanged(p);
    } catch (e) {
      if (!disposed && id === generation)
        error.value = `${e.code ?? "ERROR"}: ${e.message} 请先刷新核实远端结果。`;
    } finally {
      if (!disposed && id === generation) working.value = false;
    }
  }
  return {
    source,
    targetKey,
    overwrite,
    contentType,
    cacheControl,
    rows,
    loading,
    working,
    finished,
    error,
    notice,
    load,
    save,
    dispose() {
      disposed = true;
      generation++;
      source.value = null;
      loading.value = working.value = false;
    },
  };
}
