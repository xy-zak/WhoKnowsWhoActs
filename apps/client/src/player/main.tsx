import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyAppearance, installThemeStyles } from "../ui";
import { App } from "./App";
import { PlayerConnection } from "./connection";

installThemeStyles();
// until the session says otherwise (appearance is a session setting)
applyAppearance("mocha", true);
const conn = new PlayerConnection();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App conn={conn} />
  </StrictMode>,
);
