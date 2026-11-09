<script setup>
import { computed, nextTick, ref } from "vue";
import {
  Download,
  Upload,
  RefreshCw,
  File,
  FolderOpen,
  Trash2,
  ListTodo,
  ArrowDownUp,
} from "lucide-vue-next";
import { formatDateTime } from "../domain/datetime.js";
import { formatFileSize, formatExactBytes } from "../domain/file-size.js";
import HelpHint from "./HelpHint.vue";
const props = defineProps({ model: Object });
const emit = defineEmits(["browse"]);
const busy = ref(new Set());
const direction = ref("all");
const allFilter = ref(null);
const counts = computed(() => {
  const jobs = props.model.jobs.value;
  return {
    all: jobs.length,
    upload: jobs.filter((job) => job.direction === "upload").length,
    download: jobs.filter((job) => job.direction === "download").length,
  };
});
const visibleJobs = computed(() =>
  direction.value === "all"
    ? props.model.jobs.value
    : props.model.jobs.value.filter((job) => job.direction === direction.value),
);
const directionLabel = computed(() =>
  direction.value === "upload" ? "上传" : "下载",
);
async function showAll() {
  direction.value = "all";
  await nextTick();
  allFilter.value?.focus();
}
const terminal = (job) =>
  !["queued", "running", "cancelling"].includes(job.state);
const localStateLabel = (job) =>
  ({
    missing: "本地文件已不存在",
    unsafe: "本地位置不是普通文件",
    unavailable: "本地文件暂不可访问",
  })[job.localFileState];
