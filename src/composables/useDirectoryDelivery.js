import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

export function useDirectoryDelivery(props) {
  const direction = ref("upload");
  const conflict = ref("skip");
  const busy = ref(false);
  const error = ref("");
  const notice = ref("");
  const previewPlan = ref();
  const batches = ref([]);
  const selectedBatch = ref();
  const selectedBatchId = ref("");
  const pageIndex = ref(0);
  const selectedEntry = ref();
  const ENTRIES_PER_PAGE = 50;
  const entries = computed(
    () => selectedBatch.value?.entries ?? previewPlan.value?.entries ?? [],
  );
  const visibleEntries = computed(() =>
    entries.value.slice(
      pageIndex.value * ENTRIES_PER_PAGE,
      (pageIndex.value + 1) * ENTRIES_PER_PAGE,
    ),
  );
  const canPrepare = computed(
    () =>
      props.context?.connectionId &&
      props.context?.bucket &&
      !(props.readOnly && direction.value === "upload"),
  );
  const stateLabels = {
    ready: "待传输",
    queued: "排队",
    running: "传输中",
    skipped: "已跳过",
    blocked: "不可映射",
    success: "传输完成",
    failed: "失败",
    cancelled: "已取消",
    interrupted: "已中断",
    completed: "已完成",
    cancelling: "正在取消",
  };
  const transferActive = computed(() =>
    ["running", "cancelling"].includes(selectedBatch.value?.state),
  );
  // The dialog owns its preview grant and polling; closing revokes the grant only.
  // Transfer batches remain owned by the native service and continue after close.
  let disposed = false;
  let pollTimer;
  let refreshRevision = 0;
  function publishError(reason) {
    error.value = `${reason.code ?? "ERROR"}: ${reason.message}`;
  }
  async function discardPreview() {
    const token = previewPlan.value?.token;
    previewPlan.value = undefined;
    if (token)
      await props.invoke("discardDirectoryPlan", { token }).catch(() => {
        // Best effort on close; native preview grants also expire automatically.
      });
  }
  async function refreshBatches() {
    const version = ++refreshRevision;
    const selection = selectedBatchId.value;
    try {
      const rows = await props.invoke("listDirectoryBatches", {});
      const expired = selection && !rows.some((row) => row.id === selection);
      const current =
        selection && !expired
          ? await props.invoke("getDirectoryBatch", { id: selection })
          : undefined;
      if (!disposed && version === refreshRevision) {
        batches.value = rows;
        selectedBatch.value = current;
        if (expired) {
          selectedBatchId.value = "";
          pageIndex.value = 0;
          selectedEntry.value = undefined;
          error.value = "";
          notice.value = "所选批次已超出保留范围，请重新选择批次。";
        }
        if (selectedEntry.value && current)
          selectedEntry.value = current.entries.find(
            (row) => row.key === selectedEntry.value.key,
          );
      }
    } catch (reason) {
      // A failed older poll must not overwrite a newer snapshot or its error state.
      if (!disposed && version === refreshRevision) publishError(reason);
    }
  }
  async function selectBatch(id) {
    if (busy.value) return;
    error.value = "";
    notice.value = "";
    await discardPreview();
    selectedBatchId.value = id;
    pageIndex.value = 0;
    selectedEntry.value = undefined;
    await refreshBatches();
  }
  async function previewDirectory() {
    notice.value = "";
    await runTransferAction(async () => {
      refreshRevision++;
      await discardPreview();
      selectedBatchId.value = "";
      selectedBatch.value = undefined;
      selectedEntry.value = undefined;
      pageIndex.value = 0;
      const result = await props.invoke("prepareDirectory", {
        ...props.context,
        direction: direction.value,
        conflict: conflict.value,
      });
      if (result.cancelled) return;
      if (disposed)
        await props.invoke("discardDirectoryPlan", { token: result.token });
      else previewPlan.value = result;
    });
  }
  async function startTransfer() {
    await runTransferAction(async () => {
      const result = await props.invoke("startDirectory", {
        token: previewPlan.value.token,
      });
      previewPlan.value = undefined;
      selectedBatchId.value = result.id;
      pageIndex.value = 0;
      await refreshBatches();
    });
  }
  async function runTransferAction(work) {
    if (busy.value) return;
    busy.value = true;
    error.value = "";
    try {
      await work();
    } catch (reason) {
      if (!disposed) publishError(reason);
    } finally {
      busy.value = false;
    }
  }
  async function cancelTransfer() {
    await runTransferAction(async () => {
      await props.invoke("cancelDirectory", { id: selectedBatchId.value });
      await refreshBatches();
    });
  }
  async function exportManifest() {
    notice.value = "";
    await runTransferAction(async () => {
      const result = await props.invoke("exportDirectory", {
        id: selectedBatchId.value,
      });
      if (!result.cancelled) notice.value = "交付清单已导出。";
    });
  }
  watch(
    () => JSON.stringify(props.context),
    async () => {
      refreshRevision++;
      await discardPreview();
      selectedBatchId.value = "";
      selectedBatch.value = undefined;
      selectedEntry.value = undefined;
      pageIndex.value = 0;
    },
  );
  watch(
    () => props.readOnly,
    (value) => {
      if (value) direction.value = "download";
    },
    { immediate: true },
  );
  onMounted(() => {
    refreshBatches();
    pollTimer = setInterval(refreshBatches, 1200);
  });
  onBeforeUnmount(() => {
    disposed = true;
    refreshRevision++;
    clearInterval(pollTimer);
    discardPreview();
  });

  const batchSummary = computed(() => {
    const rows = selectedBatch.value?.entries ?? [];
    return {
      verified: rows.filter((entry) => entry.verification === "verified")
        .length,
      skipped: rows.filter((entry) => entry.state === "skipped").length,
      failed: rows.filter((entry) =>
        ["failed", "blocked"].includes(entry.state),
      ).length,
      total: rows.length,
    };
  });
  function verificationLabel(entry) {
    if (entry.verification === "verified") return "SHA-256 一致";
    if (entry.verification === "failed") return "未通过";
    if (entry.state === "skipped") return "未核验";
    return "待核验";
  }
  const checksumBasisLabel = computed(() => {
    const source = selectedEntry.value?.checksumSource;
    if (source === "local-file-and-remote-full-read")
      return "源文件与上传后远端完整读取";
    if (source === "remote-response-and-local-full-read")
      return "GET响应流与本地落盘后完整读取";
    return "尚未完成完整内容核验";
  });
  return {
    direction,
    conflict,
    busy,
    error,
    notice,
    previewPlan,
    batches,
    selectedBatch,
    selectedBatchId,
    pageIndex,
    selectedEntry,
    entries,
    visibleEntries,
    canPrepare,
    stateLabels,
    transferActive,
    ENTRIES_PER_PAGE,
    batchSummary,
    verificationLabel,
    checksumBasisLabel,
    discardPreview,
    refreshBatches,
    selectBatch,
    previewDirectory,
    startTransfer,
    cancelTransfer,
    exportManifest,
  };
}
