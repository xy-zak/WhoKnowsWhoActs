import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConfirmProvider, installThemeStyles, prefsStore } from "../ui";
import { applyAppearance } from "../ui/prefs";
import { App } from "./App";
import { FacilitatorConnection } from "./connection";

installThemeStyles();
applyAppearance(prefsStore.get().theme, prefsStore.get().crt);
const conn = new FacilitatorConnection();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConfirmProvider>
      <App conn={conn} />
    </ConfirmProvider>
  </StrictMode>,
);
