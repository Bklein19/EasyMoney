import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import App from './App';
import { queryClient } from './api/trpc';
import { restoreNavigation } from './navigationHistory';

const root = document.getElementById('root');
if (!root) throw new Error('Missing root element');

void restoreNavigation(window).catch(error => console.error('Could not restore navigation history', error)).then(() => createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
));
