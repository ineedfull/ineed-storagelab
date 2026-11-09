import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { bridge } from "../runtime/bridge.js";
import { createObjectTags } from "./useObjectTags.js";
export function createWorkbench(runtime = bridge) {
  const connections = ref([]),
    settings = ref({
      theme: "system",
      largeText: false,
      sidebarCollapsed: false,
      concurrency: 2,
      timeoutSeconds: 30,
    }),
    jobs = ref([]),
    app = ref({ native: false }),
    connectionId = ref(""),
    bucket = ref(""),
    bucketDraft = ref(""),
    buckets = ref([]),
    prefix = ref(""),
    objects = ref([]),
    prefixes = ref([]),
    nextCursor = ref(),
    selected = ref([]),
    focused = ref(null),
    detail = ref(null),
    preview = ref(null),
    error = ref(""),
    notice = ref(""),
    noticeRevision = ref(0),
    noticeVariant = ref("success"),
    loading = ref(false);
  let selectionVersion = 0,
    listVersion = 0,
    detailVersion = 0,
    jobsVersion = 0,
    disposed = false,
    enumerationError = "",
    browseError = "",
    listedContext,
    off;
  function notify(message, variant = "success") {
    notice.value = message;
    noticeVariant.value = variant;
    noticeRevision.value++;
  }
  function retireBrowseError() {
    if (error.value === browseError) error.value = "";
    browseError = "";
  }
  function retireEnumerationError() {
    if (error.value === enumerationError) error.value = "";
    enumerationError = "";
  }
  function openBucket(name = bucketDraft.value) {
    bucket.value = name;
    bucketDraft.value = name;
    return browse("");
  }
  const connection = computed(() =>
    connections.value.find((c) => c.id === connectionId.value),
  );
  const payload = () => ({
    connectionId: connectionId.value,
    bucket: bucket.value,
  });
  const objectTags = createObjectTags(runtime, () =>
    focused.value ? { ...payload(), key: focused.value.key } : null,
  );
  async function action(method, p = {}) {
    try {
      return await runtime.invoke(method, p);
    } catch (e) {
      error.value = `${e.code}: ${e.message}`;
      throw e;
    }
  }
  async function refreshJobs() {
    if (disposed) return;
    const version = ++jobsVersion;
    try {
      const result = await runtime.invoke("listJobs");
      if (version === jobsVersion && !disposed) jobs.value = result;
    } catch (e) {
      if (version === jobsVersion && !disposed)
        error.value = `${e.code}: ${e.message}`;
    }
  }
  async function browse(p = prefix.value, cursor) {
    const version = ++listVersion;
    const context = JSON.stringify([
      connectionId.value,
      bucket.value,
      p,
      cursor ?? null,
    ]);
    prefix.value = p;
    selected.value = [];
    objectTags.reset();
    focused.value = null;
    detail.value = null;
    preview.value = null;
    detailVersion++;
    // Keep a same-page refresh steady; never show old rows in a new context.
    if (context !== listedContext) {
      objects.value = [];
      prefixes.value = [];
    }
    nextCursor.value = undefined;
    if (!bucket.value) return;
    loading.value = true;
    try {
      const result = await runtime.invoke("listObjects", {
        ...payload(),
        prefix: p,
        ...(cursor ? { cursor } : {}),
      });
      if (version !== listVersion) return;
      retireEnumerationError();
      retireBrowseError();
      objects.value = result.objects;
      prefixes.value = result.prefixes;
      nextCursor.value = result.nextCursor;
      listedContext = context;
    } catch (e) {
      if (version === listVersion) {
        browseError = `${e.code}: ${e.message}`;
        error.value = browseError;
        objects.value = [];
        prefixes.value = [];
        nextCursor.value = undefined;
        listedContext = undefined;
      }
    } finally {
      if (version === listVersion) loading.value = false;
    }
  }
  function resetContext(id = "") {
    retireEnumerationError();
    retireBrowseError();
    if (noticeVariant.value === "success") notice.value = "";
    listedContext = undefined;
    selectionVersion++;
    listVersion++;
    detailVersion++;
    connectionId.value = id;
    bucket.value = connection.value?.defaultBucket ?? "";
    bucketDraft.value = bucket.value;
    buckets.value = [];
    prefix.value = "";
    objects.value = [];
    prefixes.value = [];
    nextCursor.value = undefined;
    selected.value = [];
    objectTags.reset();
    focused.value = null;
    detail.value = null;
    preview.value = null;
    loading.value = false;
  }
  async function selectConnection(id) {
    resetContext(id);
    const version = selectionVersion;
    const initialListVersion = listVersion;
    if (!id) return;
    try {
      const result = await runtime.invoke("listBuckets", { connectionId: id });
      if (version !== selectionVersion) return;
      buckets.value = result.buckets;
    } catch (e) {
      if (version !== selectionVersion) return;
      enumerationError = `列桶权限/访问失败（当前连接）；仍可打开已知桶。${e.code}: ${e.message}`;
      if (!error.value) error.value = enumerationError;
    }
    if (
      version === selectionVersion &&
      initialListVersion === listVersion &&
      bucket.value
    )
      await browse("");
  }
  async function removeConnection(id = connectionId.value) {
    // Capture the target before awaiting; a later switch must never retarget removal.
    if (connectionId.value === id) {
      // Retire pending reads now, but keep the visible context until removal succeeds.
      // Permission failures or active transfers must not discard the user's position.
      selectionVersion++;
      listVersion++;
      detailVersion++;
      loading.value = false;
    }
    await action("removeConnection", { id });
    connections.value = connections.value.filter((c) => c.id !== id);
    // The user may have reselected this same connection while removal was pending.
    if (connectionId.value === id) resetContext();
  }
  async function focus(object) {
    objectTags.reset();
    focused.value = object;
    detail.value = null;
    preview.value = null;
    const version = ++detailVersion;
    try {
      const result = await runtime.invoke("headObject", {
        ...payload(),
        key: object.key,
      });
      if (version === detailVersion) detail.value = result;
    } catch (e) {
      if (version === detailVersion) error.value = `${e.code}: ${e.message}`;
    }
  }
  async function loadPreview() {
    const key = focused.value?.key,
      version = detailVersion;
    try {
      const result = await runtime.invoke("previewObject", {
        ...payload(),
        key,
      });
      if (version === detailVersion && focused.value?.key === key)
        preview.value = result;
    } catch (e) {
      if (version === detailVersion) error.value = `${e.code}: ${e.message}`;
    }
  }
  async function transfer(method, overwrite, resumable = false) {
    try {
      const result = await action(method, {
        ...payload(),
        ...(method === "uploadFiles"
          ? { prefix: prefix.value }
          : { keys: selected.value }),
        overwrite,
        ...(method === "uploadFiles" && resumable ? { resumable: true } : {}),
      });
      notify(result.cancelled ? "已取消选择" : "任务已加入队列");
      await refreshJobs();
    } catch {}
  }
  async function initialize() {
    try {
      const state = await action("bootstrap");
      connections.value = state.connections;
      settings.value = state.settings;
      jobs.value = state.jobs;
      app.value = state.app;
      off = runtime.onChange(refreshJobs);
    } catch {}
  }
  function dispose() {
    disposed = true;
    jobsVersion++;
    objectTags.reset();
    off?.();
  }
  return {
    initialize,
    dispose,
    objectTags,
    connections,
    settings,
    jobs,
    app,
    connectionId,
    connection,
    bucket,
    bucketDraft,
    openBucket,
    buckets,
    prefix,
    objects,
    prefixes,
    nextCursor,
    selected,
    focused,
    detail,
    preview,
    error,
    notice,
    noticeRevision,
    noticeVariant,
    notify,
    loading,
    action,
    browse,
    selectConnection,
    removeConnection,
    focus,
    loadPreview,
    transfer,
    refreshJobs,
    payload,
  };
}

export function useWorkbench() {
  const model = createWorkbench();
  onMounted(model.initialize);
  onBeforeUnmount(model.dispose);
  return model;
}
