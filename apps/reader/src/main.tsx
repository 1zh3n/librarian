import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SpikePage } from "./spike/SpikePage";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Missing Librarian root");
}

createRoot(root).render(
  <StrictMode>
    <SpikePage />
  </StrictMode>,
);
