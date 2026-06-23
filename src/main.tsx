import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import App from './App';
import { queryClient } from './api/trpc';
import { migrateDexieToSqlite } from './db/migrateDexieToSqlite';

migrateDexieToSqlite().finally(() => {
  const root = document.getElementById('root');
  if (!root) throw new Error('Missing root element');

  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  );
});
