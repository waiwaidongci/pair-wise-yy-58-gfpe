import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { Quasar } from 'quasar';
import 'quasar/src/css/index.sass';
import '@quasar/extras/material-icons/material-icons.css';
import router from './router';
import App from './App.vue';
import './styles.css';

createApp(App).use(createPinia()).use(router).use(Quasar).mount('#app');
