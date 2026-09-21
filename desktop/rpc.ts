export type DesktopTrpcOperationType = 'query' | 'mutation';

export interface AccountMenuRequest {
  accountId: number;
  name: string;
  institution?: string | null;
  owner?: string | null;
}

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
      showAccountContextMenu: {
        params: AccountMenuRequest;
        response: boolean;
      };
      trpc: {
        params: DesktopTrpcRequest;
        response: DesktopTrpcResponse;
      };
    };
    messages: {};
  };
  webview: {
    requests: {};
    messages: { editAccount: { accountId: number } };
  };
};
