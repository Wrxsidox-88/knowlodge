import { reactive } from 'vue';

/**
 * 全局 WinUI 对话框（WinContentDialog）工具。
 * 统一替换浏览器原生 alert / confirm / prompt：
 *   - winConfirm(...)  =>  Promise<boolean>
 *   - winAlert(...)    =>  Promise<void>
 *   - winPrompt(...)   =>  Promise<string | null>（确定返回输入值；取消返回 null）
 *
 * 状态由 App.vue 中挂载的 <WinContentDialog> 渲染。
 */
export const dialogState = reactive({
  open: false,
  kind: '',        // 'confirm' | 'alert' | 'prompt'
  title: '',
  message: '',
  primary: '',
  secondary: '',
  close: '',
  defaultButton: 'None',
  danger: false,
  inputLabel: '',
  inputValue: '',
  _resolve: null
});

function open(opts) {
  // 兜底：若已有对话框打开（叠加请求），先以取消结果结束旧的
  if (dialogState.open) {
    const old = dialogState._resolve;
    dialogState._resolve = null;
    dialogState.open = false;
    old?.(null);
  }
  Object.assign(dialogState, opts, { open: true });
}

/** 由 App.vue 的对话框按钮事件调用：result = 'primary' | 'secondary' | 'close' */
export function settleDialog(result) {
  if (!dialogState.open) return;
  const resolve = dialogState._resolve;
  const kind = dialogState.kind;
  const inputValue = dialogState.inputValue;
  dialogState._resolve = null;
  dialogState.open = false;

  if (!resolve) return;
  if (result === 'primary') {
    if (kind === 'confirm') resolve(true);
    else if (kind === 'prompt') resolve(inputValue);
    else resolve();
  } else {
    // secondary / close / 空
    if (kind === 'prompt') resolve(null);
    else if (kind === 'confirm') resolve(false);
    else resolve();
  }
}

export function winConfirm({ title = '确认操作', message = '', primary = '确定', secondary = '取消', danger = false } = {}) {
  return new Promise((resolve) => {
    open({
      kind: 'confirm', title, message, primary, secondary, close: '',
      defaultButton: 'Primary', danger, inputLabel: '', inputValue: '', _resolve: resolve
    });
  });
}

export function winAlert({ title = '提示', message = '', close = '知道了' } = {}) {
  return new Promise((resolve) => {
    open({
      kind: 'alert', title, message, primary: close, secondary: '', close: '',
      defaultButton: 'Primary', danger: false, inputLabel: '', inputValue: '', _resolve: resolve
    });
  });
}

export function winPrompt({ title = '输入', message = '', inputLabel = '', defaultValue = '', primary = '确定', secondary = '取消' } = {}) {
  return new Promise((resolve) => {
    open({
      kind: 'prompt', title, message, primary, secondary, close: '',
      defaultButton: 'Primary', danger: false, inputLabel,
      inputValue: defaultValue ?? '', _resolve: resolve
    });
  });
}