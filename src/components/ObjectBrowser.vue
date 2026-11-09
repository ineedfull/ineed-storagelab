<script setup>
import { ref, computed } from "vue";
import { ChevronRight } from "lucide-vue-next";
import { formatDateTime } from "../domain/datetime.js";
import { formatFileSize, formatExactBytes } from "../domain/file-size.js";
import { getProvider } from "../domain/providers.js";
import { parentPrefix } from "../domain/object-prefix.js";
const refreshButton = ref();
defineExpose({
  focusRefresh() {
    refreshButton.value?.focus();
  },
});
const props = defineProps({ model: Object });
const emit = defineEmits(["share", "delete", "versions"]);
const provider = computed(() =>
  getProvider(props.model.connection.value?.provider ?? "s3"),
);
const filter = ref(""),
  sort = ref("key"),
  overwrite = ref(false),
  resumable = ref(false);
const rows = computed(() =>
  props.model.objects.value
    .filter((o) => o.key.includes(filter.value))
    .toSorted((a, b) =>
      sort.value === "size" ? a.size - b.size : a.key.localeCompare(b.key),
    ),
);
const directories = computed(() =>
  props.model.prefixes.value.filter((p) => p.includes(filter.value)),
);
function toggle(key) {
  const s = props.model.selected.value;
  s.includes(key) ? s.splice(s.indexOf(key), 1) : s.push(key);
}
</script>
<template>
  <section class="browser">
    <div class="toolbar bucket-toolbar">
      <label class="inline"
        >已知桶<input
          aria-label="已知桶"
          v-model="model.bucketDraft.value"
          placeholder="手输已知桶，不依赖列桶权限"
          @keydown.enter="model.openBucket()" /></label
      ><button
        :disabled="
          !model.app.value.native ||
          !model.connectionId.value ||
          !model.bucketDraft.value
        "
        @click="model.openBucket()"
      >
        打开桶
      </button>
      <button
        :disabled="!model.prefix.value || model.loading.value"
        @click="model.browse(parentPrefix(model.prefix.value))"
      >
        上级</button
      ><button
        ref="refreshButton"
        :disabled="!model.bucket.value || model.loading.value"
        @click="model.browse()"
      >
        刷新
      </button>
    </div>
    <div class="location-crumb">
      <code class="crumb" :title="model.bucket.value + '/' + model.prefix.value"
        >{{ model.bucket.value || "未选择桶" }} / {{ model.prefix.value }}</code
      ><span v-if="model.loading.value" class="muted">正在读取…</span>
    </div>
    <div class="toolbar object-actions wrap">
      <div class="object-commands">
        <button
          :disabled="
            !model.bucket.value ||
            model.loading.value ||
            model.connection.value?.readOnly ||
            (provider.requireOverwriteConsent && !overwrite)
          "
          @click="model.transfer('uploadFiles', overwrite, resumable)"
        >
          上传文件</button
        ><button
          :disabled="!model.selected.value.length || model.loading.value"
          @click="model.transfer('downloadFiles', overwrite)"
        >
          下载选中</button
        ><button
          :disabled="
            !model.selected.value.length ||
            model.connection.value?.readOnly ||
            model.loading.value
          "
          @click="$emit('delete')"
        >
          删除选中
        </button>
        <button
          :disabled="
            !model.app.value.native ||
            !model.bucket.value ||
            model.loading.value
          "
          @click="$emit('versions')"
        >
          版本与恢复
        </button>
      </div>
      <div class="object-filters">
        <input
          aria-label="筛选当前页"
          v-model="filter"
          placeholder="筛选当前页对象与目录"
        />
        <select v-model="sort" aria-label="当前页排序">
          <option value="key">当前页：Key 排序</option>
          <option value="size">当前页：大小排序</option>
        </select>
      </div>
    </div>
    <div class="transfer-options">
      <label class="check"
        ><input type="checkbox" v-model="overwrite" />明确允许覆盖</label
      ><label class="check"
        ><input
          type="checkbox"
          v-model="resumable"
          :disabled="
            !model.app.value.native || model.connection.value?.readOnly
          "
        />启用上传断点续传</label
      ><span class="muted" v-if="model.connection.value?.readOnly">只读</span>
      <span class="muted" v-if="provider.requireOverwriteConsent"
        >此提供商尚未验证原子不覆盖上传；请核对目标并明确允许覆盖。</span
      >
    </div>
    <div class="table-scroll" :aria-busy="model.loading.value">
      <table>
        <colgroup>
          <col style="width: 40px" />
          <col />
          <col style="width: 128px" />
          <col style="width: 205px" />
        </colgroup>
        <thead>
          <tr>
            <th>选</th>
            <th>Key / 前缀</th>
            <th class="file-size-cell">大小</th>
            <th>修改时间（本地）</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in directories" :key="'p' + p">
            <td class="directory-indicator">
              <button
                class="directory-toggle"
                :aria-label="'打开目录 ' + p"
                :title="'打开目录 ' + p"
                :disabled="model.loading.value"
                @click="model.browse(p)"
              >
                <ChevronRight
                  class="directory-chevron"
                  :stroke-width="2.25"
                  focusable="false"
                  aria-hidden="true"
                />
              </button>
            </td>
            <td colspan="3">
              <button
                class="text-key"
                :title="p"
                :disabled="model.loading.value"
                @click="model.browse(p)"
              >
                {{ p }}
              </button>
            </td>
          </tr>
          <tr
            v-for="o in rows"
            :key="o.key"
            :class="{ chosen: model.focused.value?.key === o.key }"
          >
            <td>
              <input
                type="checkbox"
                :aria-label="'选择 ' + o.key"
                :checked="model.selected.value.includes(o.key)"
                :disabled="model.loading.value"
                @change="toggle(o.key)"
              />
            </td>
            <td>
              <button
                class="text-key"
                :title="o.key"
                :disabled="model.loading.value"
                @click="model.focus(o)"
              >
                {{ o.key }}
              </button>
            </td>
            <td class="file-size-cell" :title="formatExactBytes(o.size)">
              {{ formatFileSize(o.size) }}
            </td>
            <td :title="formatDateTime(o.lastModified)">
              {{ formatDateTime(o.lastModified) }}
            </td>
          </tr>
        </tbody>
      </table>
      <p class="empty" v-if="!rows.length && !directories.length">
        {{
          model.loading.value
            ? "正在读取…"
            : model.bucket.value
              ? filter
                ? "当前页没有匹配的对象或目录。"
                : "此页没有对象或目录"
              : "选择连接并打开桶，开始浏览对象。"
        }}
      </p>
    </div>
    <footer>
      <span class="muted"
        >{{ model.prefixes.value.length }} 个目录 ·
        {{ model.objects.value.length }} 个对象<span v-if="filter">
          · 匹配 {{ rows.length + directories.length }} 项</span
        >
        · 已选 {{ model.selected.value.length }} · 每页最多 200</span
      ><button
        :disabled="!model.nextCursor.value || model.loading.value"
        @click="model.browse(model.prefix.value, model.nextCursor.value)"
      >
        下一页
      </button>
    </footer>
  </section>
</template>
