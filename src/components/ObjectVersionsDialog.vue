<script setup>
import { computed, onBeforeUnmount } from "vue";
import AppDialog from "./AppDialog.vue";
import HelpHint from "./HelpHint.vue";
import FeedbackBanner from "./FeedbackBanner.vue";
import { History, FileClock, Download, RotateCcw } from "lucide-vue-next";
import { createObjectVersions } from "../composables/useObjectVersions.js";
import { getProvider } from "../domain/providers.js";
import { formatDateTime } from "../domain/datetime.js";
import { formatFileSize, formatExactBytes } from "../domain/file-size.js";
const props = defineProps({ context: Object, invoke: Function });
const emit = defineEmits(["close", "restored"]);
const v = createObjectVersions(
  { invoke: props.invoke },
  { ...props.context },
  (p) => emit("restored", p),
);
const unsupported =
  getProvider(props.context.provider).versions === "unsupported";
const canRestore = computed(
  () =>
    !props.context.readOnly &&
    v.versioning.value === "enabled" &&
    v.info.value &&
    v.selected.value?.versionId !== "null" &&
    Number.isSafeInteger(v.info.value.size) &&
    v.info.value.size <= 5 * 1024 ** 3,
);
const status = computed(
  () =>
    ({
      enabled: "已开启",
      suspended: "已暂停",
      disabled: "未开启",
      unknown: "未知（权限或兼容性受限）",
    })[v.versioning.value],
);
onBeforeUnmount(v.dispose);
</script>
<template>
  <AppDialog
    title="对象版本与恢复"
    panel="versions"
    :busy="v.working.value"
    @close="!v.working.value && $emit('close')"
  >
    <div class="dialog-body dialog-content versions-body">
      <section class="version-query" aria-label="版本查询">
        <p class="version-location raw-key muted">
          {{ context.connectionName }} / {{ context.bucket }}
        </p>
        <form @submit.prevent="v.load()">
          <div class="field-label">
            <label for="version-original-key">完整原始 Key</label>
            <HelpHint label="历史版本查询说明"
              >输入完整
              Key，可查找当前已删除对象的历史。按需读取，每页最多200条，仅展示此
              Key。Key 中的空格和特殊字符原样保留。</HelpHint
            >
          </div>
          <div class="version-query-controls">
            <textarea
              id="version-original-key"
              v-model="v.key.value"
              rows="2"
              maxlength="1024"
              :disabled="v.working.value"
              placeholder="例如：documents/report.pdf"
            />
            <button
              :disabled="unsupported || v.busy.value || !v.key.value.length"
              type="submit"
            >
              <History :size="16" />读取历史版本
            </button>
          </div>
        </form>
      </section>
      <FeedbackBanner v-model="v.error.value" variant="error" />
      <FeedbackBanner v-model="v.notice.value" />
      <p v-if="unsupported" class="muted">
        此提供商的 S3 接入不支持对象版本管理。
      </p>
      <div class="version-workspace">
        <section class="version-history" aria-label="版本历史">
          <div class="version-section-heading">
            <h3>历史版本</h3>
            <div class="field-label">
              <span v-if="v.loaded.value" class="versioning-state"
                >桶版本控制：{{ status }}</span
              >
              <HelpHint label="桶版本控制说明"
                >未开启或已暂停版本控制时，历史记录取决于服务端实际保留情况。权限失败会单独提示，不代表没有历史版本。</HelpHint
              >
            </div>
          </div>
          <p
            v-if="v.loading.value"
            class="version-placeholder muted"
            role="status"
          >
            正在读取历史版本…
          </p>
          <template v-else-if="v.loaded.value">
            <div
              class="table-scroll version-table"
              tabindex="0"
              aria-label="历史版本列表"
            >
              <table>
                <colgroup>
                  <col style="width: 88px" />
                  <col style="width: 64px" />
                  <col style="width: 205px" />
                  <col style="width: 110px" />
                  <col />
                </colgroup>
                <thead>
                  <tr>
                    <th>类型</th>
                    <th>状态</th>
                    <th>修改时间（本地）</th>
                    <th class="file-size-cell">大小</th>
                    <th>版本 ID</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="row in v.entries.value"
                    :key="`${row.deleteMarker}/${row.versionId}`"
                    :class="{ chosen: v.selected.value === row }"
                  >
                    <td>
                      <span :class="{ muted: row.deleteMarker }">{{
                        row.deleteMarker ? "删除标记" : "数据版本"
                      }}</span>
                    </td>
                    <td>
                      <span :class="{ 'version-latest': row.latest }">{{
                        row.latest ? "最新" : "历史"
                      }}</span>
                    </td>
                    <td
                      class="version-date"
                      :title="formatDateTime(row.lastModified)"
                    >
                      {{ formatDateTime(row.lastModified) }}
                    </td>
                    <td
                      class="file-size-cell"
                      :title="
                        row.deleteMarker
                          ? undefined
                          : formatExactBytes(row.size)
                      "
                    >
                      {{ row.deleteMarker ? "--" : formatFileSize(row.size) }}
                    </td>
                    <td>
                      <button
                        class="text-key"
                        :title="row.versionId"
                        :aria-label="`选择版本 ${row.versionId}`"
                        :aria-current="
                          v.selected.value === row ? 'true' : undefined
                        "
                        :disabled="
                          row.deleteMarker || !row.versionId || v.working.value
                        "
                        @click="v.inspect(row)"
                      >
                        {{ row.versionId || "无版本 ID" }}
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
              <p v-if="!v.entries.value.length" class="empty">
                本页没有此 Key 的历史版本
              </p>
            </div>
            <div class="version-pagination">
              <span class="muted">本页 {{ v.entries.value.length }} 条</span
              ><button
                :disabled="!v.nextPage.value || v.busy.value"
                @click="v.load(v.nextPage.value)"
              >
                下一页版本
              </button>
            </div>
            <p class="muted version-caption">
              选择数据版本查看详情；删除标记表示该时刻对象已删除。
            </p>
          </template>
          <div v-else class="version-placeholder muted">
            <History :size="28" aria-hidden="true" />
            <p>输入完整 Key，读取这个对象的历史版本。</p>
          </div>
        </section>
        <section class="version-info" aria-label="所选版本">
          <div class="version-section-heading">
            <h3>版本详情</h3>
            <HelpHint label="版本保留信息说明"
              >缺失保留信息不代表没有保护，可能受到权限或服务兼容性限制。下载和恢复均针对所选版本
              ID。</HelpHint
            >
          </div>
          <template v-if="v.selected.value">
            <label class="version-id-field"
              >版本 ID<textarea
                :value="v.selected.value.versionId"
                rows="2"
                readonly
              />
            </label>
            <p v-if="v.selected.value.versionId === 'null'" class="muted">
              null版本可被替换，下载时获取该标识当时的内容；不提供恢复操作。
            </p>
            <p v-if="v.inspecting.value" class="muted" role="status">
              正在读取指定版本属性…
            </p>
            <template v-if="v.info.value">
              <dl class="version-properties">
                <dt>大小</dt>
                <dd :title="formatExactBytes(v.info.value.size)">
                  {{ formatFileSize(v.info.value.size) }}
                </dd>
                <dt>Content-Type</dt>
                <dd>{{ v.info.value.contentType || "--" }}</dd>
                <dt>保留模式</dt>
                <dd>{{ v.info.value.retention.mode || "未知／未返回" }}</dd>
                <dt>保留到期</dt>
                <dd>
                  {{ formatDateTime(v.info.value.retention.retainUntil) }}
                </dd>
                <dt>Legal Hold</dt>
                <dd>
                  {{ v.info.value.retention.legalHold || "未知／未返回" }}
                </dd>
              </dl>
              <details class="version-metadata">
                <summary>
                  Metadata
                  <span class="muted"
                    >{{
                      Object.keys(v.info.value.metadata || {}).length
                    }}
                    项</span
                  >
                </summary>
                <pre>{{
                  JSON.stringify(v.info.value.metadata || {}, null, 2)
                }}</pre>
              </details>
              <label class="check"
                ><input
                  type="checkbox"
                  v-model="v.overwrite.value"
                  :disabled="v.working.value"
                />允许覆盖本地同名文件</label
              >
            </template>
          </template>
          <div v-else class="version-detail-empty muted">
            <FileClock :size="28" aria-hidden="true" />
            <p>从历史列表选择一个数据版本，查看属性并下载或恢复。</p>
          </div>
        </section>
      </div>
      <div class="help-caption version-restore-note">
        <p class="muted">恢复会更新当前可见内容并创建新版本，历史版本保留。</p>
        <HelpHint label="版本恢复说明"
          >仅限已开启版本控制的桶、不可变数据版本及≤5
          GiB。只读连接可查看和下载。恢复由原生再次确认；ACL、加密及保留规则采用桶默认配置，并发写入仍可能成为最新。出错后先刷新核实。</HelpHint
        >
      </div>
      <p v-if="v.working.value" class="muted" role="status">
        正在处理，请完成原生选择或确认后再关闭。
      </p>
    </div>
    <template #footer>
      <button type="button" :disabled="v.working.value" @click="$emit('close')">
        关闭
      </button>
      <button
        :disabled="v.busy.value || !v.info.value"
        @click="v.run('downloadObjectVersion')"
      >
        <Download :size="16" />下载所选版本
      </button>
      <button
        class="primary"
        :disabled="v.busy.value || !canRestore"
        @click="v.run('restoreObjectVersion')"
      >
        <RotateCcw :size="16" />恢复为当前对象
      </button>
    </template>
  </AppDialog>
</template>
