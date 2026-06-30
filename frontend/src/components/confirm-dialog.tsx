import { createContext, useCallback, useContext, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface ConfirmOptions {
  title?: string;
  description: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  /** destructive 时确认按钮为红色，用于删除等不可撤销操作。 */
  variant?: "default" | "destructive";
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

/**
 * 应用内统一的二次确认对话框，替代原生 ``window.confirm``。
 *
 * 在根部挂一次 :func:`ConfirmProvider`，组件内用 ``const confirm = useConfirm()``，
 * 以 ``await confirm({ description, ... })`` 取得用户是否确认（Promise<boolean>）。
 */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<{ open: boolean; opts: ConfirmOptions }>({
    open: false,
    opts: { description: "" },
  });
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((opts) => {
    setState({ open: true, opts });
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const close = useCallback((result: boolean) => {
    setState((s) => ({ ...s, open: false }));
    resolver.current?.(result);
    resolver.current = null;
  }, []);

  const { opts } = state;
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog open={state.open} onOpenChange={(v) => !v && close(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{opts.title ?? "确认操作"}</DialogTitle>
            <DialogDescription className="whitespace-pre-line leading-relaxed">
              {opts.description}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => close(false)}>
              {opts.cancelText ?? "取消"}
            </Button>
            <Button
              variant={opts.variant === "destructive" ? "destructive" : "default"}
              onClick={() => close(true)}
              autoFocus
            >
              {opts.confirmText ?? "确认"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm 必须在 ConfirmProvider 内使用");
  return ctx;
}
