import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/app/App";
import { waitForOffice } from "@/office/env";
import { primeMailboxEvents } from "@/office/events";

async function bootstrap() {
  await waitForOffice();
  // Before React: the item-change handlers must exist from the first moment
  // the pane is alive, and must not depend on any component's lifecycle.
  primeMailboxEvents();
  const root = document.getElementById("root");
  if (!root) throw new Error("#root missing");
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
