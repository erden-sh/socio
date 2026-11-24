import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { installPluginBridge } from '@socio/plugin-ui';

import '../../globals.css';

import './planner.css';
import { readInitialState } from './api';
import { App } from './App';

installPluginBridge();

const root = document.getElementById('root');
if (root) {
    createRoot(root).render(
        <StrictMode>
            <App initial={readInitialState()} />
        </StrictMode>,
    );
}
