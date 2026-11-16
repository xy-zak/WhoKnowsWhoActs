import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyAppearance, installThemeStyles, playerPrefs } from "../ui";
import { App } from "./App";
import { PlayerConnection } from "./connection";

installThemeStyles();
// the participant's own display settings (this browser only, not logged)
applyAppearance(playerPrefs.store.get());
const conn = new PlayerConnection();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App conn={conn} />
  </StrictMode>,
);
