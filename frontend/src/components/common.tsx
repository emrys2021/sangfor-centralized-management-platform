import { Loader2, Inbox } from "lucide-react";

import { cn } from "@/lib/utils";

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("h-4 w-4 animate-spin", className)} />;
}

export function CenteredSpinner({ label }: { label?: string }) {
  return (
    <div className="flex h-48 flex-col items-center justify-center gap-2 text-muted-foreground">
      <Loader2 className="h-6 w-6 animate-spin" />
      {label && <span className="text-sm">{label}</span>}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex h-48 flex-col items-center justify-center gap-2 text-muted-foreground">
      <Inbox className="h-8 w-8 opacity-50" />
      <div className="text-sm font-medium">{title}</div>
      {hint && <div className="text-xs">{hint}</div>}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-gradient">{title}</h1>
        {description && <p className="mt-1.5 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function JsonView({ data }: { data: unknown }) {
  return (
    <pre className="max-h-[60vh] overflow-auto rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}
