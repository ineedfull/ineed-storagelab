<script setup>
import { reactive, ref } from "vue";
import AppDialog from "./AppDialog.vue";
const props = defineProps({ model: Object });
const emit = defineEmits(["close"]);
const original = { ...props.model.settings.value };
const draft = reactive({ ...original }),
  error = ref(""),
  busy = ref(false);
function preview() {
  props.model.settings.value = { ...draft };
}
function cancel() {
  if (busy.value) return;
  props.model.settings.value = { ...original };
  emit("close");
}
async function save() {
  if (busy.value) return;
  busy.value = true;
  try {
    props.model.settings.value = await props.model.action("saveSettings", {
      ...draft,
    });
    emit("close");
  } catch (e) {
    props.model.settings.value = { ...original };
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <AppDialog title="设置" panel="settings" :busy="busy" @close="cancel">
    <form
      id="storage-settings"
      class="dialog-body settings-body"
      @submit.prevent="save"
    >
      <fieldset :disabled="busy">
        <section class="settings-section">
          <h3>显示设置</h3>
          <div class="setting-row">
            <div>
              <label for="setting-theme">主题</label>
              <p class="muted">选择浅色、深色或跟随系统。</p>
            </div>
            <select id="setting-theme" v-model="draft.theme" @change="preview">
              <option value="system">跟随系统</option>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </div>
          <div class="setting-row">
            <div>
              <label for="setting-large">大字模式</label>
              <p class="muted">同步放大正文、控件、表格和代码。</p>
            </div>
            <input
              id="setting-large"
              class="toggle"
              type="checkbox"
              v-model="draft.largeText"
              @change="preview"
            />
          </div>
        </section>
        <section class="settings-section">
          <h3>传输设置</h3>
          <div class="setting-row">
            <div>
              <label for="setting-concurrency">整体并发</label>
              <p class="muted">同时执行的传输任务数量，范围 1–4。</p>
            </div>
            <input
              id="setting-concurrency"
              v-model.number="draft.concurrency"
              type="number"
              min="1"
              max="4"
              required
            />
          </div>
          <div class="setting-row">
            <div>
              <label for="setting-timeout">请求超时（秒）</label>
              <p class="muted">单次请求的等待上限，范围 5–120 秒。</p>
            </div>
            <input
              id="setting-timeout"
              v-model.number="draft.timeoutSeconds"
              type="number"
              min="5"
              max="120"
              required
            />
          </div>
        </section>
      </fieldset>
      <p class="muted">
        主题与字号为草稿预览。取消或保存失败还原原设置，传输与选中对象继续保留。
      </p>
      <p role="alert" class="error" v-if="error">{{ error }}</p>
    </form>
    <template #footer>
      <button type="button" @click="cancel" :disabled="busy">取消</button>
      <button
        type="submit"
        form="storage-settings"
        class="primary"
        :disabled="busy || !model.app.value.native"
      >
        {{ busy ? "正在保存…" : "保存设置" }}
      </button>
    </template>
  </AppDialog>
</template>
