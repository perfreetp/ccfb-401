import './styles.css';
import { App } from './ui/App';

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app root');
const app = new App(root);
app.boot();

declare global {
  interface Window {
    __lfrApp?: App;
  }
}

window.__lfrApp = app;
