<script setup>
import { reactive, ref, computed, watch } from "vue";
import AppDialog from "./AppDialog.vue";
import HelpHint from "./HelpHint.vue";
import {
  validateConnection,
  validateCredentials,
} from "../domain/connection.js";
import {
  getSelectableProviders,
  getProvider,
  buildProviderConfig,
  migrateLegacyConnection,
} from "../domain/providers.js";
const props = defineProps({
  connection: Object,
  vaultAvailable: Boolean,
  invoke: Function,
});
const emit = defineEmits(["close", "saved"]);
const draft = reactive({
  ...{
    name: "",
    group: "",
    provider: "minio",
    endpoint: "http://127.0.0.1:9000",
    region: "",
    defaultBucket: "",
    publicBaseUrl: "",
    forcePathStyle: true,
    readOnly: false,
  },
  ...props.connection,
});
const credentials = reactive({
  accessKeyId: "",
  secretAccessKey: "",
  sessionToken: "",
});
const storage = ref(
  props.connection?.credentialStorage ??
    (props.vaultAvailable ? "encrypted" : "session"),
);
const error = ref(""),
  busy = ref(false);
const selectableProviders = computed(() =>
  getSelectableProviders(props.connection?.provider),
);
const provider = computed(() => getProvider(draft.provider));
const isNative = computed(() =>
  ["oss", "obs", "cos-native", "tos-native"].includes(draft.provider),
);
const regionLabel = computed(() => (isNative.value ? "区域" : "签名区域"));
const migrationNotice = ref("");
const migrationName = computed(
  () => ({ aliyun: "OSS", cos: "COS", tos: "TOS" })[draft.provider],
);
function migrateLegacy() {
  const result = migrateLegacyConnection(draft);
  Object.assign(draft, result.connection);
  migrationNotice.value = result.notice;
}
const location = ref(
  draft.provider === "r2"
    ? "auto"
    : draft.provider === "spaces"
      ? new URL(draft.endpoint).hostname.split(".")[0]
      : draft.region || provider.value.location,
);
const accountId = ref(
  draft.endpoint.match(
    /^https:\/\/([a-f0-9]{32})\.r2\.cloudflarestorage\.com/i,
  )?.[1] ?? "",
);
const presetError = ref(""),
  presetNotice = ref("");
