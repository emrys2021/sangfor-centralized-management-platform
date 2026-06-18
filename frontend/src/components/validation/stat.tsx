import { Card, CardContent } from "@/components/ui/card";

export function Stat({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={`mt-1 text-2xl font-bold ${color ?? ""}`}>{value}</div>
      </CardContent>
    </Card>
  );
}
