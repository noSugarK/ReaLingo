import { createApp } from "vue";
import App from "./desktop/App.vue";
import MobileApp from "./mobile/MobileApp.vue";
import "./styles/glass.css";

// The phone shell and the desktop window share every module below the view — store, i18n,
// stream, session rules — but not the layout. Android's WebView is detected from the UA
// synchronously, before the first paint, so neither build ever renders the other's chrome
// for a frame. (`platform.ts`'s `loadCaps` confirms from the backend once mounted.)
const mobile = /android/i.test(navigator.userAgent);
createApp(mobile ? MobileApp : App).mount("#app");