watch(
  () => draft.provider,
  () => {
    location.value = provider.value.location;
    if (["obs", "cos-native"].includes(draft.provider))
      draft.forcePathStyle = false;
    if (!["oss", "cos-native", "tos-native"].includes(draft.provider))
      migrationNotice.value = "";
    accountId.value = "";
    presetError.value = "";
    presetNotice.value = "";
  },
);
function applyProvider() {
  presetError.value = "";
  presetNotice.value = "";
  try {
    Object.assign(
      draft,
      buildProviderConfig(draft.provider, {
        location: location.value,
        accountId: accountId.value,
      }),
    );
    presetNotice.value = `已应用 Endpoint、${regionLabel.value}和寻址方式，请核对后保存。`;
  } catch (e) {
    presetError.value = e.message;
  }
}
async function save() {
  if (busy.value) return;
  error.value = "";
  try {
    const connection = validateConnection(draft);
    const payload = { connection, credentialStorage: storage.value };
    if (!connection.id || Object.values(credentials).some(Boolean))
      payload.credentials = validateCredentials(credentials);
    busy.value = true;
    const saved = await props.invoke("saveConnection", payload);
    emit("saved", saved);
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <AppDialog
    :title="connection ? '编辑连接' : '新建连接'"
    panel="connection"
    :busy="busy"
    @close="!busy && $emit('close')"
  >
    <form
      id="storage-connection"
      class="dialog-body connection-body"
      @submit.prevent="save"
    >
      <fieldset :disabled="busy">
        <section
          class="connection-section"
          aria-labelledby="connection-identity-title"
        >
          <h3 id="connection-identity-title">连接信息</h3>
          <div class="form-grid">
            <div class="connection-field">
              <label for="connection-name">名称</label>
              <input
                id="connection-name"
                v-model="draft.name"
                required
                maxlength="100"
                placeholder="例如：办公室 MinIO"
                aria-describedby="connection-name-hint"
              />
              <p id="connection-name-hint" class="muted">
                必填，仅用于本地识别连接。
              </p>
            </div>
            <div class="connection-field">
              <label for="connection-group">分组</label>
              <input
                id="connection-group"
                v-model="draft.group"
                maxlength="100"
                placeholder="例如：开发环境"
                aria-describedby="connection-group-hint"
              />
              <p id="connection-group-hint" class="muted">
                可选，用于侧栏归类，不影响远端存储。
              </p>
            </div>
            <div class="connection-field wide">
              <div class="field-label">
                <label for="connection-provider">提供商</label>
                <HelpHint id="connection-provider-hint" label="提供商选择说明">
                  已列厂商优先选对应项；通用 S3
                  可手动接入。切换选项会保留已有地址和区域；OBS/COS原生只支持虚拟主机寻址。
                </HelpHint>
              </div>
              <select
                id="connection-provider"
                v-model="draft.provider"
                aria-describedby="connection-provider-hint"
              >
                <option
                  v-for="p in selectableProviders"
                  :key="p.id"
                  :value="p.id"
                  :disabled="['aliyun', 'cos', 'tos'].includes(p.id)"
                >
                  {{ p.name
                  }}{{
                    ["aliyun", "cos", "tos"].includes(p.id)
                      ? "（当前旧版连接）"
                      : ""
                  }}
                </option>
              </select>
              <button
                v-if="connection?.provider === draft.provider && migrationName"
                type="button"
                @click="migrateLegacy"
              >
                迁移为原生 {{ migrationName }}
              </button>
              <p v-if="migrationNotice" role="status" class="muted">
                {{ migrationNotice }}
              </p>
            </div>
          </div>
        </section>
        <section
          class="connection-section"
          aria-labelledby="connection-service-title"
        >
          <div class="section-heading">
            <h3 id="connection-service-title">服务配置</h3>
            <HelpHint label="提供商接入说明">{{ provider.hint }}</HelpHint>
          </div>
          <div class="form-grid">
            <section
              v-if="!['minio', 's3'].includes(draft.provider)"
              class="wide provider-config"
              aria-label="提供商配置"
            >
              <template v-if="!['minio', 's3'].includes(draft.provider)">
                <div class="form-grid">
                  <div class="connection-field">
                    <label for="connection-location">服务地域</label>
                    <input
                      id="connection-location"
                      v-model="location"
                      :disabled="busy || draft.provider === 'r2'"
                      :placeholder="provider.location"
                      aria-describedby="connection-location-hint"
                    />
                    <p id="connection-location-hint" class="muted">
                      {{
                        draft.provider === "spaces"
                          ? "桶所在机房，例如 nyc3；签名区域使用 us-east-1。"
                          : draft.provider === "r2"
                            ? "R2 使用 auto；特殊辖区请手动填写 Endpoint。"
                            : "填写桶所在地域的代码，可从提供商控制台查看。"
                      }}
                    </p>
                  </div>
                  <div v-if="draft.provider === 'r2'" class="connection-field">
                    <label for="connection-account">Account ID</label>
                    <input
                      id="connection-account"
                      v-model="accountId"
                      maxlength="32"
                      autocomplete="off"
                      placeholder="32 位账户 ID"
                      aria-describedby="connection-account-hint"
                    />
                    <p id="connection-account-hint" class="muted">
                      来自 Cloudflare 控制台，不是 Access Key。
                    </p>
                  </div>
                </div>
                <button type="button" @click="applyProvider">
                  应用提供商配置
                </button>
                <p class="muted">
                  点击后填入 Endpoint、{{
                    regionLabel
                  }}和寻址方式，仍可手动调整。
                </p>
                <p v-if="presetError" class="error" role="alert">
                  {{ presetError }}
                </p>
                <p v-if="presetNotice" role="status">{{ presetNotice }}</p>
              </template>
            </section>
            <div class="connection-field wide">
              <div class="field-label">
                <label for="connection-endpoint">Endpoint</label>
                <HelpHint
                  id="connection-endpoint-hint"
                  label="Endpoint 填写说明"
                >
                  必填，完整存储 API 服务地址，包含 http:// 或
                  https://；桶名单独填写。
                </HelpHint>
              </div>
              <input
                id="connection-endpoint"
                v-model="draft.endpoint"
                required
                maxlength="4096"
                spellcheck="false"
                placeholder="例如：https://s3.example.com"
                aria-describedby="connection-endpoint-hint"
              />
            </div>
            <div class="connection-field">
              <div class="field-label">
                <label for="connection-region">{{ regionLabel }}</label>
                <HelpHint
                  id="connection-region-hint"
                  :label="`${regionLabel}填写说明`"
                >
                  {{
                    isNative
                      ? "必填，使用桶所在地域代码，与原生服务Endpoint对应。"
                      : "必填，用于请求签名，按服务端配置填写；MinIO 常用 us-east-1。"
                  }}
                </HelpHint>
              </div>
              <input
                id="connection-region"
                v-model="draft.region"
                required
                maxlength="100"
                :placeholder="isNative ? '填写桶所在地域' : '按服务端配置填写'"
                aria-describedby="connection-region-hint"
              />
            </div>
            <div class="connection-field">
              <label for="connection-bucket">默认桶</label>
              <input
                id="connection-bucket"
                v-model="draft.defaultBucket"
                maxlength="255"
                placeholder="例如：my-bucket"
                aria-describedby="connection-bucket-hint"
              />
              <p id="connection-bucket-hint" class="muted">
                可选，选中连接时打开此桶；无列桶权限时建议填写。
              </p>
            </div>
            <div class="connection-field wide">
              <label class="check" for="connection-path-style"
                ><input
                  id="connection-path-style"
                  type="checkbox"
                  v-model="draft.forcePathStyle"
                  :disabled="['obs', 'cos-native'].includes(draft.provider)"
                  aria-describedby="connection-path-style-hint"
                />Path style 寻址</label
              >
              <p id="connection-path-style-hint" class="muted">
                {{
                  draft.provider === "obs"
                    ? "OBS原生仅支持虚拟主机寻址，不支持Path style。"
                    : draft.provider === "cos-native"
                      ? "COS原生仅支持虚拟主机寻址，不支持Path style。"
                      : "勾选时桶名放在路径中；取消后放在域名前。按服务要求选择，MinIO通常勾选。"
                }}
              </p>
            </div>
          </div>
        </section>
        <section
          class="connection-section"
          aria-labelledby="connection-credentials-title"
        >
          <h3 id="connection-credentials-title">访问凭证</h3>
          <div class="form-grid">
            <p class="wide muted">{{ provider.credentialHint }}</p>
            <p class="wide muted" v-if="connection">
              留空保留现有凭证；更换时需同时填写 Access Key 和 Secret
              Key，临时凭证还需填写 Session Token。
            </p>
            <p
              class="wide muted"
              v-if="connection && draft.endpoint !== connection.endpoint"
            >
              已修改访问地址。凭证留空时仍使用原凭证，请确认新地址可信；换账号时填写新凭证。
            </p>
            <div class="connection-field">
              <label for="connection-access-key">Access Key</label>
              <input
                id="connection-access-key"
                v-model="credentials.accessKeyId"
                maxlength="4096"
                autocomplete="off"
                spellcheck="false"
                :placeholder="
                  connection
                    ? '留空保留；更换时填写新 Access Key'
                    : '填写 Access Key ID'
                "
              />
            </div>
            <div class="connection-field">
              <label for="connection-secret-key">Secret Key</label>
              <input
                id="connection-secret-key"
                v-model="credentials.secretAccessKey"
                type="password"
                maxlength="4096"
                autocomplete="new-password"
                :placeholder="
                  connection
                    ? '留空保留；更换时填写新 Secret Key'
                    : '填写 Secret Access Key'
                "
              />
            </div>
            <div class="connection-field wide">
              <div class="field-label">
                <label for="connection-token">Session Token</label>
                <HelpHint
                  id="connection-token-hint"
                  label="Session Token 填写说明"
                >
                  普通 Access Key / Secret Key 留空；STS 等临时凭证填写对应
                  Token。
                </HelpHint>
              </div>
              <input
                id="connection-token"
                v-model="credentials.sessionToken"
                type="password"
                maxlength="16384"
                autocomplete="off"
                placeholder="可选，仅临时凭证需要"
                aria-describedby="connection-token-hint"
              />
            </div>
            <div class="connection-field wide">
              <label for="connection-storage">凭证保存</label>
              <select
                id="connection-storage"
                v-model="storage"
                aria-describedby="connection-storage-hint"
              >
                <option :disabled="!vaultAvailable" value="encrypted">
                  系统安全加密
                </option>
                <option value="session">仅本会话（退出失效）</option>
              </select>
              <p id="connection-storage-hint" class="muted">
                {{
                  vaultAvailable
                    ? "系统安全加密可供下次启动使用；仅本会话在退出后需要重新填写。"
                    : "系统安全存储不可用，仅本会话模式在退出后需要重新填写。"
                }}
              </p>
            </div>
          </div>
        </section>
        <section
          class="connection-section"
          aria-labelledby="connection-options-title"
        >
          <h3 id="connection-options-title">其他选项</h3>
          <div class="form-grid">
            <div class="connection-field wide">
              <label class="check" for="connection-read-only"
                ><input
                  id="connection-read-only"
                  type="checkbox"
                  v-model="draft.readOnly"
                  aria-describedby="connection-read-only-hint"
                />只读连接</label
              >
              <p id="connection-read-only-hint" class="muted">
                在本工具中禁止写入和删除操作；服务端权限仍由账号策略控制。
              </p>
            </div>
            <div class="connection-field wide">
              <div class="field-label">
                <label for="connection-public-url">公开 Base URL</label>
                <HelpHint
                  id="connection-public-url-hint"
                  label="公开 Base URL 填写说明"
                >
                  生成公开分享链接时使用的桶访问根地址，与服务 Endpoint
                  独立；不需要公开分享时留空。
                </HelpHint>
              </div>
              <input
                id="connection-public-url"
                v-model="draft.publicBaseUrl"
                maxlength="4096"
                spellcheck="false"
                placeholder="可选，例如：https://files.example.com"
                aria-describedby="connection-public-url-hint"
              />
            </div>
          </div>
        </section>
      </fieldset>
    </form>
    <template #footer>
      <p role="alert" v-if="error" class="error connection-save-error">
        {{ error }}
      </p>
      <button type="button" @click="$emit('close')" :disabled="busy">
        取消
      </button>
      <button
        type="submit"
        form="storage-connection"
        class="primary"
        :disabled="busy"
      >
        {{ busy ? "正在保存…" : "保存连接" }}
      </button>
    </template>
  </AppDialog>
</template>
