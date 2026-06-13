import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { AuthProvider } from './auth.js';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('missing #root element');
createRoot(container).render(
  <React.StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </React.StrictMode>,
);
