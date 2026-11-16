import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyAppearance, ConfirmProvider, facilitatorPrefs, installThemeStyles } from "../ui";
import { App } from "./App";
import { FacilitatorConnection } from "./connection";

installThemeStyles();
applyAppearance(facilitatorPrefs.store.get());
const conn = new FacilitatorConnection();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConfirmProvider>
      <App conn={conn} />
    </ConfirmProvider>
  </StrictMode>,
);
