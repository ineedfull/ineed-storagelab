<script setup>
import { FolderOpen, Download, RefreshCw } from "lucide-vue-next";
import AppDialog from "./AppDialog.vue";
import HelpHint from "./HelpHint.vue";
import { formatFileSize } from "../domain/file-size.js";
import { formatDateTime } from "../domain/datetime.js";
import { useDirectoryDelivery } from "../composables/useDirectoryDelivery.js";
const props = defineProps({
  context: Object,
  invoke: Function,
  readOnly: Boolean,
});
const emit = defineEmits(["close"]);
const {
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
} = useDirectoryDelivery(props);
</script>
<template>
  <AppDialog
    title="目录交付"
    panel="directory"
    :busy="busy"
    @close="emit('close')"
  >
    <div class="dialog-body directory-body">
      <p class="muted directory-context">
        {{ context?.bucket || "尚未选择桶" }} /
        {{ context?.prefix || "桶根目录" }}
      </p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="notice" role="status">{{ notice }}</p>
      <div class="directory-controls">
        <label
          >传输方向<select
            v-model="direction"
            :disabled="busy || !!previewPlan"
          >
            <option value="upload" :disabled="readOnly">上传本地目录</option>
            <option value="download">下载当前前缀</option>
          </select></label
        >
        <label
          >目标已存在时<select
            v-model="conflict"
            :disabled="busy || !!previewPlan"
          >
            <option value="skip">跳过</option>
            <option value="overwrite">允许覆盖</option>
          </select></label
        >
      </div>
      <div class="toolbar directory-actions">
        <button :disabled="busy || !canPrepare" @click="previewDirectory">
          <FolderOpen :size="16" />选择目录并预览
        </button>
        <button v-if="previewPlan" :disabled="busy" @click="discardPreview">
          清除预览
        </button>
        <HelpHint label="目录交付说明"
          >上传保留子目录结构，不包含所选根目录名；下载去掉当前前缀。最多1000文件，符号链接和路径冲突不传输。上传核验会额外完整读取一次远端文件；下载会重新读取本地文件。跳过项没有内容核验结论。目录批次重启后需重新选择，不替代已有单文件续传。</HelpHint
        >
      </div>
      <p v-if="direction === 'upload' && conflict === 'skip'" class="muted">
        上传仍需服务支持可靠的不覆盖写入；不支持时须明确选择允许覆盖并重新预览。
      </p>
      <p v-if="previewPlan" role="status">
        预览 {{ previewPlan.count }} 个文件 ·
        {{
          formatFileSize(previewPlan.totalBytes)
        }}；已存在目标按当前策略处理，不可映射项保留在失败清单中。
      </p>
      <div class="directory-history">
        <label
          >批次记录<select
            :value="selectedBatchId"
            :disabled="busy"
            @change="selectBatch($event.target.value)"
          >
            <option value="">新建目录交付</option>
            <option v-for="b in batches" :key="b.id" :value="b.id">
              {{ formatDateTime(b.createdAt) }} ·
              {{ b.direction === "upload" ? "上传" : "下载" }} ·
              {{ b.bucket }} · {{ stateLabels[b.state] }}
            </option>
          </select></label
        >
        <button
          :disabled="busy"
          @click="refreshBatches"
          aria-label="刷新目录批次"
        >
          <RefreshCw :size="16" />
        </button>
      </div>
      <div v-if="selectedBatch" class="directory-summary" role="status">
        <strong>{{ stateLabels[selectedBatch.state] }}</strong>
        <span>已核验 {{ batchSummary.verified }}</span>
        <span>已跳过 {{ batchSummary.skipped }}</span>
        <span>失败/不可映射 {{ batchSummary.failed }}</span>
        <span>共 {{ batchSummary.total }} 文件</span>
        <p v-if="selectedBatch.warning" class="error">
          {{ selectedBatch.warning }}
        </p>
      </div>
      <div v-if="entries.length" class="directory-table-wrap">
        <table class="directory-table">
          <thead>
            <tr>
              <th>相对路径 / 原始 Key</th>
              <th>大小</th>
              <th>传输状态</th>
              <th>内容核验</th>
              <th>详情</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in visibleEntries" :key="row.key">
              <td>
                <span class="directory-path" :title="row.key">{{
                  row.relativePath
                }}</span
                ><small v-if="row.error" class="error">{{ row.error }}</small>
              </td>
              <td>{{ formatFileSize(row.size) }}</td>
              <td>{{ stateLabels[row.state] || row.state }}</td>
              <td>
                {{ verificationLabel(row) }}
              </td>
              <td>
                <button aria-label="查看文件详情" @click="selectedEntry = row">
                  详情
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div
        v-if="entries.length > ENTRIES_PER_PAGE"
        class="toolbar directory-pagination"
      >
        <button :disabled="!pageIndex" @click="pageIndex--">上一页</button
        ><span
          >{{ pageIndex + 1 }} /
          {{ Math.ceil(entries.length / ENTRIES_PER_PAGE) }}</span
        ><button
          :disabled="(pageIndex + 1) * ENTRIES_PER_PAGE >= entries.length"
          @click="pageIndex++"
        >
          下一页
        </button>
      </div>
      <dl v-if="selectedEntry" class="directory-evidence">
        <dt>完整原始 Key</dt>
        <dd>{{ selectedEntry.key }}</dd>
        <dt>SHA-256</dt>
        <dd>{{ selectedEntry.sha256 || "尚无通过的内容摘要" }}</dd>
        <dt>核验依据</dt>
        <dd>
          {{ checksumBasisLabel }}
        </dd>
        <template v-if="selectedEntry.localSha256"
          ><dt>本地摘要</dt>
          <dd>{{ selectedEntry.localSha256 }}</dd></template
        ><template v-if="selectedEntry.remoteSha256"
          ><dt>远端摘要</dt>
          <dd>{{ selectedEntry.remoteSha256 }}</dd></template
        >
      </dl>
      <div v-if="!previewPlan && !selectedBatch" class="directory-empty">
        <FolderOpen :size="28" />
        <p>选择目录并检查文件映射后开始传输；也可查看历史交付批次。</p>
      </div>
      <p v-if="selectedBatch" class="muted">
        清单保留各文件结果与摘要；公开链接仅按连接配置生成，尚未验证可访问性。未通过核验或跳过的文件不能视为内容一致。
      </p>
    </div>
    <template #footer>
      <button :disabled="busy" @click="emit('close')">关闭</button>
      <button v-if="selectedBatch" :disabled="busy" @click="exportManifest">
        <Download :size="16" />导出交付清单
      </button>
      <button
        v-if="transferActive"
        :disabled="busy || selectedBatch.state === 'cancelling'"
        @click="cancelTransfer"
      >
        取消目录批次
      </button>
      <button
        class="primary"
        :disabled="busy || !previewPlan?.entries?.length"
        @click="startTransfer"
      >
        开始目录传输
      </button>
    </template>
  </AppDialog>
</template>
