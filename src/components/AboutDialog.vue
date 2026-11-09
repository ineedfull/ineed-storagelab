<script setup>
import { ref } from "vue";
import AppDialog from "./AppDialog.vue";
const props = defineProps({ model: Object });
const emit = defineEmits(["close"]);
const error = ref("");
async function openWebsite() {
  error.value = "";
  try {
    await props.model.action("openWebsite");
  } catch (reason) {
    error.value = reason.message;
  }
}
</script>
<template>
  <AppDialog title="关于 StorageLab" panel="about" @close="emit('close')">
    <div
      class="dialog-body about-body"
      tabindex="0"
      role="region"
      aria-label="产品信息"
    >
      <div class="about-identity">
        <img :src="'./icon.svg'" alt="" width="64" height="64" />
        <div><strong>StorageLab</strong><span>对象存储工具箱</span></div>
      </div>
      <dl class="about-details">
        <div>
          <dt>版本</dt>
          <dd>{{ model.app.value.version }}</dd>
        </div>
        <div>
          <dt>运行环境</dt>
          <dd>{{ model.app.value.runtime }}</dd>
        </div>
        <div>
          <dt>本地存储</dt>
          <dd>SQLite 独立工作区</dd>
        </div>
        <div>
          <dt>独立数据目录</dt>
          <dd>{{ model.app.value.dataDirectory }}</dd>
        </div>
        <div>
          <dt>官方网站</dt>
          <dd>
            <button
              class="website-link"
              :disabled="!model.app.value.native"
              @click="openWebsite"
            >
              访问官网 https://www.ineedfull.com
            </button>
          </dd>
        </div>
      </dl>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p class="about-note">
        连接对象存储、管理对象与传输任务。<br />Electron 使用独立 Chromium /
        Node 进程，内存占用相对较大。浏览器仅供外观预览。
      </p>
      <small class="muted">版权所有 © 2026 Ineed · 因需而生</small>
    </div>
    <template #footer
      ><button type="button" @click="emit('close')">关闭</button></template
    >
  </AppDialog>
</template>
