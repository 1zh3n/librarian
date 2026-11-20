import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Missing Librarian root");
}

const app = createRoot(root);
if (import.meta.env.DEV && window.location.pathname === "/spike") {
  void import("./spike/SpikePage").then(({ SpikePage }) => {
    app.render(
      <StrictMode>
        <SpikePage />
      </StrictMode>,
    );
  });
} else {
  void import("./routes/ReaderApplication").then(({ ReaderApplication }) => {
    app.render(
      <StrictMode>
        <ReaderApplication />
      </StrictMode>,
    );
  });
}
