# Select 下拉框

按系列统一约定，单选框使用原生 `<select>` 和同一套闭合箭头；选项列表、键盘和焦点交互继续使用原生行为。

- 样式：`src/styles/select-controls.css`，由 `src/main.js` 加载。
- 普通箭头画布16px、大字18px，右距8px、垂直居中，文字右侧留白32px/34px；浅色/深色随实际主题切换。
- 局部背景/内边距不可移除箭头或挤占文字空间；高度、边框、底色与焦点保留产品语义样式。
- `multiple` 和多行 `size` 不画单选箭头；强制颜色模式恢复系统指示器。普通单选原生禁用、键盘选择行为保留。
- 维护源：[系列 Select CSS](../../ai-workspace/ineed-tools/docs/ui/select-controls.css)，规则：[系列 UI 规范](../../ai-workspace/ineed-tools/docs/TOOL-UI.md)。修改后同步四款产品副本；不建立跨仓库源码软链接。

验收覆盖浅深/系统主题、普通大字、侧栏展开折叠、宽窄窗口、文本与箭头留白及键盘选择；浏览器与真实桌面、安装包分别记录。本次详细证据见工作区 `tasks/2026-10-28-tools-select-consistency.md`。
