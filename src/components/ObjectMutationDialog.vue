<script setup>
import { onBeforeUnmount, onMounted } from "vue";
import AppDialog from "./AppDialog.vue";
import HelpHint from "./HelpHint.vue";
import { createObjectMutation } from "../composables/useObjectMutation.js";
const props = defineProps({ context: Object, invoke: Function });
const emit = defineEmits(["close", "changed"]);
const titles = {
  copy: "复制对象",
  rename: "重命名对象",
  metadata: "编辑元数据",
};
const actions = {
  copy: "确认复制",
  rename: "确认重命名",
  metadata: "保存元数据",
};
const m = createObjectMutation(
  { invoke: props.invoke },
  { ...props.context },
  (p) => emit("changed", p),
);
onMounted(m.load);
onBeforeUnmount(m.dispose);
</script>
<template>
  <AppDialog
    :title="titles[context.kind]"
    panel="mutation"
    :busy="m.working.value"
    @close="!m.working.value && $emit('close')"
  >
    <div class="dialog-body dialog-content">
      <p class="raw-key muted">
        {{ context.connectionName }} / {{ context.bucket }}
      </p>
      <label class="mutation-source"
        >源完整 Key<textarea readonly :value="context.key" rows="2" />
      </label>
      <p v-if="m.loading.value" class="muted">正在读取对象属性…</p>
      <p v-if="m.error.value" class="error" role="alert">{{ m.error.value }}</p>
      <p v-if="m.notice.value" role="status" class="raw-key">
        {{ m.notice.value }}
      </p>
      <button :disabled="m.loading.value || m.working.value" @click="m.load">
        重新读取属性
      </button>
      <form id="object-mutation" @submit.prevent="m.save">
        <fieldset
          :disabled="
            !m.source.value ||
            m.working.value ||
            m.finished.value ||
            context.readOnly
          "
          class="mutation-fields"
        >
          <template v-if="context.kind !== 'metadata'">
            <label
              >目标完整 Key<textarea
                v-model="m.targetKey.value"
                rows="3"
                maxlength="1024"
              />
            </label>
            <label class="check"
              ><input
                type="checkbox"
                v-model="m.overwrite.value"
              />明确允许覆盖目标同名对象</label
            >
            <p
              v-if="
                m.source.value && !m.source.value.capabilities?.conditionalCopy
              "
              class="muted"
            >
              此接入尚未验证目标条件复制；需要明确允许覆盖。存在检查不能保证原子不覆盖。
            </p>
            <p v-if="context.kind === 'rename'" class="muted">
              重命名分为复制与删除两个阶段。源发生变化或删除失败时保留两份，并显示部分完成；未知条件删除能力的接入只复制并保留源。操作不具备事务保证，同
              ETag 的并发更新仍存在竞争窗口。
            </p>
          </template>
          <template v-else>
            <div class="form-grid">
              <label
                >Content-Type<input
                  v-model="m.contentType.value"
                  maxlength="1024"
              /></label>
              <label
                >Cache-Control<input
                  v-model="m.cacheControl.value"
                  maxlength="1024"
              /></label>
            </div>
            <div class="section-heading">
              <h3>自定义 Metadata</h3>
              <HelpHint label="Metadata 填写规则">
                填写 ASCII 键和值，总大小不超过 2 KiB；键不区分大小写。
              </HelpHint>
            </div>
            <p class="muted">保存会替换整组 Metadata，正文不变。</p>
            <div class="mutation-row" v-for="(row, i) in m.rows.value" :key="i">
              <label
                >键<input
                  :aria-label="`元数据键 ${i + 1}`"
                  v-model="row.key"
                  maxlength="256"
              /></label>
              <label
                >值<input
                  :aria-label="`元数据值 ${i + 1}`"
                  v-model="row.value"
                  maxlength="2048"
              /></label>
              <button
                type="button"
                :aria-label="`删除元数据 ${i + 1}`"
                @click="m.rows.value.splice(i, 1)"
              >
                删除
              </button>
            </div>
            <button
              type="button"
              :disabled="m.rows.value.length >= 50"
              @click="m.rows.value.push({ key: '', value: '' })"
            >
              添加元数据
            </button>
          </template>
        </fieldset>
      </form>
      <p class="muted">
        单对象不超过 5 GiB。原生窗口将再次确认；新对象的
        ACL、加密与保留规则采用桶默认配置，原有版本按服务规则保留。失败或超时后请先刷新核实，再决定是否重试。
      </p>
      <p v-if="context.readOnly" class="muted">此连接为只读，不能修改对象。</p>
      <p v-if="m.working.value" class="muted">
        正在处理，请完成原生确认后再关闭。
      </p>
    </div>
    <template #footer>
      <button type="button" :disabled="m.working.value" @click="$emit('close')">
        {{ m.finished.value ? "关闭" : "取消" }}
      </button>
      <button
        type="submit"
        form="object-mutation"
        class="primary"
        :disabled="
          !m.source.value ||
          m.loading.value ||
          m.working.value ||
          m.finished.value ||
          context.readOnly
        "
      >
        {{ m.working.value ? "正在处理…" : actions[context.kind] }}
      </button>
    </template>
  </AppDialog>
</template>
