<script setup>
import { ref, watch, watchEffect, nextTick } from "vue";
import {
  Settings,
  CircleHelp,
  Database,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Pencil,
  ShieldCheck,
  Trash2,
  FolderOpen,
  ListTodo,
} from "lucide-vue-next";
import { useWorkbench } from "../composables/useWorkbench.js";
import ConnectionDialog from "./ConnectionDialog.vue";
import AppDialog from "./AppDialog.vue";
import SettingsDialog from "./SettingsDialog.vue";
import AboutDialog from "./AboutDialog.vue";
import ObjectBrowser from "./ObjectBrowser.vue";
import ObjectDetails from "./ObjectDetails.vue";
import TaskCenter from "./TaskCenter.vue";
import ObjectVersionsDialog from "./ObjectVersionsDialog.vue";
import ObjectMutationDialog from "./ObjectMutationDialog.vue";
import FeedbackBanner from "./FeedbackBanner.vue";
import HelpHint from "./HelpHint.vue";
import DirectoryDelivery from "./DirectoryDelivery.vue";
import { bridge } from "../runtime/bridge.js";
const m = useWorkbench(),
  modal = ref(""),
  editing = ref(),
  tab = ref("objects"),
  showDetails = ref(globalThis.innerWidth > 1100),
  shareKind = ref("signed"),
  expires = ref(900),
  share = ref(null),
  shareError = ref(""),
  shareBusy = ref(false),
  removeBusy = ref(false),
  removeError = ref("");
