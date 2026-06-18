import { ServerOff } from "lucide-react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";

export function NoInstance() {
  return (
    <div className="flex h-[60vh] flex-col items-center justify-center gap-3 text-muted-foreground">
      <ServerOff className="h-10 w-10 opacity-50" />
      <div className="text-sm">请先在顶部选择一个实例</div>
      <Button variant="outline" asChild>
        <Link to="/instances">前往实例管理</Link>
      </Button>
    </div>
  );
}
