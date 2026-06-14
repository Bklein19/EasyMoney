const listeners = new Set();

export function subscribeToDataChanges(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyDataChanged() {
  for (const listener of listeners) listener();
}

async function request(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options
  });

  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    throw new Error(details.error || `Request failed: ${response.status}`);
  }

  return response.json();
}

export async function appRequest(path, query = {}) {
  const params = new URLSearchParams(
    Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== '')
  );
  const suffix = params.toString() ? `?${params}` : '';
  return request(`/app${path}${suffix}`);
}

export async function list(table, query = {}) {
  const params = new URLSearchParams(
    Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== '')
  );
  const suffix = params.toString() ? `?${params}` : '';
  return request(`/${table}${suffix}`);
}

export async function add(table, row) {
  const result = await request(`/${table}`, {
    method: 'POST',
    body: JSON.stringify(row)
  });
  notifyDataChanged();
  return result.id;
}

export async function bulkAdd(table, rows) {
  const result = await request(`/${table}/bulk`, {
    method: 'POST',
    body: JSON.stringify({ rows })
  });
  notifyDataChanged();
  return result;
}

export async function update(table, id, changes) {
  const result = await request(`/${table}/${id}`, {
    method: 'PUT',
    body: JSON.stringify(changes)
  });
  notifyDataChanged();
  return result;
}

export async function remove(table, id) {
  const result = await request(`/${table}/${id}`, { method: 'DELETE' });
  notifyDataChanged();
  return result;
}

export async function apiAction(path, options = {}) {
  const result = await request(path, options);
  notifyDataChanged();
  return result;
}
