# StorageLab 全窗口一致性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 将主窗口及全部应用弹窗的导航、标题、滚动与操作位置统一到工具系列约定。

**Architecture:** AppDialog统一控制外壳和忙碌关闭行为，各业务组件提供dialog-body和footer slot。主窗口在连接上下文栏提供连接命令，保留页面切换和对象工具栏；继续共用现有领域状态及原生接口。

**Tech Stack:** Vue 3、Electron、lucide-vue-next、Playwright。

**Spec:** 用户明确要求“主窗口和连接弹窗都统一”“所有的窗口都需要保持一致”；工作区docs/TOOL-UI.md、产品docs/ui.md。

## Global Constraints

- 首版 Vue + Electron，应用 ID `com.ineedfull.storagelab`；保留现有未提交改动。
- 侧栏240/58px、顶栏48px、普通控件至少32px；弹窗标题48px、操作区至少56px，取消/关闭在前、主操作在后并靠右。
- 测试使用隔离目录、回环存储服务；不访问146发布桶，不自动发布。
- 不改变SDK、SQLite结构、真实连接和已有安装配置；只读、原生确认、凭证及上下文边界保持。
- 用户已授权直接实施；当前会话串行执行，不启动子代理，不因计划步骤重新请求确认或自动提交共享目录。

### Task 1: 统一所有弹窗外壳

**Files:** src/components/AppDialog.vue、ObjectMutationDialog.vue、ObjectVersionsDialog.vue、Workbench.vue、src/styles/workbench.css；tests/ui/window-consistency.spec.js。

**Interfaces:** AppDialog `{title,panel,busy}`、`close`事件、default/footer slots；业务的invoke及save/run签名保持。

- [x] 先增加tests/ui/window-consistency.spec.js，使用隔离fixture打开10种窗口，检查header/footer可见、正文滚动不移动操作、焦点返回。定向执行原布局失败于缺少统一footer。
- [x] 外壳始终使用desktop-dialog，忙碌时拒绝关闭；焦点过滤实际禁用控件，纳入tabindex控件。

```js
function requestClose() {
  if (!props.busy) emit("close");
}
```

- [x] 所有旧弹窗包裹dialog-body，使用footer slot。复制/重命名/元数据使用form属性关联固定提交；版本下载/恢复放底部，分页留表格旁；分享与移除提供固定取消/关闭和主操作。

```html
<form id="object-mutation" class="dialog-body" @submit.prevent="m.save">
  <label>目标完整 Key<textarea v-model="m.targetKey.value" /></label>
</form>
<template #footer>
  <button type="button" @click="$emit('close')">取消</button>
  <button type="submit" form="object-mutation" class="primary">
    {{ actions[context.kind] }}
  </button>
</template>
```

- [x] 运行 `npm run test:ui -- tests/ui/window-consistency.spec.js -g 'all windows light/false/false/920'`，再跑object-mutations/object-versions现有行为测试。工作保留为可审阅改动。

### Task 2: 主窗口操作层级与异步状态

**Files:** src/components/Workbench.vue、TaskCenter.vue、src/styles/tokens.css、workbench.css；tests/ui/window-consistency.spec.js。

**Interfaces:** 保留tab、m.connection、m.jobs和原有事件；remove/generate增加界面忙碌及错误控制，不修改native协议。

- [x] 定向失败测试证明连接命令当前混入页面工具栏。
- [x] 连接命令移入topbar；资源头新建按钮、页签和任务工具栏采用系列图标/间距；危险命令使用语义色。
- [x] 移除失败保留弹窗与连接，等待时禁止关闭/重复提交。

```js
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
```

- [x] 分享生成禁止重复提交，失败明确展示且新请求清旧错误；关闭仍撤销旧响应。运行 `npm run test:ui -- tests/ui/window-consistency.spec.js -g 'context header'`。

### Task 3: 验收及规范同步

**Files:** tests/ui/window-consistency.spec.js、tests/native/shell-consistency.spec.js、tests/native/window-consistency.spec.js、docs/ui.md，工作区tasks记录。

**Interfaces:** 隔离fixture/生产Electron宿主，不使用真实连接或厂商账号。

- [x] 全部16显示组合打开全部窗口，检查宽窄/普通大字/浅深/侧栏；核验截图、固定操作及焦点。
- [x] 执行 `npm run test:ui`、`npm run test:native -- tests/native/startup.spec.js tests/native/shell-consistency.spec.js`，生产build、明确文件Prettier及diff检查。
- [x] 更新产品规范与工作区任务，记录实际验证和未验平台；刷新现有开发窗口。源码未提交，安装包及发布为独立后续工作。

最终验证：Node130通过/1原跳过、完整UI141及忙碌焦点补验21通过，原生生产2项及全窗IPC外观1项通过；Vite构建/格式/diff通过。原生新测试补首屏就绪等待，关于图片测试补异步加载等待。详见工作区tasks/2026-10-28-storagelab-window-consistency.md。
