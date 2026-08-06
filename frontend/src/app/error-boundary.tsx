/**
 * 全局错误边界。
 *
 * 没有它时，渲染期抛出的任何异常都会让 React 卸载整棵树——
 * 用户看到的是一块白屏，既没有说明也没有回到首页的出口。
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 只输出错误本身与组件栈，不带任何照片数据或 KEY（§9.4 字段白名单）
    console.error("[portrait-booth] 渲染失败", error.message, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <section aria-label="页面出错" role="alert">
        <h2>页面出错了</h2>
        <p className="muted">
          这一步没能正常显示。你的照片只存在于本次会话的内存中，不会因为这个错误被上传或保留。
        </p>
        <p className="muted">错误信息：{error.message}</p>
        <div className="step-actions">
          <button type="button" className="primary" onClick={() => this.setState({ error: null })}>
            重试
          </button>
          <button type="button" onClick={() => (window.location.href = "/")}>
            回到首页
          </button>
        </div>
      </section>
    );
  }
}
