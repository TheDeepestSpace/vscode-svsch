declare global {
  interface Window {
    acquireVsCodeApi?: () => {
      postMessage(message: unknown): void;
    };
  }
}

let vscodeApi: { postMessage(message: unknown): void } | undefined;

export function getVscodeApi() {
  if (!vscodeApi) {
    if (typeof window !== 'undefined') {
      vscodeApi = window.acquireVsCodeApi?.() ?? {
        postMessage: () => {
          // Browser visual tests run the webview outside VS Code and inject messages directly.
        },
      };
    } else {
      vscodeApi = { postMessage: () => {} };
    }
  }
  return vscodeApi;
}
