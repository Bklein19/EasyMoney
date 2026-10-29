export type CategoryWorkspaceView = 'review' | 'browse' | 'manage';
export function categoryWorkspaceView(params: URLSearchParams): CategoryWorkspaceView {
  const view = params.get('view');
  return view === 'browse' || view === 'manage'
    ? view
    : params.has('group') && !view
      ? 'browse'
      : 'review';
}
