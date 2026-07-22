import '../app.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { applyTheme, resolveTheme, getCachedThemePreference } from './theme.js';

// Apply cached theme before mounting to avoid a flash of the wrong color scheme.
// index.html starts with class="dark" as the safe default; this overwrites it
// before any content is rendered.
const cached = await getCachedThemePreference();
applyTheme(resolveTheme(cached ?? 'system'));

mount(App, { target: document.getElementById('app')! });
