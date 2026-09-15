import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/app/App";
import { waitForOffice } from "@/office/env";

async function bootstrap() {
  await waitForOffice();
  const root = document.getElementById("root");
  if (!root) throw new Error("#root missing");
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
