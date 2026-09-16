import { Toast, ToastBody, Toaster, ToastTitle, useId, useToastController } from "@fluentui/react-components";
import { createContext, useContext, useMemo, type ReactNode } from "react";

interface ToastApi {
  success: (msg: string, title?: string) => void;
  error: (msg: string, title?: string) => void;
  info: (msg: string, title?: string) => void;
  warning: (msg: string, title?: string) => void;
}

const noop: ToastApi = { success: () => undefined, error: () => undefined, info: () => undefined, warning: () => undefined };
const ToastContext = createContext<ToastApi>(noop);

export function ToastProvider({ children }: { children: ReactNode }) {
  const toasterId = useId("oao-toaster");
  const { dispatchToast } = useToastController(toasterId);
  const api = useMemo<ToastApi>(() => {
    const show = (intent: "success" | "error" | "info" | "warning") => (msg: string, title?: string) =>
      dispatchToast(
        <Toast>
          {title && <ToastTitle>{title}</ToastTitle>}
          <ToastBody>{msg}</ToastBody>
        </Toast>,
        { intent, timeout: intent === "error" ? 8000 : 4000, position: "bottom" },
      );
    return { success: show("success"), error: show("error"), info: show("info"), warning: show("warning") };
  }, [dispatchToast]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <Toaster toasterId={toasterId} position="bottom" limit={3} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  return useContext(ToastContext);
}
