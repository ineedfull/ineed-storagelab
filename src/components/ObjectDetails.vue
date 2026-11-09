<script setup>
import { formatDateTime } from "../domain/datetime.js";
import { formatFileSize, formatExactBytes } from "../domain/file-size.js";
import ObjectTags from "./ObjectTags.vue";
import HelpHint from "./HelpHint.vue";
import { X } from "lucide-vue-next";
defineProps({ model: Object });
defineEmits(["share", "versions", "mutation", "close"]);
</script>
<template>
  <aside class="details">
    <header class="details-header">
      <h2>属性与预览</h2>
      <button
        class="icon-button"
        aria-label="关闭详情"
        title="关闭详情"
        @click="$emit('close')"
      >
        <X :size="16" aria-hidden="true" />
      </button>
    </header>
    <template v-if="model.focused.value"
      ><label
        >完整原始 Key<textarea
          class="detail-key"
          readonly
          :value="model.focused.value.key"
          rows="6"
        />
      </label>
      <div class="detail-key-actions">
        <button
          @click="
            model
              .action('copyText', { text: model.focused.value.key })
              .catch(() => {})
          "
        >
          复制完整 Key
        </button>
        <button :disabled="!model.app.value.native" @click="$emit('versions')">
          查看此 Key 的版本
        </button>
      </div>
      <div class="tag-actions">
        <button
          v-for="action in [
            { kind: 'copy', label: '复制对象' },
            { kind: 'rename', label: '重命名对象' },
            { kind: 'metadata', label: '编辑元数据' },
          ]"
          :key="action.kind"
          :disabled="
            !model.app.value.native || model.connection.value?.readOnly
          "
          @click="$emit('mutation', action.kind)"
        >
          {{ action.label }}
        </button>
      </div>
      <dl v-if="model.detail.value">
        <dt>大小</dt>
        <dd>
          {{ formatFileSize(model.detail.value.size) }}
          <span v-if="model.detail.value.size >= 1024" class="exact-size muted">
            {{ formatExactBytes(model.detail.value.size) }}
          </span>
        </dd>
        <dt>修改时间</dt>
        <dd>{{ formatDateTime(model.detail.value.lastModified) }}</dd>
        <dt>Content-Type</dt>
        <dd>{{ model.detail.value.contentType }}</dd>
        <dt>ETag（仅展示）</dt>
        <dd>{{ model.detail.value.etag || "--" }}</dd>
        <dt>版本</dt>
        <dd>{{ model.detail.value.versionId || "--" }}</dd>
        <dt>Metadata</dt>
        <dd>
          <pre>{{ JSON.stringify(model.detail.value.metadata, null, 2) }}</pre>
        </dd>
      </dl>
      <ObjectTags
        :editor="model.objectTags"
        :provider="model.connection.value?.provider"
        :read-only="model.connection.value?.readOnly"
        :native="model.app.value.native" />
      <div class="detail-preview-actions">
        <button @click="model.loadPreview">安全预览</button
        ><button @click="$emit('share')">分享</button>
        <HelpHint label="安全预览说明">
          文本 / JSON ≤2 MiB；位图 ≤8 MiB；不渲染 HTML / SVG。ETag
          与大小不代表内容校验。
        </HelpHint>
      </div>
      <pre class="preview" v-if="model.preview.value?.kind === 'text'">{{
        model.preview.value.content
      }}</pre>
      <img
        v-if="model.preview.value?.kind === 'image'"
        :src="model.preview.value.content"
        alt="对象预览"
    /></template>
    <p class="muted" v-else>选择对象查看只读属性。</p>
  </aside>
</template>
