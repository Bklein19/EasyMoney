export type DesktopTrpcOperationType = 'query' | 'mutation';

export interface DesktopTrpcRequest {
  path: string;
  type: DesktopTrpcOperationType;
  input: unknown;
}

export type DesktopTrpcResponse =
  | { ok: true; data: unknown }
  | { ok: false; error: unknown };

export type EasyMoneyDesktopRpc = {
  bun: {
    requests: {
      trpc: {
        params: DesktopTrpcRequest;
        response: DesktopTrpcResponse;
      };
    };
    messages: {};
  };
  webview: {
    requests: {};
    messages: {};
  };
};