async function taskAction(job, method) {
  if (busy.value.has(job.id)) return;
  busy.value.add(job.id);
  try {
    const result = await props.model.action(method, { id: job.id });
    if (method === "removeJob") {
      if (!result.cancelled)
        props.model.notify(
          result.localFileTrashed
            ? "任务记录已删除，本地文件已移到回收站。"
            : result.localFileMissing
              ? "任务记录已删除，本地文件已不存在。"
              : "任务记录已删除，本地文件已保留。",
        );
    }
  } catch {
    // model.action keeps the native failure visible in the shared error banner.
  } finally {
    await props.model.refreshJobs();
    busy.value.delete(job.id);
  }
}
async function recovery(job, method) {
  if (busy.value.has(job.id)) return;
  busy.value.add(job.id);
  try {
    const r = await props.model.action(method, { id: job.id });
    props.model.notify(
      r.cancelled
        ? "已取消选择或确认，续传记录保留。"
        : method === "resumeUpload"
          ? "续传任务已加入队列。"
          : r.localOnly
            ? "已放弃本机续传记录；请到原服务人工核实并清理未完成分片。"
            : "续传分片已清理。",
      r.localOnly ? "warning" : "success",
    );
    await props.model.refreshJobs();
  } catch {
  } finally {
    busy.value.delete(job.id);
  }
}
const labels = {
  queued: "排队",
  running: "传输中",
  cancelling: "正在取消",
  cancelled: "已取消",
  success: "成功",
  failed: "失败",
  interrupted: "已中断（需重新选择文件）",
};
function fileName(key) {
  return key?.split("/").at(-1) || key || "未命名对象";
}
function hasTotal(job) {
  return Number.isFinite(job.totalBytes) && job.totalBytes > 0;
}
function progressValue(job) {
  if (job.state === "success") return hasTotal(job) ? job.totalBytes : 1;
  if (job.state === "running" && !hasTotal(job)) return undefined;
  return Math.max(0, Math.min(job.bytesTransferred || 0, job.totalBytes || 1));
}
function percentage(job) {
  if (job.state === "success") return "100%";
  if (!hasTotal(job)) return "--";
  const value = Math.max(
    0,
    Math.min(
      100,
      Math.floor(((job.bytesTransferred || 0) / job.totalBytes) * 1000) / 10,
    ),
  );
  return `${value}%`;
}
function hasActions(job) {
  return (
    ["queued", "running"].includes(job.state) ||
    (!job.resumable &&
      !job.batchId &&
      ["failed", "cancelled"].includes(job.state)) ||
    (job.resumable && job.resumeAvailable)
  );
}
</script>
<template>
  <section class="tasks">
    <div class="task-header">
      <div class="toolbar">
        <h2>任务中心</h2>
        <HelpHint label="传输任务说明">
          方向筛选只改变列表显示，导出包含全部保留的任务记录。切换页面不停止传输。普通任务重试限本会话文件授权。已启用续传的上传可重新选择相同内容文件后恢复；取消保留分片，放弃续传会原生确认清理。下载中断需重新下载；普通下载完成仅验证流与字节数，目录批次的完整内容核验以目录交付结果为准。停止后的任务可删除记录，默认保留本地文件；确认时可选择移到回收站。有本地文件关联的任务支持打开文件或所在目录；旧记录未保存位置时仅可删除记录。
        </HelpHint>
        <div class="spacer" />
        <button
          :disabled="!model.app.value.native || !counts.all"
          title="导出全部保留的任务记录"
          @click="model.action('exportJobs').catch(() => {})"
        >
          <Download :size="15" />导出任务</button
        ><button :disabled="!model.app.value.native" @click="model.refreshJobs">
          <RefreshCw :size="15" />刷新任务
        </button>
      </div>
      <div class="task-filter-bar">
        <div class="task-direction-filter" role="group" aria-label="任务方向">
          <button
            ref="allFilter"
            :class="{ active: direction === 'all' }"
            :aria-pressed="direction === 'all'"
            @click="direction = 'all'"
          >
            <ListTodo :size="15" aria-hidden="true" />全部 ({{ counts.all }})
          </button>
          <button
            :class="{ active: direction === 'upload' }"
            :aria-pressed="direction === 'upload'"
            @click="direction = 'upload'"
          >
            <Upload :size="15" aria-hidden="true" />上传 ({{ counts.upload }})
          </button>
          <button
            :class="{ active: direction === 'download' }"
            :aria-pressed="direction === 'download'"
            @click="direction = 'download'"
          >
            <Download :size="15" aria-hidden="true" />下载 ({{
              counts.download
            }})
          </button>
        </div>
        <p class="muted task-count" aria-live="polite">
          {{
            direction === "all"
              ? `共 ${counts.all} 条任务`
              : `显示 ${visibleJobs.length} / ${counts.all} 条任务`
          }}
        </p>
      </div>
    </div>
    <article
      class="job"
      v-for="j in visibleJobs"
      :key="j.id"
      :data-state="j.state"
    >
      <div class="job-identity">
        <div class="job-heading">
          <span class="job-direction">
            <Upload
              v-if="j.direction === 'upload'"
              :size="16"
              aria-hidden="true"
            />
            <Download v-else :size="16" aria-hidden="true" />
            {{ j.direction === "upload" ? "上传" : "下载" }}
          </span>
          <strong class="job-title" :title="j.key">{{
            fileName(j.key)
          }}</strong>
        </div>
        <p class="job-context" :title="`${j.connectionName} / ${j.bucket}`">
          {{ j.connectionName }} / {{ j.bucket }}
        </p>
        <p class="job-key" :title="j.key">{{ j.key }}</p>
      </div>
      <div class="job-transfer">
        <div class="job-metrics">
          <span
            :title="`${formatExactBytes(j.bytesTransferred)} / ${formatExactBytes(j.totalBytes)}；1 KB = 1024 B`"
          >
            {{ formatFileSize(j.bytesTransferred) }} /
            {{
              hasTotal(j) || j.state === "success"
                ? formatFileSize(j.totalBytes)
                : "总大小未知"
            }}
          </span>
          <span class="job-percentage">{{ percentage(j) }}</span>
        </div>
        <progress
          aria-label="传输进度"
          :value="progressValue(j)"
          :max="hasTotal(j) ? j.totalBytes : 1"
        />
        <span class="job-speed" v-if="j.state === 'running'">
          当前速度 {{ formatFileSize(Math.round(j.rate || 0)) }}/s
        </span>
      </div>
      <div class="job-summary">
        <div class="job-summary-heading">
          <span class="job-state">{{ labels[j.state] || j.state }}</span>
          <div
            v-if="terminal(j)"
            class="job-file-actions"
            role="group"
            aria-label="任务文件操作"
          >
            <template v-if="j.hasLocalFile || localStateLabel(j)">
              <button
                class="icon-button"
                aria-label="打开本地文件"
                :title="
                  localStateLabel(j) ||
                  (j.direction === 'upload' ? '打开上传源文件' : '打开下载文件')
                "
                :disabled="
                  !j.hasLocalFile || busy.has(j.id) || !model.app.value.native
                "
                @click="taskAction(j, 'openJobFile')"
              >
                <File :size="16" />
              </button>
              <button
                class="icon-button"
                aria-label="打开所在目录"
                :title="localStateLabel(j) || '打开所在目录'"
                :disabled="
                  !j.hasLocalFile || busy.has(j.id) || !model.app.value.native
                "
                @click="taskAction(j, 'revealJobFile')"
              >
                <FolderOpen :size="16" />
              </button>
            </template>
            <button
              class="icon-button"
              aria-label="删除任务记录"
              :title="
                j.canRemove === false
                  ? '请先放弃续传并清理分片，再删除记录'
                  : '删除任务记录（可选择是否保留本地文件）'
              "
              :disabled="
                busy.has(j.id) ||
                !model.app.value.native ||
                j.canRemove === false
              "
              @click="taskAction(j, 'removeJob')"
            >
              <Trash2 :size="16" />
            </button>
          </div>
        </div>
        <time class="job-time" :datetime="new Date(j.updatedAt).toJSON()">
          更新于 {{ formatDateTime(j.updatedAt) }}
        </time>
        <span
          v-if="terminal(j) && localStateLabel(j)"
          class="job-local-state muted"
          >{{ localStateLabel(j) }}</span
        >
      </div>
      <div
        class="job-feedback"
        v-if="j.resumable || j.versionId !== undefined || j.error || j.warning"
      >
        <p v-if="j.resumable" class="muted">
          分片续传上传 ·
          {{ j.resumeAvailable ? "可重新授权恢复" : "请刷新确认恢复状态" }}
        </p>
        <p v-if="j.versionId !== undefined" class="raw-key">
          指定版本：{{ j.versionId }}
        </p>
        <p class="error" v-if="j.error" role="alert">{{ j.error }}</p>
        <p class="job-warning" v-if="j.warning">{{ j.warning }}</p>
      </div>
      <div class="job-actions" v-if="hasActions(j)">
        <button
          v-if="['queued', 'running'].includes(j.state)"
          @click="
            model
              .action('cancelJob', { id: j.id })
              .then(model.refreshJobs)
              .catch(() => {})
          "
        >
          取消任务</button
        ><button
          v-if="
            !j.resumable &&
            !j.batchId &&
            ['failed', 'cancelled'].includes(j.state)
          "
          :disabled="busy.has(j.id)"
          @click="
            model
              .action('retryJob', { id: j.id })
              .then(model.refreshJobs)
              .catch(() => {})
          "
        >
          重试任务
        </button>
        <template v-if="j.resumable && j.resumeAvailable">
          <button
            :disabled="busy.has(j.id) || !model.app.value.native"
            @click="recovery(j, 'resumeUpload')"
          >
            重新选择文件并续传
          </button>
          <button
            :disabled="busy.has(j.id) || !model.app.value.native"
            @click="recovery(j, 'discardUpload')"
          >
            放弃续传并清理分片
          </button>
        </template>
      </div>
    </article>
    <div class="task-empty" v-if="!visibleJobs.length">
      <div class="task-empty-icon" aria-hidden="true">
        <ArrowDownUp v-if="!counts.all" :size="28" />
        <Upload v-else-if="direction === 'upload'" :size="28" />
        <Download v-else :size="28" />
      </div>
      <h3>{{ counts.all ? `暂无${directionLabel}任务` : "暂无传输任务" }}</h3>
      <p>
        {{
          counts.all
            ? `当前保留的记录中没有${directionLabel}任务，可查看全部任务或发起新的传输。`
            : "在对象浏览中选择连接和桶，上传文件或下载选中对象，即可在这里查看进度与记录。"
        }}
      </p>
      <div class="task-empty-actions">
        <button v-if="counts.all" @click="showAll">查看全部任务</button>
        <button :class="{ primary: !counts.all }" @click="emit('browse')">
          <FolderOpen :size="16" aria-hidden="true" />前往对象浏览
        </button>
      </div>
    </div>
  </section>
</template>
