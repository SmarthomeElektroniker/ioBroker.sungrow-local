// development harness only (npm start / smoke test) - not part of the admin build
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

const container = document.getElementById('root');
if (container) {
    createRoot(container).render(<App />);
}
