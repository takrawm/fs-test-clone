import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import reportWebVitals from "./reportWebVitals";

// 開発時、ResizeObserver のノイズを黙らせる
if (process.env.NODE_ENV === "development") {
  const muteRO = (e: ErrorEvent) => {
    const msg = e.message || "";
    if (
      msg.includes("ResizeObserver loop limit exceeded") ||
      msg.includes(
        "ResizeObserver loop completed with undelivered notifications"
      )
    ) {
      e.stopImmediatePropagation();
      // e.preventDefault(); // 必要なら
    }
  };
  window.addEventListener("error", muteRO);
}

const root = ReactDOM.createRoot(
  document.getElementById("root") as HTMLElement
);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();
