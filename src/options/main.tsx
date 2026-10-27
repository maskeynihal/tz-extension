import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Options } from './Options';
import '../popup/popup.css';

const el = document.getElementById('root');
if (el) {
  createRoot(el).render(
    <StrictMode>
      <Options />
    </StrictMode>,
  );
}
