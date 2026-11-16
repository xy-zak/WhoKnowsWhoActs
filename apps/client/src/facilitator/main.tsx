import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../common/styles.css";
import { App } from "./App";
import { FacilitatorConnection } from "./connection";

const conn = new FacilitatorConnection();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App conn={conn} />
  </StrictMode>,
);
