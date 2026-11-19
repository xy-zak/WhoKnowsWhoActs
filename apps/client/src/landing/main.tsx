import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyAppearance, installThemeStyles, playerPrefs } from "../ui";
import { Landing } from "./Landing";

installThemeStyles();
// the participant's own display settings (this browser only, not logged)
applyAppearance(playerPrefs.store.get());
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Landing />
  </StrictMode>,
);