let shareVersion = 0;
const versionContext = ref();
const mutationContext = ref();
const objectBrowser = ref();
watch(m.focused, (object) => {
  if (object) showDetails.value = true;
});
let mutationChanged;
async function closeMutation() {
  modal.value = "";
  if (mutationChanged) {
    const p = mutationChanged;
    mutationChanged = undefined;
    if (
      m.connectionId.value === p.connectionId &&
      m.bucket.value === p.bucket
    ) {
      await m.browse();
      await nextTick();
      objectBrowser.value?.focusRefresh();
    }
  }
}
function openMutation(kind) {
  mutationChanged = undefined;
  mutationContext.value = {
    ...m.payload(),
    key: m.focused.value.key,
    kind,
    provider: m.connection.value.provider,
    connectionName: m.connection.value.name,
    readOnly: m.connection.value.readOnly,
  };
  modal.value = "mutation";
}
function openVersions(key = "") {
  versionContext.value = {
    ...m.payload(),
    key,
    provider: m.connection.value.provider,
    connectionName: m.connection.value.name,
    readOnly: m.connection.value.readOnly,
  };
  modal.value = "versions";
}
function restored(p) {
  if (m.connectionId.value === p.connectionId && m.bucket.value === p.bucket)
    m.browse();
}
function closeShare() {
  shareVersion++;
  modal.value = "";
  share.value = null;
  shareBusy.value = false;
}
watch(
  [m.connectionId, m.bucket, m.prefix, m.focused],
  () => {
    if (modal.value === "share") closeShare();
  },
  { flush: "sync" },
);
watchEffect(() => {
  document.documentElement.dataset.theme = m.settings.value.theme;
  document.documentElement.dataset.large = String(m.settings.value.largeText);
});
function openConnection(c) {
  editing.value = c;
  modal.value = "connection";
}
async function saved(c) {
  const i = m.connections.value.findIndex((x) => x.id === c.id);
  if (i < 0) m.connections.value.push(c);
  else m.connections.value[i] = c;
  modal.value = "";
  await m.selectConnection(c.id);
}
async function collapse() {
  const value = {
    ...m.settings.value,
    sidebarCollapsed: !m.settings.value.sidebarCollapsed,
  };
  try {
    m.settings.value = m.app.value.native
      ? await m.action("saveSettings", value)
      : value;
  } catch {}
}
async function checkConnection() {
  try {
    const result = await m.action("checkConnection", {
      connectionId: m.connectionId.value,
      ...(m.bucket.value ? { bucket: m.bucket.value } : {}),
    });
    m.notify(result.message);
  } catch {}
}
async function remove() {
  if (removeBusy.value) return;
  removeBusy.value = true;
  removeError.value = "";
  try {
    await m.removeConnection();
    modal.value = "";
  } catch (e) {
    removeError.value = e.message;
  } finally {
    removeBusy.value = false;
  }
}
async function deletion() {
  try {
    const result = await m.action("deleteObjects", {
      ...m.payload(),
      keys: [...m.selected.value],
    });
    m.notify(
      result.cancelled
        ? "已取消删除"
        : `删除 ${result.deleted.length} 项，失败 ${result.errors.length} 项；版本状态 ${result.versioning}`,
      result.errors.length ? "warning" : "success",
    );
    if (result.errors.length)
      m.error.value = result.errors
        .map((x) => `${x.key}: ${x.code} ${x.message}`)
        .join("\n");
    await m.browse();
  } catch {}
}
function openShare() {
  share.value = null;
  shareError.value = "";
  modal.value = "share";
}
async function generate() {
  if (shareBusy.value) return;
  shareBusy.value = true;
  shareError.value = "";
  const version = ++shareVersion;
  share.value = null;
  try {
    const result = await m.action("shareObject", {
      ...m.payload(),
      key: m.focused.value.key,
      expiresIn: Number(expires.value),
      kind: shareKind.value,
    });
    if (version === shareVersion && modal.value === "share")
      share.value = result;
  } catch (e) {
    if (version === shareVersion) shareError.value = e.message;
  } finally {
    if (version === shareVersion) shareBusy.value = false;
  }
}
</script>
<template>
  <div
    class="workbench"
    :class="{ collapsed: m.settings.value.sidebarCollapsed }"
  >
    <aside class="sidebar" aria-label="StorageLab 导航">
      <header class="brand">
        <div class="brand-identity">
          <img
            class="brand-icon"
            :src="'./icon-small.svg'"
            :alt="m.settings.value.sidebarCollapsed ? 'StorageLab' : ''"
          />
          <strong v-if="!m.settings.value.sidebarCollapsed">StorageLab</strong>
        </div>
        <button
          class="icon-button"
          :aria-label="
            m.settings.value.sidebarCollapsed ? '展开侧栏' : '折叠侧栏'
          "
          :title="m.settings.value.sidebarCollapsed ? '展开侧栏' : '折叠侧栏'"
          :aria-expanded="!m.settings.value.sidebarCollapsed"
          @click="collapse"
        >
          <component
            :is="
              m.settings.value.sidebarCollapsed ? PanelLeftOpen : PanelLeftClose
            "
          />
        </button>
      </header>
      <div class="sidebar-content">
        <div class="resource-heading">
          <span v-if="!m.settings.value.sidebarCollapsed">连接</span>
          <button
            class="icon-button new-connection"
            aria-label="新建连接"
            title="新建连接"
            :disabled="!m.app.value.native"
            @click="openConnection()"
          >
            <Plus :size="16" />
          </button>
        </div>
        <nav aria-label="连接">
          <template v-for="(c, i) in m.connections.value" :key="c.id"
            ><p
              class="group"
              v-if="
                !m.settings.value.sidebarCollapsed &&
                (i === 0 || c.group !== m.connections.value[i - 1].group)
              "
            >
              {{ c.group || "未分组" }}
            </p>
            <button
              :title="c.name"
              :aria-label="c.name"
              :class="{ active: m.connectionId.value === c.id }"
              @click="m.selectConnection(c.id)"
            >
              <Database /><span v-if="!m.settings.value.sidebarCollapsed">{{
                c.name
              }}</span>
            </button></template
          >
        </nav>
        <div
          v-if="m.connectionId.value && !m.settings.value.sidebarCollapsed"
          class="bucket-list"
        >
          <h3>桶</h3>
          <button
            v-for="b in m.buckets.value"
            :key="b.name"
            :class="{ active: b.name === m.bucket.value }"
            :aria-current="b.name === m.bucket.value ? 'true' : undefined"
            :title="b.name"
            @click="m.openBucket(b.name)"
          >
            {{ b.name }}
          </button>
          <p class="muted">列桶受限时可手输已知桶。</p>
        </div>
      </div>
      <footer class="sidebar-bottom">
        <button
          class="icon-button"
          aria-label="设置"
          title="设置"
          @click="
            (event) => {
              event.currentTarget.focus();
              modal = 'settings';
            }
          "
        >
          <Settings /><span v-if="!m.settings.value.sidebarCollapsed"
            >设置</span
          >
        </button>
        <button
          class="icon-button"
          aria-label="关于"
          title="关于"
          @click="
            (event) => {
              event.currentTarget.focus();
              modal = 'about';
            }
          "
        >
          <CircleHelp /><span v-if="!m.settings.value.sidebarCollapsed"
            >关于</span
          >
        </button>
      </footer>
    </aside>
    <main class="main">
      <header class="topbar">
        <strong :title="m.connection.value?.name">{{
          m.connection.value?.name || "StorageLab 工作台"
        }}</strong>
        <div class="connection-actions" aria-label="连接操作">
          <button
            :disabled="!m.connectionId.value"
            @click="openConnection(m.connection.value)"
            aria-label="编辑连接"
          >
            <Pencil :size="15" />编辑连接</button
          ><button :disabled="!m.connectionId.value" @click="checkConnection">
            <ShieldCheck :size="15" />检查连接</button
          ><button
            :disabled="!m.connectionId.value"
            class="danger"
            @click="
              removeError = '';
              modal = 'remove';
            "
          >
            <Trash2 :size="15" />移除连接
          </button>
        </div>
        <span class="muted runtime-label">{{
          m.app.value.native
            ? "Electron 原生"
            : "浏览器仅供外观预览 · 原生操作已禁用"
        }}</span>
      </header>
      <div class="feedback-stack">
        <FeedbackBanner v-model="m.error.value" variant="error" />
        <FeedbackBanner
          v-model="m.notice.value"
          :revision="m.noticeRevision.value"
          :variant="m.noticeVariant.value"
        />
      </div>
      <div class="toolbar workspace-toolbar">
        <nav class="workspace-tabs" aria-label="工作台页面">
          <button
            :class="{ active: tab === 'objects' }"
            :aria-current="tab === 'objects' ? 'page' : undefined"
            @click="tab = 'objects'"
          >
            <FolderOpen :size="15" aria-hidden="true" />对象浏览</button
          ><button
            :class="{ active: tab === 'tasks' }"
            :aria-current="tab === 'tasks' ? 'page' : undefined"
            :aria-label="`任务中心 (${m.jobs.value.length})`"
            @click="tab = 'tasks'"
          >
            <ListTodo :size="15" aria-hidden="true" />任务中心
            <span class="workspace-tab-count" aria-hidden="true">{{
              m.jobs.value.length
            }}</span>
          </button>
        </nav>
        <div class="spacer" />

        <button :disabled="!m.app.value.native" @click="modal = 'directory'">
          <FolderOpen :size="16" />目录交付
        </button>
        <button
          v-if="tab === 'objects'"
          @click="showDetails = !showDetails"
          :aria-expanded="showDetails"
        >
          {{ showDetails ? "收起详情" : "展开详情" }}
        </button>
      </div>
      <div
        v-show="tab === 'objects'"
        class="object-layout"
        :class="{ 'no-details': !showDetails }"
      >
        <ObjectBrowser
          ref="objectBrowser"
          :model="m"
          @delete="deletion"
          @versions="openVersions()"
        /><ObjectDetails
          v-if="showDetails"
          :model="m"
          @share="openShare"
          @mutation="openMutation"
          @close="showDetails = false"
          @versions="openVersions(m.focused.value.key)"
        />
      </div>
      <TaskCenter
        v-show="tab === 'tasks'"
        :model="m"
        @browse="tab = 'objects'"
      />
    </main>
    <DirectoryDelivery
      v-if="modal === 'directory'"
      :context="{ ...m.payload(), prefix: m.prefix.value }"
      :read-only="m.connection.value?.readOnly"
      :invoke="bridge.invoke"
      @close="modal = ''"
    />
    <ConnectionDialog
      v-if="modal === 'connection'"
      :connection="editing"
      :vault-available="m.app.value.vaultAvailable"
      :invoke="m.action"
      @close="modal = ''"
      @saved="saved"
    /><ObjectVersionsDialog
      v-if="modal === 'versions'"
      :context="versionContext"
      :invoke="bridge.invoke"
      @close="modal = ''"
      @restored="restored"
    /><ObjectMutationDialog
      v-if="modal === 'mutation'"
      :context="mutationContext"
      :invoke="bridge.invoke"
      @close="closeMutation"
      @changed="mutationChanged = $event"
    /><SettingsDialog
      v-if="modal === 'settings'"
      :model="m"
      @close="modal = ''"
    /><AboutDialog
      v-if="modal === 'about'"
      :model="m"
      @close="modal = ''"
    /><AppDialog
      v-if="modal === 'remove'"
      title="移除连接"
      panel="confirm"
      :busy="removeBusy"
      @close="modal = ''"
    >
      <div class="dialog-body dialog-content">
        <p>
          移除
          {{
            m.connection.value?.name
          }}？不会删除远端对象；活动传输关联连接不能移除。
        </p>
        <p v-if="removeError" class="error" role="alert">{{ removeError }}</p>
      </div>
      <template #footer>
        <button type="button" :disabled="removeBusy" @click="modal = ''">
          取消
        </button>
        <button
          type="button"
          class="danger"
          :disabled="removeBusy"
          @click="remove"
        >
          {{ removeBusy ? "正在移除…" : "确认移除连接" }}
        </button>
      </template>
    </AppDialog>
    <AppDialog
      v-if="modal === 'share'"
      title="分享对象"
      panel="share"
      @close="closeShare()"
    >
      <form
        id="object-share"
        class="dialog-body share-content"
        @submit.prevent="generate"
      >
        <p class="raw-key">{{ m.focused.value?.key }}</p>
        <fieldset :disabled="shareBusy" class="plain-fieldset">
          <div class="form-grid">
            <label
              >链接类型<select v-model="shareKind">
                <option value="signed">预签名 GET</option>
                <option value="public">独立公开 Base URL</option>
              </select></label
            >
            <label
              >有效秒数<input
                type="number"
                min="60"
                max="604800"
                v-model="expires"
            /></label>
          </div>
        </fieldset>
        <div class="help-caption">
          <span class="muted">链接使用说明</span>
          <HelpHint label="分享链接说明">
            生成不代表可访问；临时凭证可能提前失效。链接仅保留于当前弹窗。
          </HelpHint>
        </div>
        <p role="alert" class="error" v-if="shareError">{{ shareError }}</p>
        <template v-if="share">
          <textarea
            aria-label="分享链接"
            readonly
            :value="share.url"
            rows="5"
          />
          <p class="muted">{{ share.warning }}</p>
        </template>
      </form>
      <template #footer>
        <button type="button" @click="closeShare()">关闭</button>
        <button
          v-if="share"
          type="button"
          @click="m.action('copyText', { text: share.url }).catch(() => {})"
        >
          复制链接
        </button>
        <button
          type="submit"
          form="object-share"
          class="primary"
          :disabled="shareBusy"
        >
          {{ shareBusy ? "正在生成…" : "生成链接" }}
        </button>
      </template>
    </AppDialog>
  </div>
</template>
