// @ts-check

import './style.css';
import App from './App.svelte';
import { mount } from 'svelte';

const target = document.getElementById('app');

if (!target) {
  throw new Error('Missing root container "#app"');
}

const app = mount(App, { target });

export default app;
