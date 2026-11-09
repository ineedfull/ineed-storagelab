<script setup>
import { computed } from "vue";
import { getProvider } from "../domain/providers.js";
import HelpHint from "./HelpHint.vue";
const props = defineProps({
  editor: Object,
  readOnly: Boolean,
  native: Boolean,
  provider: String,
});
const capability = computed(() => getProvider(props.provider ?? "s3"));
</script>
<template>
  <section class="object-tags" aria-label="对象标签">
    <div class="section-heading">
      <h3>对象标签</h3>
      <HelpHint
        v-if="capability.tags !== 'unsupported'"
        label="对象标签填写规则"
      >
        标签与 Metadata 独立。最多10项，Key 1–128、Value 0–256个 UTF-16
        单元；Key 唯一。支持字母、数字、空格和 _ . : / = + @ -，aws:
        前缀保留；服务可能有额外限制。
      </HelpHint>
    </div>
    <p class="muted" v-if="capability.tags === 'unsupported'">
      {{ capability.name }}的S3接入不支持对象标签，请使用提供商支持的管理方式。
    </p>
    <template v-else>
      <button :disabled="editor.busy.value || !native" @click="editor.load">
        {{
          editor.loaded.value
            ? editor.dirty.value
              ? "重新读取（丢弃草稿）"
              : "重新读取标签"
            : "读取标签"
        }}
      </button>
      <p v-if="editor.busy.value" class="muted">正在处理标签…</p>
      <p v-if="editor.error.value" class="error" role="alert">
        {{ editor.error.value }}
      </p>
      <p v-if="editor.notice.value" role="status">{{ editor.notice.value }}</p>
      <template v-if="editor.loaded.value">
        <p class="raw-key muted">
          编辑目标：{{ editor.versionId.value ?? "当前对象（未绑定版本）" }}
        </p>
        <p v-if="readOnly" class="muted">只读连接：仅查看标签。</p>
        <p v-if="!editor.draft.value.length" class="muted">当前无标签</p>
        <fieldset
          :disabled="editor.busy.value || readOnly || !native"
          class="tag-fields"
        >
          <div
            v-for="(tag, index) in editor.draft.value"
            :key="index"
            class="tag-row"
          >
            <label
              >Key<input
                :aria-label="`标签${index + 1} Key`"
                v-model="tag.key"
                maxlength="128"
            /></label>
            <label
              >Value<input
                :aria-label="`标签${index + 1} Value`"
                v-model="tag.value"
                maxlength="256"
            /></label>
            <button
              :aria-label="`移除标签${index + 1}`"
              @click="editor.draft.value.splice(index, 1)"
            >
              移除
            </button>
          </div>
          <div class="tag-actions">
            <button
              :disabled="editor.draft.value.length >= 10"
              @click="editor.draft.value.push({ key: '', value: '' })"
            >
              添加标签
            </button>
            <button :disabled="!editor.dirty.value" @click="editor.revert">
              撤销编辑
            </button>
            <button
              class="primary"
              :disabled="!editor.dirty.value"
              @click="editor.save"
            >
              保存标签
            </button>
          </div>
        </fieldset>
        <p class="muted">
          保存会替换整组标签，移除全部后保存即清空。切换对象会丢弃未保存草稿；原生确认中会再次说明目标和并发限制。
        </p>
      </template>
    </template>
  </section>
</template>
